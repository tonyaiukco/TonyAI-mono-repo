import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import { NotFoundException } from '@nestjs/common';
import { ActivityTypeSlotConflictError, recordTriggerCode } from '../../src/activity-records/errors';
import { CalculationsService } from '../../src/calculations/calculations.service';
import { NoEmissionFactorError } from '../../src/calculations/errors';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  backendPid,
  connect,
  connectLoader,
  connectOwner,
  createRecord,
  createTenant,
  deferred,
  recordInput,
  refusal,
  serviceRest,
  settledOrBlocked,
  withRollback,
  type Tenant,
} from './db';
import { INT_FACTOR_POLICY, lifecycleServices } from './services';
import { checkTenantInvariants, factorLibraryReport } from '../../../../packages/db/scripts/runtime-role.mjs';

/**
 * LP3-03 PR B against real PostgreSQL: the K5 snapshot trigger, the slot-kind
 * trigger and its lock, the append-only factor library, and the engine reading
 * the seed's placeholder library — on the runtime role the API uses, and on
 * the owner where the rule must hold for every writer.
 */

let runtime: PrismaService;
let owner: PrismaService;
let tenant: Tenant;
let foreign: Tenant;

beforeAll(async () => {
  runtime = connect(2);
  owner = connectOwner(2);
  tenant = await createTenant();
  foreign = await createTenant();
});

afterAll(async () => {
  await tenant?.cleanup();
  await foreign?.cleanup();
  await runtime?.$disconnect();
  await owner?.$disconnect();
});

/** The settled rejection of `p`, or null if it resolved. */
async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

/** The SQLSTATE behind a Prisma error: a raw query's P2010 `meta.code`, or the code in an unknown request error's text. */
function sqlstateOf(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return (e.meta as { code?: string } | undefined)?.code ?? e.code;
  }
  return /code: "([0-9A-Z]{5})"/.exec(String((e as Error | null)?.message))?.[1] ?? null;
}

/** A delete a foreign key refused: Prisma's P2003, or a raw query's SQLSTATE 23503. */
const FK_REFUSED = ['P2003', '23503'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let slot = 0;
/** A fresh monthly slot of the tenant, so no two records here share one (a year back every twelve). */
const nextSlot = () => {
  const i = slot++;
  return { reportingYear: 2026 - Math.floor(i / 12), reportingPeriod: 'monthly', periodValue: MONTHS[i % 12] };
};

const FIXTURE_PUBLISHER = 'TonyAI test fixture';

/** The fixture publisher's next free ordinal. */
async function nextFixtureOrdinal(client: Prisma.TransactionClient | PrismaService): Promise<number> {
  const [{ next }] = await client.$queryRawUnsafe<{ next: number }[]>(
    `SELECT COALESCE(max(ordinal), 0) + 1 AS next FROM factor_releases WHERE publisher = '${FIXTURE_PUBLISHER}'`,
  );
  return Number(next);
}

type FactorRow = Omit<Prisma.EmissionFactorUncheckedCreateInput, 'releaseId' | 'version'>;
type ConversionRow = Omit<Prisma.UnitConversionUncheckedCreateInput, 'releaseId'>;

/**
 * A fixture release loaded whole, as the owner, in one committed transaction —
 * the release, its rows, its seal (LP4-02: a release is sealed in the
 * transaction that loads it, and a sealed one takes no row). Fixture rows and
 * releases are the deletable ones: `removeFixture` in a `finally`.
 */
async function loadFixture(rows: { factors?: FactorRow[]; conversions?: ConversionRow[] }) {
  return owner.$transaction(async (tx) => {
    const release = await tx.factorRelease.create({
      data: { publisher: FIXTURE_PUBLISHER, title: 'Int test', edition: `int-${randomUUID()}`, ordinal: await nextFixtureOrdinal(tx), status: 'fixture' },
    });
    const factors = (rows.factors ?? []).map((f) => ({ ...f, releaseId: release.id, version: release.edition }));
    if (factors.length > 0) await tx.emissionFactor.createMany({ data: factors });
    const conversions = (rows.conversions ?? []).map((c) => ({ ...c, releaseId: release.id }));
    if (conversions.length > 0) await tx.unitConversion.createMany({ data: conversions });
    return tx.factorRelease.update({ where: { id: release.id }, data: { sealedAt: new Date() } });
  });
}

async function removeFixture(releaseId: string) {
  await owner.unitConversion.deleteMany({ where: { releaseId } });
  await owner.emissionFactor.deleteMany({ where: { releaseId } });
  await owner.factorRelease.deleteMany({ where: { id: releaseId } });
}

describe('K5 — a snapshot that has left draft never changes', () => {
  it.each([
    ActivityRecordStatus.submitted,
    ActivityRecordStatus.approved,
    ActivityRecordStatus.locked,
    ActivityRecordStatus.voided,
  ])('refuses the runtime role and the owner on a %s record — the snapshot and its inputs', async (status) => {
    const rec = await createRecord(owner, tenant, { ...nextSlot(), status });
    for (const client of [runtime, owner]) {
      for (const data of [
        { calculation: { tCo2e: 999, factorId: 'forged' } },
        { activityValue: 1 },
        { activityUnit: 'MWh' },
        { category: 'Natural Gas' },
        { activityType: 'diesel' },
        { reportingYear: 2025 },
        { scope: 1 },
        { reportingPeriod: 'quarterly' },
        { periodValue: 'December' },
        { subsidiary: { connect: { id: foreign.subsidiaryId } } },
      ] as Prisma.ActivityRecordUpdateInput[]) {
        const e = await failure(client.activityRecord.update({ where: { id: rec.id }, data }));
        expect(sqlstateOf(e), JSON.stringify(data)).toBe('TA001');
        // The service's own mapping reads the real error, not a fixture of it.
        expect(recordTriggerCode(e)).toBe('TA001');
      }
    }
    // What the lifecycle legitimately writes on such a row still lands.
    await runtime.activityRecord.update({
      where: { id: rec.id },
      data: { anomalyFlag: true, anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: 1.5 },
    });
  });

  it('lets draft and rejected records be recalculated, and status-only transitions through', async () => {
    for (const status of [ActivityRecordStatus.draft, ActivityRecordStatus.rejected]) {
      const rec = await createRecord(owner, tenant, { ...nextSlot(), status });
      await runtime.activityRecord.update({
        where: { id: rec.id },
        data: { activityValue: 5, calculation: { tCo2e: 1, factorId: 'recomputed' } },
      });
    }
    const approved = await createRecord(owner, tenant, { ...nextSlot(), status: ActivityRecordStatus.approved });
    // The period lock's bulk lock and unlock, then a void — status only.
    await runtime.activityRecord.updateMany({ where: { id: approved.id }, data: { status: ActivityRecordStatus.locked } });
    await runtime.activityRecord.updateMany({ where: { id: approved.id }, data: { status: ActivityRecordStatus.approved } });
    await runtime.activityRecord.update({
      where: { id: approved.id },
      data: { status: ActivityRecordStatus.voided, voidReason: 'int test', voidedBy: tenant.users.superAdmin.id, voidedAt: new Date() },
    });
  });

  it("refuses re-pointing or detaching an approved record's site — the owner included — and keeps a site that holds it (LP4-01)", async () => {
    const [siteA, siteB] = await Promise.all(
      ['A', 'B'].map((n) => owner.location.create({ data: { subsidiaryId: tenant.subsidiaryId, name: `Int-test K5 site ${n}`, geographyCode: 'UK' } })),
    );
    const rec = await createRecord(owner, tenant, { ...nextSlot(), locationId: siteA.id, status: ActivityRecordStatus.approved });
    try {
      expect(sqlstateOf(await failure(runtime.activityRecord.update({ where: { id: rec.id }, data: { locationId: siteB.id } })))).toBe('TA001');
      expect(sqlstateOf(await failure(runtime.activityRecord.update({ where: { id: rec.id }, data: { locationId: null } })))).toBe('TA001');
      // The exemption K5 had for the site key's ON DELETE SET NULL (an action
      // runs as the owner) is gone with the action itself.
      expect(sqlstateOf(await failure(withRollback(owner, (tx) => tx.activityRecord.update({ where: { id: rec.id }, data: { locationId: null } }))))).toBe('TA001');
      // The site's key is RESTRICT: deleting it no longer re-files the record
      // at company level — refused to the runtime role and to the owner.
      expect(FK_REFUSED).toContain(sqlstateOf(await failure(withRollback(runtime, (tx) => tx.location.delete({ where: { id: siteA.id } })))));
      expect(FK_REFUSED).toContain(sqlstateOf(await failure(withRollback(owner, (tx) => tx.location.delete({ where: { id: siteA.id } })))));
      expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: rec.id } })).locationId).toBe(siteA.id);
    } finally {
      // Teardown order since LP4-01: the record, then its site.
      await owner.activityRecord.delete({ where: { id: rec.id } });
      await owner.location.deleteMany({ where: { id: { in: [siteA.id, siteB.id] } } });
    }
  });
});

describe('K5 — a status changes only by a step of the review lifecycle', () => {
  const STATUSES = Object.values(ActivityRecordStatus);
  // The API's gates: submit, startReview, approve, reject, void, and the
  // period lock's bulk lock and unlock (record-triggers.spec pins the list).
  const ALLOWED = new Set([
    'draft>submitted', 'rejected>submitted', 'submitted>under_review',
    'submitted>approved', 'under_review>approved', 'submitted>rejected', 'under_review>rejected',
    'approved>voided', 'approved>locked', 'locked>approved',
  ]);
  const pairs = STATUSES.flatMap((from) => STATUSES.filter((to) => to !== from).map((to) => [from, to] as const));

  it.each(pairs)('%s → %s', async (from, to) => {
    const rec = await createRecord(owner, tenant, { ...nextSlot(), status: from });
    const outcome = await failure(runtime.activityRecord.update({ where: { id: rec.id }, data: { status: to } }));
    if (ALLOWED.has(`${from}>${to}`)) expect(outcome).toBeNull();
    else expect(sqlstateOf(outcome)).toBe('TA001');
  });

  it('tests OLD, not NEW: rejecting and rewriting in ONE statement is refused', async () => {
    // submitted → rejected is a lifecycle step; the rewrite in the same
    // statement is not, because the record was submitted when it began.
    const rec = await createRecord(owner, tenant, { ...nextSlot(), status: ActivityRecordStatus.submitted });
    for (const client of [runtime, owner]) {
      const e = await failure(
        client.activityRecord.update({
          where: { id: rec.id },
          data: { status: ActivityRecordStatus.rejected, activityValue: 1, calculation: { tCo2e: 0, factorId: 'forged' } },
        }),
      );
      expect(sqlstateOf(e)).toBe('TA001');
    }
  });

  it('refuses the whole walk: approved → submitted → rejected → edit → submitted → approved', async () => {
    const rec = await createRecord(owner, tenant, { ...nextSlot(), status: ActivityRecordStatus.approved });
    expect(
      sqlstateOf(await failure(owner.activityRecord.update({ where: { id: rec.id }, data: { status: ActivityRecordStatus.submitted } }))),
    ).toBe('TA001');
    const after = await owner.activityRecord.findUniqueOrThrow({ where: { id: rec.id } });
    expect(after.status).toBe(ActivityRecordStatus.approved);
    expect(after.activityValue).toBe(rec.activityValue);
  });

  it('lets every lifecycle step through, status only', async () => {
    const rec = await createRecord(owner, tenant, { ...nextSlot(), status: ActivityRecordStatus.draft });
    for (const status of [
      ActivityRecordStatus.submitted, ActivityRecordStatus.under_review, ActivityRecordStatus.rejected,
      ActivityRecordStatus.submitted, ActivityRecordStatus.approved, ActivityRecordStatus.locked,
      ActivityRecordStatus.approved, ActivityRecordStatus.voided,
    ]) {
      await runtime.activityRecord.update({ where: { id: rec.id }, data: { status } });
    }
  });

  it('lets review send a submitted or under_review record back as rejected', async () => {
    for (const from of [ActivityRecordStatus.submitted, ActivityRecordStatus.under_review]) {
      const rec = await createRecord(owner, tenant, { ...nextSlot(), status: from });
      await runtime.activityRecord.update({ where: { id: rec.id }, data: { status: ActivityRecordStatus.rejected } });
    }
  });
});

describe('K5 — a committed record is never deleted on its own', () => {
  it.each([
    ActivityRecordStatus.submitted,
    ActivityRecordStatus.under_review,
    ActivityRecordStatus.approved,
    ActivityRecordStatus.locked,
    ActivityRecordStatus.voided,
  ])('refuses deleting a %s record to the runtime role and the service role — no delete-and-reinsert rewrite', async (status) => {
    const rec = await createRecord(owner, tenant, { ...nextSlot(), status });
    expect(sqlstateOf(await failure(runtime.activityRecord.delete({ where: { id: rec.id } })))).toBe('TA001');
    const asService = await failure(
      withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
        await tx.$executeRawUnsafe(`DELETE FROM activity_records WHERE id = '${rec.id}'`);
      }),
    );
    expect(sqlstateOf(asService)).toBe('TA001');
  });

  it('lets a draft or rejected record go and the owner (teardown) delete any — but no subsidiary delete takes records with it (LP4-01)', async () => {
    for (const status of [ActivityRecordStatus.draft, ActivityRecordStatus.rejected]) {
      const rec = await createRecord(owner, tenant, { ...nextSlot(), status });
      await runtime.activityRecord.delete({ where: { id: rec.id } });
    }
    const approved = await createRecord(owner, tenant, { ...nextSlot(), status: ActivityRecordStatus.approved });
    await withRollback(owner, (tx) => tx.activityRecord.delete({ where: { id: approved.id } }));
    // A foreign key's action runs as the table's owner, past this trigger —
    // so the record's subsidiary key is RESTRICT: deleting the subsidiary is
    // refused while it holds a record, to the runtime role and to the owner
    // alike (before LP4-01 both took the approved record with it).
    expect(FK_REFUSED).toContain(sqlstateOf(await failure(withRollback(runtime, (tx) => tx.subsidiary.delete({ where: { id: tenant.subsidiaryId } })))));
    expect(FK_REFUSED).toContain(sqlstateOf(await failure(withRollback(owner, (tx) => tx.subsidiary.delete({ where: { id: tenant.subsidiaryId } })))));
    expect(await owner.activityRecord.count({ where: { id: approved.id } })).toBe(1);
  });
});

describe('K5 — trigger depth is no proof of a cascade, and an id never changes', () => {
  // A trigger on a temporary table of the caller's own raises
  // pg_trigger_depth() — every role holds TEMP. The guards test the owner.
  const fromOwnTrigger = async (tx: Prisma.TransactionClient, statement: string, id: string) => {
    await tx.$executeRawUnsafe('CREATE TEMP TABLE int_spoof (id uuid) ON COMMIT DROP');
    await tx.$executeRawUnsafe(
      `CREATE FUNCTION pg_temp.int_spoof() RETURNS trigger LANGUAGE plpgsql AS $f$BEGIN ${statement}; RETURN NEW; END$f$`,
    );
    await tx.$executeRawUnsafe('CREATE TRIGGER int_spoof AFTER INSERT ON int_spoof FOR EACH ROW EXECUTE FUNCTION pg_temp.int_spoof()');
    await tx.$executeRawUnsafe(`INSERT INTO int_spoof VALUES ('${id}')`);
  };

  it.each([
    ['deleting', 'DELETE FROM public.activity_records WHERE id = NEW.id'],
    ['detaching the site of', 'UPDATE public.activity_records SET location_id = NULL WHERE id = NEW.id'],
  ])('refuses %s a committed record from inside a trigger of the caller\'s own — runtime role and service role', async (_, statement) => {
    const site = await owner.location.create({ data: { subsidiaryId: tenant.subsidiaryId, name: `Int-test depth site ${randomUUID().slice(0, 6)}`, geographyCode: 'UK' } });
    const rec = await createRecord(owner, tenant, { ...nextSlot(), locationId: site.id, status: ActivityRecordStatus.approved });
    try {
      expect(sqlstateOf(await failure(withRollback(runtime, (tx) => fromOwnTrigger(tx, statement, rec.id))))).toBe('TA001');
      const asService = await failure(
        withRollback(owner, async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
          await fromOwnTrigger(tx, statement, rec.id);
        }),
      );
      expect(sqlstateOf(asService)).toBe('TA001');
      expect(await owner.activityRecord.findUniqueOrThrow({ where: { id: rec.id } })).toMatchObject({ locationId: site.id });
    } finally {
      await owner.activityRecord.delete({ where: { id: rec.id } });
      await owner.location.delete({ where: { id: site.id } });
    }
  });

  // Supabase's default privileges grant all three API roles every table verb
  // on `public` (CI, staging, production; a local reset drops them).
  it.each(['service_role', 'authenticated', 'anon'])('refuses %s a trigger on any table a cascade reaches — it would fire as the owner', async (role) => {
    for (const table of ['locations', 'subsidiaries', 'organisations', 'evidence', 'activity_record_evidence']) {
      const e = await failure(
        withRollback(owner, async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          await tx.$executeRawUnsafe(`CREATE FUNCTION pg_temp.int_escalate() RETURNS trigger LANGUAGE plpgsql AS $f$BEGIN RETURN OLD; END$f$`);
          await tx.$executeRawUnsafe(`CREATE TRIGGER int_escalate BEFORE DELETE ON public.${table} FOR EACH ROW EXECUTE FUNCTION pg_temp.int_escalate()`);
        }),
      );
      expect(sqlstateOf(e), table).toBe('42501');
    }
  });

  it.each([ActivityRecordStatus.draft, ActivityRecordStatus.approved, ActivityRecordStatus.voided])(
    'refuses changing the id of a %s record — to the runtime role and the owner',
    async (status) => {
      const rec = await createRecord(owner, tenant, { ...nextSlot(), status });
      for (const client of [runtime, owner]) {
        const e = await failure(client.$executeRawUnsafe(`UPDATE activity_records SET id = gen_random_uuid() WHERE id = '${rec.id}'`));
        expect(sqlstateOf(e)).toBe('TA001');
      }
    },
  );
});

describe('a slot holds typed records or one untyped record, never both', () => {
  it('refuses a record written under REPEATABLE READ or SERIALIZABLE, which could not see the slot\'s other kind (TA003)', async () => {
    for (const isolationLevel of ['RepeatableRead', 'Serializable'] as const) {
      const e = await failure(
        owner.$transaction(
          (tx) => createRecord(tx as unknown as PrismaService, tenant, { ...nextSlot(), category: 'Fuel', scope: 1, activityUnit: 'litres', activityType: 'diesel' }),
          { isolationLevel },
        ),
      );
      expect(sqlstateOf(e), isolationLevel).toBe('TA003');
    }
  });

  it('refuses a draft moved to another slot or to the other kind under a stricter isolation level — and lets a same-slot edit or a status step through', async () => {
    const diesel = { category: 'Fuel', scope: 1, activityUnit: 'litres', activityType: 'diesel' };
    const typedDraft = await createRecord(owner, tenant, { ...nextSlot(), ...diesel });
    const untypedDraft = await createRecord(owner, tenant, { ...nextSlot(), ...diesel, activityType: null });
    const approved = await createRecord(owner, tenant, { ...nextSlot(), ...diesel, status: ActivityRecordStatus.approved });
    // Each control runs in a transaction that throws at its end, so nothing it
    // wrote is kept; anything else it throws is the failure.
    const sentinel = new Error('rolled back on purpose');
    const under = async (isolationLevel: 'RepeatableRead' | 'Serializable', write: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      const e = await failure(
        owner.$transaction(async (tx) => {
          await write(tx);
          throw sentinel;
        }, { isolationLevel }),
      );
      return e === sentinel ? null : sqlstateOf(e);
    };
    for (const isolationLevel of ['RepeatableRead', 'Serializable'] as const) {
      expect(await under(isolationLevel, (tx) => tx.activityRecord.update({ where: { id: typedDraft.id }, data: nextSlot() })), `${isolationLevel} slot move`).toBe('TA003');
      expect(await under(isolationLevel, (tx) => tx.activityRecord.update({ where: { id: typedDraft.id }, data: { activityType: null } })), `${isolationLevel} typed → untyped`).toBe('TA003');
      expect(await under(isolationLevel, (tx) => tx.activityRecord.update({ where: { id: untypedDraft.id }, data: { activityType: 'diesel' } })), `${isolationLevel} untyped → typed`).toBe('TA003');
      // Same slot, same kind: no slot question to answer, so any level will do.
      expect(await under(isolationLevel, (tx) => tx.activityRecord.update({ where: { id: typedDraft.id }, data: { activityValue: 250 } })), `${isolationLevel} same-slot edit`).toBeNull();
      expect(await under(isolationLevel, (tx) => tx.activityRecord.update({ where: { id: approved.id }, data: { status: ActivityRecordStatus.locked } })), `${isolationLevel} status step`).toBeNull();
    }
  });

  const fuel = { category: 'Fuel', scope: 1, activityUnit: 'litres' };

  it('refuses either order, for the runtime role and the owner, while two types share a slot', async () => {
    const untypedFirst = nextSlot();
    await createRecord(owner, tenant, { ...untypedFirst, ...fuel });
    for (const client of [runtime, owner]) {
      expect(sqlstateOf(await failure(createRecord(client, tenant, { ...untypedFirst, ...fuel, activityType: 'diesel' })))).toBe('TA002');
    }

    const typedFirst = nextSlot();
    await createRecord(owner, tenant, { ...typedFirst, ...fuel, activityType: 'diesel' });
    await createRecord(runtime, tenant, { ...typedFirst, ...fuel, activityType: 'gas_oil' });
    expect(sqlstateOf(await failure(createRecord(runtime, tenant, { ...typedFirst, ...fuel })))).toBe('TA002');
    // Moving an untyped record INTO the slot is the same refusal.
    const elsewhere = await createRecord(owner, tenant, { ...nextSlot(), ...fuel });
    expect(
      sqlstateOf(await failure(runtime.activityRecord.update({ where: { id: elsewhere.id }, data: { reportingYear: typedFirst.reportingYear, periodValue: typedFirst.periodValue } }))),
    ).toBe('TA002');
  });

  it.each([
    ['its year', (target: ReturnType<typeof nextSlot>) => ({ reportingYear: target.reportingYear })],
    ['its location (a site record re-filed at company level)', () => ({ locationId: null })],
    ['its category', () => ({ category: 'Fuel' })],
  ])('refuses moving a typed record into an untyped slot by %s', async (_how, move) => {
    const target = nextSlot();
    await createRecord(owner, tenant, { ...target, ...fuel });
    const site = await owner.location.create({ data: { subsidiaryId: tenant.subsidiaryId, name: `Int-test slot site ${randomUUID().slice(0, 6)}`, geographyCode: 'UK' } });
    try {
      // Same period as the target; it differs by exactly the column being moved.
      const differs = move(target) as Record<string, unknown>;
      const typed = await createRecord(owner, tenant, {
        ...target,
        ...fuel,
        activityType: 'diesel',
        ...('reportingYear' in differs ? { reportingYear: target.reportingYear - 10 } : {}),
        ...('locationId' in differs ? { locationId: site.id } : {}),
        ...('category' in differs ? { category: 'Mobile Combustion' } : {}),
      });
      expect(sqlstateOf(await failure(runtime.activityRecord.update({ where: { id: typed.id }, data: differs })))).toBe('TA002');
    } finally {
      await owner.activityRecord.deleteMany({ where: { locationId: site.id } });
      await owner.location.delete({ where: { id: site.id } });
    }
  });

  it('refuses a record changing kind in place, and un-voiding into a mixed slot', async () => {
    const slot = nextSlot();
    await createRecord(owner, tenant, { ...slot, ...fuel, activityType: 'diesel' });
    const gasOil = await createRecord(owner, tenant, { ...slot, ...fuel, activityType: 'gas_oil' });
    // gas oil → untyped would leave diesel beside an untyped record.
    expect(sqlstateOf(await failure(runtime.activityRecord.update({ where: { id: gasOil.id }, data: { activityType: null } })))).toBe('TA002');
    // A restore's state, which no lifecycle reaches (its draft would be refused
    // in this slot): only the owner inserts a record in a committed status.
    const voided = await owner.activityRecord.create({ data: recordInput(tenant, { ...slot, ...fuel, status: ActivityRecordStatus.voided }) });
    expect(
      sqlstateOf(await failure(owner.activityRecord.update({ where: { id: voided.id }, data: { status: ActivityRecordStatus.submitted } }))),
    ).toBe('TA002');
  });

  it('frees the slot when the other kind is voided', async () => {
    const slot = nextSlot();
    const legacy = await createRecord(owner, tenant, { ...slot, ...fuel, status: ActivityRecordStatus.voided });
    await createRecord(runtime, tenant, { ...slot, ...fuel, activityType: 'diesel' });
    expect(legacy.status).toBe(ActivityRecordStatus.voided);
  });

  it('serialises a concurrent typed and untyped insert: the second waits on the slot lock, then is refused', async () => {
    const slot = nextSlot();
    const a = connect(1);
    const b = connect(1);
    const observer = connectOwner(1);
    try {
      const inserted = deferred();
      const commit = deferred();
      const txA = a.$transaction(async (tx) => {
        await tx.activityRecord.create({
          data: {
            subsidiaryId: tenant.subsidiaryId, ...slot, ...fuel, activityType: 'diesel', activityValue: 1,
            calculation: { tCo2e: 0, factorId: 'int' }, createdBy: tenant.users.dataEntry.id,
          },
        });
        inserted.resolve();
        await commit.promise;
      });
      await inserted.promise;
      const pidB = await backendPid(b);
      const insertB = createRecord(b, tenant, { ...slot, ...fuel });
      // Without the advisory lock nothing would hold B: the unique index sees
      // NULL and 'diesel' as different keys, and B's check cannot see A's
      // uncommitted row.
      expect(await settledOrBlocked(insertB, pidB, observer)).toBe('blocked');
      commit.resolve();
      await txA;
      expect(sqlstateOf(await failure(insertB))).toBe('TA002');
    } finally {
      await Promise.all([a.$disconnect(), b.$disconnect(), observer.$disconnect()]);
    }
  });

  it('is answered by the record service with a 409 that names the problem', async () => {
    // 2026, where the placeholder library prices diesel, so the service gets as
    // far as the write; quarterly, a slot no other spec here uses.
    const slot = { reportingYear: 2026, reportingPeriod: 'quarterly', periodValue: 'Q4' };
    await createRecord(owner, tenant, { ...slot, ...fuel });
    const { records } = lifecycleServices(runtime);
    const e = await failure(
      records.create(tenant.users.dataEntry, {
        subsidiaryId: tenant.subsidiaryId,
        reportingYear: 2026,
        reportingPeriod: 'quarterly',
        periodValue: slot.periodValue,
        category: 'Fuel',
        activityType: 'diesel',
        activityValue: 10,
        activityUnit: 'litres',
      }),
    );
    expect(e).toBeInstanceOf(ActivityTypeSlotConflictError);
  });

  it('saves a PATCHed type, and answers an update into a mixed slot with the same 409', async () => {
    const { records } = lifecycleServices(runtime);
    const dto = {
      subsidiaryId: tenant.subsidiaryId,
      reportingYear: 2026,
      reportingPeriod: 'quarterly' as const,
      category: 'Fuel' as const,
      activityValue: 10,
      activityUnit: 'litres',
    };
    // Its own slots: Q3 for the diesel record, Q2 holding an untyped one.
    await createRecord(owner, tenant, { reportingYear: 2026, reportingPeriod: 'quarterly', periodValue: 'Q2', ...fuel });
    const created = await records.create(tenant.users.dataEntry, { ...dto, periodValue: 'Q3', activityType: 'diesel' });
    // gas oil has no placeholder factor: the PATCH is refused by the engine,
    // and the column must not move.
    expect(await failure(records.update(tenant.users.dataEntry, created.id, { activityType: 'gas_oil' }))).toMatchObject({ code: 'no_factor' });
    expect((await owner.activityRecord.findUniqueOrThrow({ where: { id: created.id } })).activityType).toBe('diesel');
    // Moving it into Q2, which holds an untyped Fuel record: 409.
    expect(await failure(records.update(tenant.users.dataEntry, created.id, { periodValue: 'Q2' }))).toBeInstanceOf(
      ActivityTypeSlotConflictError,
    );
  });
});

describe('the factor library is append-only, for the owner too', () => {
  async function seededFactor() {
    return owner.emissionFactor.findFirstOrThrow({
      where: { release: { status: 'placeholder' } },
      include: { release: true },
    });
  }

  it('refuses rewriting, deleting or truncating a loaded factor, conversion or release (TA010)', async () => {
    const factor = await seededFactor();
    const conversion = await owner.unitConversion.findFirstOrThrow();
    for (const sql of [
      `UPDATE emission_factors SET factor_value = 0 WHERE id = '${factor.id}'`,
      `DELETE FROM emission_factors WHERE id = '${factor.id}'`,
      `UPDATE unit_conversions SET multiplier = 1 WHERE id = '${conversion.id}'`,
      `DELETE FROM unit_conversions WHERE id = '${conversion.id}'`,
      `UPDATE factor_releases SET title = 'rewritten' WHERE id = '${factor.releaseId}'`,
      `DELETE FROM factor_releases WHERE id = '${factor.releaseId}'`,
      'TRUNCATE emission_factors',
      'TRUNCATE unit_conversions',
      'TRUNCATE factor_releases CASCADE',
    ]) {
      // Rolled back whatever happens: a regression must not take the library with it.
      const e = await failure(withRollback(owner, (tx) => tx.$executeRawUnsafe(sql)));
      expect(sqlstateOf(e), sql).toBe('TA010');
    }
  });

  it('accepts a withdrawal — status, who, when and why — and nothing else, once', async () => {
    const { releaseId } = await seededFactor();
    const withdraw = `UPDATE factor_releases SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = 'TonyAI test', withdrawal_reason = 'int test' WHERE id = '${releaseId}'`;
    await withRollback(owner, async (tx) => {
      expect(await tx.$executeRawUnsafe(withdraw)).toBe(1);
    });
    const attempts: Array<[string, string]> = [
      [`${withdraw.replace("status = 'withdrawn'", "status = 'withdrawn', title = 'x'")}`, 'TA010'],
      [`UPDATE factor_releases SET status = 'withdrawn' WHERE id = '${releaseId}'`, '23514'],
      [`UPDATE factor_releases SET status = 'authoritative' WHERE id = '${releaseId}'`, 'TA010'],
    ];
    for (const [sql, state] of attempts) {
      expect(sqlstateOf(await failure(withRollback(owner, (tx) => tx.$executeRawUnsafe(sql)))), sql).toBe(state);
    }
    // Withdrawn is final.
    const reverted = await failure(
      withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe(withdraw);
        await tx.$executeRawUnsafe(`UPDATE factor_releases SET status = 'placeholder', withdrawn_at = NULL, withdrawn_by = NULL, withdrawal_reason = NULL WHERE id = '${releaseId}'`);
      }),
    );
    expect(sqlstateOf(reverted)).toBe('TA010');
  });

  it('refuses rewriting a withdrawal, and adding rows to a withdrawn release', async () => {
    const { releaseId } = await seededFactor();
    const withdraw = `UPDATE factor_releases SET status = 'withdrawn', withdrawn_by = 'TonyAI test', withdrawal_reason = 'int test', withdrawn_at = now() WHERE id = '${releaseId}'`;
    const rewrite = await failure(
      withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe(withdraw);
        await tx.$executeRawUnsafe(`UPDATE factor_releases SET withdrawal_reason = 'rewritten' WHERE id = '${releaseId}'`);
      }),
    );
    expect(sqlstateOf(rewrite)).toBe('TA010');
    const added = await failure(
      withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe(withdraw);
        await tx.$executeRawUnsafe(
          `INSERT INTO unit_conversions (id, release_id, category, activity_type, geography_code, reporting_year, data_year, from_unit, to_unit, multiplier, calorific_basis, basis)
           VALUES (gen_random_uuid(), '${releaseId}', 'Natural Gas', 'natural_gas', 'UK', 2031, 2031, 'cubic_metres', 'kWh', 1, 'gross', 'x')`,
        );
      }),
    );
    expect(sqlstateOf(added)).toBe('TA012');
  });

  it('reports an unspecified row under an authoritative release that got past the triggers (a restore)', async () => {
    const problems = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE emission_factors DISABLE TRIGGER emission_factors_before_insert');
      await tx.$executeRawUnsafe('ALTER TABLE factor_releases DROP CONSTRAINT factor_releases_publisher_check');
      // An authoritative load names who made it.
      await tx.$executeRawUnsafe(`SET LOCAL tonyai.actor = 'Reviewer firm'`);
      const releaseId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status, source_url, licence, published_at, reviewed_by, reviewed_at)
         VALUES ('${releaseId}', 'DESNZ', 'Conversion factors', '2026', 1, 'authoritative', 'https://www.gov.uk/x', 'OGL v3.0', '2026-06-10', 'Reviewer firm', '2026-06-20')`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO emission_factors (id, release_id, category, activity_type, gas, gas_coverage, geography_code, reporting_year, data_year, scope, scope2_method, calorific_basis, factor_value, factor_unit, normalized_unit, methodology, source, version, updated_at)
         VALUES (gen_random_uuid(), '${releaseId}', 'Fuel', 'unspecified', 'CO2e', 'all_ghg', 'UK', 2031, 2031, 1, 'not_applicable', 'not_applicable', 2.5, 'kgCO2e/L', 'litres', 'x', 'x', '2026', now())`,
      );
      await tx.$executeRawUnsafe(`UPDATE factor_releases SET sealed_at = now() WHERE id = '${releaseId}'`);
      return (await factorLibraryReport((sql: string) => tx.$queryRawUnsafe(sql))).problems;
    });
    expect(problems).toEqual(['1 factor/conversion row(s) with an unspecified activity type under an authoritative release']);
  });

  it('lets rows join a release in its loading transaction alone: unseen by any other before the commit, sealed after it', async () => {
    const releaseId = randomUUID();
    const conversion = (geographyCode: string) =>
      `INSERT INTO unit_conversions (id, release_id, category, activity_type, geography_code, reporting_year, data_year, from_unit, to_unit, multiplier, calorific_basis, basis)
       VALUES (gen_random_uuid(), '${releaseId}', 'Natural Gas', 'natural_gas', '${geographyCode}', 2031, 2031, 'cubic_metres', 'kWh', 10, 'gross', 'int test')`;
    const loading = connectOwner(1);
    const other = connectOwner(1);
    try {
      let midLoad: unknown = 'not run';
      await loading.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status) VALUES ('${releaseId}', '${FIXTURE_PUBLISHER}', 'Int load test', 'int-${releaseId}', ${await nextFixtureOrdinal(tx)}, 'fixture')`,
        );
        await tx.$executeRawUnsafe(conversion('UK'));
        // Another session, while the load is open: the release is not there.
        midLoad = sqlstateOf(await failure(withRollback(other, (o) => o.$executeRawUnsafe(conversion('TR')))));
        await tx.$executeRawUnsafe(`UPDATE factor_releases SET sealed_at = now() WHERE id = '${releaseId}'`);
      });
      expect(midLoad).toBe('TA012');
      // After the commit: sealed, for everyone — the owner included.
      expect(sqlstateOf(await failure(withRollback(other, (o) => o.$executeRawUnsafe(conversion('TR')))))).toBe('TA012');
      expect(await owner.unitConversion.count({ where: { releaseId } })).toBe(1);
    } finally {
      await removeFixture(releaseId);
      await Promise.all([loading.$disconnect(), other.$disconnect()]);
    }
  });

  it("stamps a withdrawal with the database's clock — never a backdated one", async () => {
    const { releaseId } = await seededFactor();
    const withdrawnAt = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE factor_releases SET status = 'withdrawn', withdrawn_at = '2001-01-01', withdrawn_by = 'TonyAI test', withdrawal_reason = 'int test' WHERE id = '${releaseId}'`,
      );
      const [row] = await tx.$queryRawUnsafe<{ at: Date; now: Date }[]>(
        `SELECT withdrawn_at AS at, now() AS now FROM factor_releases WHERE id = '${releaseId}'`,
      );
      return row;
    });
    expect(withdrawnAt.at.getTime()).toBe(withdrawnAt.now.getTime());
  });

  it("refuses a factor whose version is not its release's edition (TA012)", async () => {
    const { releaseId } = await seededFactor();
    const e = await failure(
      withRollback(owner, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO emission_factors (id, release_id, category, activity_type, gas, gas_coverage, geography_code, reporting_year, data_year, scope, scope2_method, calorific_basis, factor_value, factor_unit, normalized_unit, methodology, source, version, updated_at)
           VALUES (gen_random_uuid(), '${releaseId}', 'Fuel', 'gas_oil', 'CO2e', 'all_ghg', 'UK', 2031, 2031, 1, 'not_applicable', 'not_applicable', 2.5, 'kgCO2e/L', 'litres', 'x', 'x', 'not-the-edition', now())`,
        ),
      ),
    );
    expect(sqlstateOf(e)).toBe('TA012');
  });

  it('refuses a release out of order or loaded as withdrawn (TA011), and an unregistered publisher or unsourced authority (CHECK)', async () => {
    const insert = (publisher: string, ordinal: number, status: string, extra = '') =>
      `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status${extra ? ', source_url, licence, published_at, reviewed_by, reviewed_at' : ''})
       VALUES ('${randomUUID()}', '${publisher}', 'Int test', 'int-${randomUUID()}', ${ordinal}, '${status}'${extra})`;
    const states = async (...sql: string[]) =>
      sqlstateOf(await failure(withRollback(owner, async (tx) => { for (const s of sql) await tx.$executeRawUnsafe(s); })));
    expect(await states(insert('TonyAI test fixture', 900_005, 'fixture'), insert('TonyAI test fixture', 900_003, 'fixture'))).toBe('TA011');
    // An equal ordinal is not an erratum either.
    expect(await states(insert('TonyAI test fixture', 900_005, 'fixture'), insert('TonyAI test fixture', 900_005, 'fixture'))).toBe('TA011');
    expect(await states(insert('TonyAI test fixture', 900_007, 'withdrawn'))).toBe('TA011');
    // A look-alike of a registered name is not a second publisher.
    expect(await states(insert('TonyAI prototype ', 999_999, 'placeholder'))).toBe('23514');
    expect(await states(insert('DESNZ', 1, 'authoritative'))).toBe('23514');
    // Not even the internal publishers may load an authoritative release.
    expect(
      await states(insert('TonyAI prototype', 999_999, 'authoritative', `, 'https://www.gov.uk/x', 'OGL', '2026-01-01', 'Reviewer firm', '2026-02-01'`)),
    ).toBe('23514');
  });

  it('refuses an unspecified row under an authoritative release (TA012) — the trigger, past the registry', async () => {
    const releaseId = randomUUID();
    const e = await failure(
      withRollback(owner, async (tx) => {
        // Only inside this rolled-back transaction: lift the registry so an
        // authoritative release can exist, to reach the row trigger behind it.
        await tx.$executeRawUnsafe('ALTER TABLE factor_releases DROP CONSTRAINT factor_releases_publisher_check');
        await tx.$executeRawUnsafe(`SET LOCAL tonyai.actor = 'Reviewer firm'`);
        await tx.$executeRawUnsafe(
          `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status, source_url, licence, published_at, reviewed_by, reviewed_at)
           VALUES ('${releaseId}', 'DESNZ', 'Conversion factors', '2026', 1, 'authoritative', 'https://www.gov.uk/x', 'OGL v3.0', '2026-06-10', 'Reviewer firm', '2026-06-20')`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO emission_factors (id, release_id, category, activity_type, gas, gas_coverage, geography_code, reporting_year, data_year, scope, scope2_method, calorific_basis, factor_value, factor_unit, normalized_unit, methodology, source, version, updated_at)
           VALUES (gen_random_uuid(), '${releaseId}', 'Fuel', 'unspecified', 'CO2e', 'all_ghg', 'UK', 2031, 2031, 1, 'not_applicable', 'not_applicable', 2.5, 'kgCO2e/L', 'litres', 'x', 'x', '2026', now())`,
        );
      }),
    );
    expect(sqlstateOf(e)).toBe('TA012');
  });
});

describe("the factor library's record (factor_release_events)", () => {
  type Event = {
    event: string; table_name: string | null; row_count: number | null; db_role: string; actor: string | null; release_status: string;
    why: string | null; by: string | null; at: string | null; withdrawn_at: string | null; us: string;
  };
  const eventsOf = (tx: Prisma.TransactionClient, releaseId: string) =>
    tx.$queryRawUnsafe<Event[]>(
      `SELECT e.event, e.table_name, e.row_count, e.db_role, e.actor, e.release_status,
              -- In microseconds, as stored: a JS Date keeps milliseconds only.
              (extract(epoch FROM e.occurred_at) * 1000000)::bigint::text AS us,
              e.detail->>'withdrawal_reason' AS why, e.detail->>'withdrawn_by' AS by, e.detail->>'withdrawn_at' AS at,
              (SELECT to_jsonb(r.withdrawn_at) #>> '{}' FROM factor_releases r WHERE r.id = e.release_id) AS withdrawn_at
         FROM factor_release_events e WHERE e.release_id = '${releaseId}' ORDER BY e.occurred_at`,
    );
  const load = (releaseId: string, ordinal: number) => [
    `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status) VALUES ('${releaseId}', 'TonyAI test fixture', 'Int record test', 'int-${releaseId}', ${ordinal}, 'fixture')`,
    `INSERT INTO unit_conversions (id, release_id, category, activity_type, geography_code, reporting_year, data_year, from_unit, to_unit, multiplier, calorific_basis, basis)
     SELECT gen_random_uuid(), '${releaseId}', 'Natural Gas', 'natural_gas', g, 2031, 2031, 'cubic_metres', 'kWh', 1, 'gross', 'x' FROM unnest(ARRAY['UK', 'TR', 'EU']) g`,
  ];
  const nextOrdinal = async (tx: Prisma.TransactionClient) =>
    Number(
      (await tx.$queryRawUnsafe<{ next: number }[]>(
        `SELECT COALESCE(max(ordinal), 0) + 1 AS next FROM factor_releases WHERE publisher = 'TonyAI test fixture'`,
      ))[0].next,
    );

  it('records a load and its rows, a withdrawal, and a fixture deletion — who, with the stated actor, in order', async () => {
    const releaseId = randomUUID();
    const events = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL tonyai.actor = 'TonyAI ops'`);
      for (const sql of load(releaseId, await nextOrdinal(tx))) await tx.$executeRawUnsafe(sql);
      await tx.$executeRawUnsafe(`DELETE FROM unit_conversions WHERE release_id = '${releaseId}'`);
      await tx.$executeRawUnsafe(`DELETE FROM factor_releases WHERE id = '${releaseId}'`);
      return eventsOf(tx, releaseId);
    });
    expect(events.map((e) => [e.event, e.table_name, e.row_count])).toEqual([
      ['loaded', null, null],
      ['rows_added', 'unit_conversions', 3],
      ['rows_deleted', 'unit_conversions', 3],
      ['deleted', null, null],
    ]);
    expect(events.every((e) => e.actor === 'TonyAI ops' && e.db_role === 'postgres' && e.release_status === 'fixture')).toBe(true);
    // The wall clock, not the transaction's start: one transaction's events
    // still order strictly.
    const times = events.map((e) => BigInt(e.us));
    expect(times.every((t, i) => i === 0 || t > times[i - 1]), times.join(' ')).toBe(true);
  });

  it('records rows added to emission_factors as it does conversions', async () => {
    const releaseId = randomUUID();
    const events = await withRollback(owner, async (tx) => {
      const [release] = load(releaseId, await nextOrdinal(tx));
      await tx.$executeRawUnsafe(release);
      await tx.$executeRawUnsafe(
        `INSERT INTO emission_factors (id, release_id, category, activity_type, gas, gas_coverage, geography_code, reporting_year, data_year, scope, scope2_method, calorific_basis, factor_value, factor_unit, normalized_unit, methodology, source, version, updated_at)
         SELECT gen_random_uuid(), '${releaseId}', 'Fuel', 'gas_oil', 'CO2e', 'all_ghg', g, 2031, 2031, 1, 'not_applicable', 'not_applicable', 2.5, 'kgCO2e/L', 'litres', 'x', 'x', 'int-${releaseId}', now()
           FROM unnest(ARRAY['UK', 'TR']) g`,
      );
      return eventsOf(tx, releaseId);
    });
    expect(events.map((e) => [e.event, e.table_name, e.row_count])).toEqual([
      ['loaded', null, null],
      ['rows_added', 'emission_factors', 2],
    ]);
  });

  it('records a seal as its own event, and why a release was withdrawn (LP4-02)', async () => {
    const releaseId = randomUUID();
    const events = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL tonyai.actor = 'TonyAI ops'`);
      for (const sql of load(releaseId, await nextOrdinal(tx))) await tx.$executeRawUnsafe(sql);
      await tx.$executeRawUnsafe(`UPDATE factor_releases SET sealed_at = now() WHERE id = '${releaseId}'`);
      await tx.$executeRawUnsafe(
        `UPDATE factor_releases SET status = 'withdrawn', withdrawn_by = 'TonyAI ops', withdrawal_reason = 'int test' WHERE id = '${releaseId}'`,
      );
      return eventsOf(tx, releaseId);
    });
    expect(events.map((e) => [e.event, e.release_status, e.actor])).toEqual([
      ['loaded', 'fixture', 'TonyAI ops'],
      ['rows_added', 'fixture', 'TonyAI ops'],
      ['sealed', 'fixture', 'TonyAI ops'],
      ['withdrawn', 'withdrawn', 'TonyAI ops'],
    ]);
    // A seal is not a withdrawal: nothing of one in its record.
    expect(events[2]).toMatchObject({ why: null, by: null, at: null });
    expect(events[3]).toMatchObject({ why: 'int test', by: 'TonyAI ops' });
    // The withdrawal's own time, as the release now holds it.
    expect(events[3].at).not.toBeNull();
    expect(events[3].at).toBe(events[3].withdrawn_at);
  });

  it('refuses a direct INSERT even to the owner — only its own triggers write it', async () => {
    const e = await failure(
      withRollback(owner, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO factor_release_events (id, release_id, publisher, edition, release_status, event, db_role)
           VALUES (gen_random_uuid(), gen_random_uuid(), 'x', 'x', 'x', 'loaded', 'x')`,
        ),
      ),
    );
    expect(sqlstateOf(e)).toBe('TA010');
  });

  it('keeps the stated actor clean text, and requires one for an authoritative load', async () => {
    const releaseId = randomUUID();
    const dirty = await failure(
      withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL tonyai.actor = ' padded'`);
        for (const sql of load(releaseId, await nextOrdinal(tx))) await tx.$executeRawUnsafe(sql);
      }),
    );
    expect(String((dirty as Error).message)).toContain('factor_release_events_actor_check');
    const authoritative = `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status, source_url, licence, published_at, reviewed_by, reviewed_at)
      VALUES ('${randomUUID()}', 'DESNZ', 'Conversion factors', '2026', 1, 'authoritative', 'https://www.gov.uk/x', 'OGL v3.0', '2026-06-10', 'Reviewer firm', '2026-06-20')`;
    const unnamed = await failure(
      withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE factor_releases DROP CONSTRAINT factor_releases_publisher_check');
        await tx.$executeRawUnsafe(authoritative);
      }),
    );
    expect(sqlstateOf(unnamed)).toBe('TA011');
    await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE factor_releases DROP CONSTRAINT factor_releases_publisher_check');
      await tx.$executeRawUnsafe(`SET LOCAL tonyai.actor = 'Reviewer firm'`);
      await tx.$executeRawUnsafe(authoritative);
    });
  });

  it('refuses a statement that would drop a rows event — a release deleted beside its rows', async () => {
    const releaseId = randomUUID();
    const e = await failure(
      withRollback(owner, async (tx) => {
        for (const sql of load(releaseId, await nextOrdinal(tx))) await tx.$executeRawUnsafe(sql);
        await tx.$executeRawUnsafe(
          `WITH d AS (DELETE FROM factor_releases WHERE id = '${releaseId}') DELETE FROM unit_conversions WHERE release_id = '${releaseId}'`,
        );
      }),
    );
    expect(sqlstateOf(e)).toBe('TA010');
  });

  it('refuses a load under REPEATABLE READ or SERIALIZABLE, which could not see a concurrent load or withdrawal — releases, factors and conversions', async () => {
    const [{ id: seeded }] = await owner.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM factor_releases WHERE publisher = 'TonyAI prototype' AND edition = '2026.1'`,
    );
    const releaseId = randomUUID();
    const [release, conversions] = load(releaseId, 0);
    const statements: [string, string][] = [
      // The isolation level is the first thing each guard reads.
      ['TA011', release],
      ['TA012', conversions.replaceAll(releaseId, seeded)],
      [
        'TA012',
        `INSERT INTO emission_factors (id, release_id, category, activity_type, gas, gas_coverage, geography_code, reporting_year, data_year, scope, scope2_method, calorific_basis, factor_value, factor_unit, normalized_unit, methodology, source, version, updated_at)
         VALUES (gen_random_uuid(), '${seeded}', 'Fuel', 'gas_oil', 'CO2e', 'all_ghg', 'UK', 2031, 2031, 1, 'not_applicable', 'not_applicable', 2.5, 'kgCO2e/L', 'litres', 'x', 'x', '2026.1', now())`,
      ],
    ];
    for (const isolationLevel of ['RepeatableRead', 'Serializable'] as const) {
      for (const [code, sql] of statements) {
        const e = await failure(owner.$transaction((tx) => tx.$executeRawUnsafe(sql), { isolationLevel }));
        expect(sqlstateOf(e), `${isolationLevel} ${sql.slice(0, 40)}`).toBe(code);
        expect(String((e as Error).message)).toMatch(/READ COMMITTED/);
      }
    }
  });

  it('writes its record only for the tables it answers for — attached anywhere else, a writer refuses (it runs as the owner)', async () => {
    const attached = [
      ['factor_releases_record_event', 'AFTER INSERT ON pg_temp.int_forged FOR EACH ROW'],
      ['factor_rows_record_event', 'AFTER INSERT ON pg_temp.int_forged REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT'],
    ];
    for (const [fn, timing] of attached) {
      const e = await failure(
        withRollback(owner, async (tx) => {
          await tx.$executeRawUnsafe(
            'CREATE TEMP TABLE int_forged (id uuid, release_id uuid, publisher text, edition text, status text, withdrawn_at timestamptz, withdrawn_by text, withdrawal_reason text) ON COMMIT DROP',
          );
          await tx.$executeRawUnsafe(`CREATE TRIGGER int_forged ${timing} EXECUTE FUNCTION public.${fn}()`);
          await tx.$executeRawUnsafe(`INSERT INTO pg_temp.int_forged VALUES (gen_random_uuid(), gen_random_uuid(), 'DESNZ', '2025', 'authoritative', null, null, null)`);
        }),
      );
      expect(sqlstateOf(e), fn).toBe('TA010');
    }
  });

  // Supabase's default privileges grant EXECUTE on every function postgres
  // creates in `public` to the three API roles (CI, staging, production; a
  // local reset drops them). Attaching a trigger function needs it.
  it.each(['anon', 'authenticated', 'service_role'])('refuses %s the record\'s writers — it cannot attach one to a table of its own', async (role) => {
    for (const fn of ['factor_releases_record_event', 'factor_rows_record_event']) {
      const e = await failure(
        withRollback(owner, async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          await tx.$executeRawUnsafe('CREATE TEMP TABLE int_forged (id uuid) ON COMMIT DROP');
          await tx.$executeRawUnsafe(`CREATE TRIGGER int_forged AFTER INSERT ON pg_temp.int_forged FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
        }),
      );
      // The function's EXECUTE, not some other privilege (TEMP, say), refused it.
      expect(sqlstateOf(e), `${role} ${fn}`).toBe('42501');
      expect(String((e as Error).message)).toMatch(new RegExp(`permission denied for function public\\.${fn}\\b`));
    }
  });
  // This test and runtime-role.int.spec's checkFunctionExecutors test bite only
  // on a stack that carries Supabase's default privileges (CI): on a locally
  // reset database the ACL was owner-only even before the fix (Open questions,
  // "LP3-03 PR B" (13)).

  it('reports rows the record never saw added (a load past its triggers)', async () => {
    const id = randomUUID();
    const problems = await withRollback(owner, async (tx) => {
      // A release of its own, open in this transaction: a sealed one takes no row (LP4-02).
      await tx.$executeRawUnsafe(load(id, await nextOrdinal(tx))[0]);
      await tx.$executeRawUnsafe('ALTER TABLE unit_conversions DISABLE TRIGGER unit_conversions_record_insert');
      await tx.$executeRawUnsafe(
        `INSERT INTO unit_conversions (id, release_id, category, activity_type, geography_code, reporting_year, data_year, from_unit, to_unit, multiplier, calorific_basis, basis)
         VALUES (gen_random_uuid(), '${id}', 'Natural Gas', 'natural_gas', 'UK', 2032, 2032, 'cubic_metres', 'kWh', 1, 'gross', 'x')`,
      );
      return (await factorLibraryReport((sql: string) => tx.$queryRawUnsafe(sql))).problems;
    });
    expect(problems.some((p: string) => /unit_conversions row\(s\) but factor_release_events records/.test(p))).toBe(true);
  });

  it('reports recorded rows the library no longer holds (a delete past its triggers)', async () => {
    const releaseId = randomUUID();
    const problems = await withRollback(owner, async (tx) => {
      for (const sql of load(releaseId, await nextOrdinal(tx))) await tx.$executeRawUnsafe(sql);
      await tx.$executeRawUnsafe('ALTER TABLE unit_conversions DISABLE TRIGGER unit_conversions_record_delete');
      await tx.$executeRawUnsafe(`DELETE FROM unit_conversions WHERE release_id = '${releaseId}'`);
      return (await factorLibraryReport((sql: string) => tx.$queryRawUnsafe(sql))).problems;
    });
    expect(problems).toContain(`release ${releaseId} holds 0 unit_conversions row(s) but factor_release_events records 3`);
  });

  it("records the release's own status on every event — a placeholder load as placeholder", async () => {
    const releaseId = randomUUID();
    const events = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status, notes)
         SELECT '${releaseId}', publisher, title, '2099.1', 209901, 'placeholder', notes
           FROM factor_releases WHERE publisher = 'TonyAI prototype' AND edition = '2026.1'`,
      );
      await tx.$executeRawUnsafe(load(releaseId, 0)[1].replaceAll('2031', '2099'));
      return eventsOf(tx, releaseId);
    });
    expect(events.map((e) => [e.event, e.release_status])).toEqual([
      ['loaded', 'placeholder'],
      ['rows_added', 'placeholder'],
    ]);
  });

  it('stamps a row with the time it was loaded, whatever the writer says', async () => {
    const releaseId = randomUUID();
    const stamped = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(load(releaseId, await nextOrdinal(tx))[0]);
      await tx.$executeRawUnsafe(
        `INSERT INTO unit_conversions (id, release_id, category, activity_type, geography_code, reporting_year, data_year, from_unit, to_unit, multiplier, calorific_basis, basis, created_at)
         VALUES (gen_random_uuid(), '${releaseId}', 'Natural Gas', 'natural_gas', 'UK', 2031, 2031, 'cubic_metres', 'kWh', 1, 'gross', 'x', '2000-01-01')`,
      );
      return tx.$queryRawUnsafe<{ fresh: boolean }[]>(
        `SELECT bool_and(created_at > now() - interval '1 hour') AS fresh FROM unit_conversions WHERE release_id = '${releaseId}'`,
      );
    });
    expect(stamped[0].fresh).toBe(true);
  });

  it('is written by its triggers alone: the service role cannot add to it, and nobody can change it', async () => {
    const forged = await failure(
      withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
        await tx.$executeRawUnsafe(
          `INSERT INTO factor_release_events (id, release_id, publisher, edition, release_status, event, db_role)
           VALUES (gen_random_uuid(), gen_random_uuid(), 'x', 'x', 'x', 'loaded', 'x')`,
        );
      }),
    );
    expect(sqlstateOf(forged)).toBe('42501');
    // Nor lock the record (it holds SELECT alone there), or run the owner's
    // maintenance on the library or the records K5 guards (MAINTAIN revoked).
    for (const sql of [
      'LOCK TABLE factor_release_events IN ACCESS EXCLUSIVE MODE',
      // LP4-02: no row verb on the library left, so no lock on it either.
      'LOCK TABLE factor_releases IN ACCESS EXCLUSIVE MODE',
      'LOCK TABLE emission_factors IN ACCESS EXCLUSIVE MODE',
      'REINDEX TABLE factor_releases',
      'REINDEX TABLE emission_factors',
      'REINDEX TABLE activity_records',
      'CLUSTER audit_log USING audit_log_pkey',
      // Neither table has a TRUNCATE trigger: the revoke is the only barrier
      // to wiping the records past their row guards, or the audit trail.
      'TRUNCATE activity_records CASCADE',
      'TRUNCATE audit_log',
      'TRUNCATE subsidiaries CASCADE',
    ]) {
      const e = await failure(
        withRollback(owner, async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE service_role');
          await tx.$executeRawUnsafe(sql);
        }),
      );
      expect(sqlstateOf(e), sql).toBe('42501');
    }
    // On rows that exist — a row trigger never fires on none.
    const releaseId = randomUUID();
    for (const sql of [
      `UPDATE factor_release_events SET actor = 'rewritten' WHERE release_id = '${releaseId}'`,
      `DELETE FROM factor_release_events WHERE release_id = '${releaseId}'`,
      'TRUNCATE factor_release_events',
    ]) {
      const e = await failure(
        withRollback(owner, async (tx) => {
          for (const step of load(releaseId, await nextOrdinal(tx))) await tx.$executeRawUnsafe(step);
          expect((await eventsOf(tx, releaseId)).length).toBe(2);
          await tx.$executeRawUnsafe(sql);
        }),
      );
      expect(sqlstateOf(e), sql).toBe('TA010');
    }
  });

  describe('a restore (replica mode) loads what a dump holds — and the change guards still hold', () => {
    it('lets the owner load rows, events and a mixed slot as a dump holds them; refuses every change; the check finds the slot', async () => {
      const releaseId = randomUUID();
      const typedSlot = nextSlot();
      const outcome = await withRollback(owner, async (tx) => {
        const refused = async (sql: string) => {
          await tx.$executeRawUnsafe('SAVEPOINT probe');
          try {
            await tx.$executeRawUnsafe(sql);
            return null;
          } catch (e) {
            return sqlstateOf(e);
          } finally {
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT probe');
          }
        };
        await tx.$executeRawUnsafe(load(releaseId, await nextOrdinal(tx))[0]);
        await tx.$executeRawUnsafe(`UPDATE factor_releases SET sealed_at = now() WHERE id = '${releaseId}'`);
        await tx.$executeRawUnsafe(
          `UPDATE factor_releases SET status = 'withdrawn', withdrawn_by = 'TonyAI ops', withdrawal_reason = 'int restore' WHERE id = '${releaseId}'`,
        );
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        // A dump's rows of a since-withdrawn release, and its events: loaded.
        await tx.$executeRawUnsafe(load(releaseId, 0)[1]);
        const before = (await eventsOf(tx, releaseId)).length;
        await tx.$executeRawUnsafe(
          `INSERT INTO factor_release_events (id, release_id, publisher, edition, release_status, event, table_name, row_count, db_role)
           VALUES (gen_random_uuid(), '${releaseId}', 'TonyAI test fixture', 'int-${releaseId}', 'withdrawn', 'rows_added', 'unit_conversions', 3, 'postgres')`,
        );
        // A slot holding both kinds, as a dump of a broken database would.
        await createRecord(tx as unknown as PrismaService, tenant, { ...typedSlot, category: 'Fuel', scope: 1, activityUnit: 'litres' });
        await createRecord(tx as unknown as PrismaService, tenant, { ...typedSlot, category: 'Fuel', scope: 1, activityUnit: 'litres', activityType: 'diesel' });
        return {
          rowsWrittenNoEvent: (await eventsOf(tx, releaseId)).length - before,
          updateEvent: await refused(`UPDATE factor_release_events SET actor = 'x' WHERE release_id = '${releaseId}'`),
          updateRow: await refused(`UPDATE unit_conversions SET basis = 'y' WHERE release_id = '${releaseId}'`),
          deleteRow: await refused(`DELETE FROM emission_factors WHERE release_id = (SELECT id FROM factor_releases WHERE publisher = 'TonyAI prototype' AND edition = '2026.1')`),
          invariants: await checkTenantInvariants((sql: string) => tx.$queryRawUnsafe(sql)),
        };
      });
      expect(outcome).toEqual({
        rowsWrittenNoEvent: 1,
        updateEvent: 'TA010',
        updateRow: 'TA010',
        deleteRow: 'TA010',
        invariants: ['1 activity_records slot(s) hold typed records and an untyped one'],
      });
    });
  });
});

describe('the CHECK constraints refuse what the registry alone would hide', () => {
  // Rows go to a release loaded in the same rolled-back transaction: a sealed
  // one — the seed's — refuses every row before its CHECKs are reached (LP4-02).
  const OPEN_RELEASE = `(SELECT id FROM factor_releases WHERE publisher = '${FIXTURE_PUBLISHER}' AND edition = '2026.1')`;
  const OPEN_RELEASE_LOAD = `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status)
    SELECT gen_random_uuid(), '${FIXTURE_PUBLISHER}', 'Int CHECK test', '2026.1', COALESCE(max(ordinal), 0) + 1, 'fixture'
      FROM factor_releases WHERE publisher = '${FIXTURE_PUBLISHER}'`;
  // Rolled back. The publisher registry is lifted inside the transaction so an
  // authoritative release can exist at all — otherwise it masks every
  // provenance rule behind it, which is the state LP4-02 will open.
  const release = (cols: Record<string, string>) => {
    const row: Record<string, string> = {
      id: `'${randomUUID()}'`, publisher: `'DESNZ'`, title: `'Conversion factors'`, edition: `'e-${randomUUID().slice(0, 8)}'`,
      ordinal: '1', status: `'authoritative'`, source_url: `'https://www.gov.uk/x'`, licence: `'OGL v3.0'`,
      published_at: `'2026-06-10'`, reviewed_by: `'Reviewer firm'`, reviewed_at: `'2026-06-20'`, ...cols,
    };
    return `INSERT INTO factor_releases (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).join(', ')})`;
  };
  const factor = (cols: Record<string, string>) => {
    const row: Record<string, string> = {
      id: 'gen_random_uuid()', release_id: OPEN_RELEASE,
      category: `'Fuel'`, activity_type: `'gas_oil'`, gas: `'CO2e'`, gas_coverage: `'all_ghg'`, geography_code: `'UK'`,
      reporting_year: '2031', data_year: '2031', scope: '1', scope2_method: `'not_applicable'`, calorific_basis: `'not_applicable'`,
      factor_value: '2.5', factor_unit: `'kgCO2e/L'`, normalized_unit: `'litres'`, methodology: `'x'`, source: `'x'`, version: `'2026.1'`,
      updated_at: 'now()', ...cols,
    };
    return `INSERT INTO emission_factors (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).join(', ')})`;
  };
  const conversion = (cols: Record<string, string>) => {
    const row: Record<string, string> = {
      id: 'gen_random_uuid()', release_id: OPEN_RELEASE,
      category: `'Natural Gas'`, activity_type: `'natural_gas'`, geography_code: `'UK'`, reporting_year: '2031', data_year: '2031',
      from_unit: `'cubic_metres'`, to_unit: `'kWh'`, multiplier: '10', calorific_basis: `'gross'`, basis: `'x'`, ...cols,
    };
    return `INSERT INTO unit_conversions (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).join(', ')})`;
  };
  it('refuses a fully sourced authoritative release from an unregistered publisher — the registry itself', async () => {
    const e = await failure(withRollback(owner, (tx) => tx.$executeRawUnsafe(release({}))));
    expect(sqlstateOf(e)).toBe('23514');
    expect(String((e as Error).message)).toContain('factor_releases_publisher_check');
  });

  const cases: Array<[string, string]> = [
    [release({ published_at: 'NULL' }), 'factor_releases_authoritative_provenance_check'],
    [release({ reviewed_at: 'NULL' }), 'factor_releases_authoritative_provenance_check'],
    [release({ source_url: `'https://www.gov.uk/' || repeat('x', 2000)` }), 'factor_releases_source_url_check'],
    [release({ withdrawn_by: `'Someone'` }), 'factor_releases_withdrawal_check'],
    [release({ publisher: `'TonyAI test fixture'` }), 'factor_releases_fixture_publisher_check'],
    [release({ source_url: 'NULL' }), 'factor_releases_authoritative_provenance_check'],
    [release({ licence: 'NULL' }), 'factor_releases_authoritative_provenance_check'],
    [release({ reviewed_by: 'NULL' }), 'factor_releases_authoritative_provenance_check'],
    [release({ reviewed_at: `'2026-06-01'` }), 'factor_releases_review_after_publication_check'],
    [release({ source_url: `'http://www.gov.uk/x'` }), 'factor_releases_source_url_check'],
    [release({ source_url: `'https://www.gov.uk@evil.example/x'` }), 'factor_releases_source_url_check'],
    [release({ title: `'Trailing space '` }), 'factor_releases_text_check'],
    [release({ title: `'Zero' || chr(8203) || 'width'` }), 'factor_releases_text_check'],
    [release({ ordinal: '0' }), 'factor_releases_ordinal_check'],
    [release({ gwp_set: `'AR3'` }), 'factor_releases_gwp_set_check'],
    [release({ status: `'Authoritative'` }), 'factor_releases_status_check'],
    // (Only the internal fixture publisher's releases may be fixtures, and only
    // the prototype's placeholders.)
    [release({ status: `'fixture'` }), 'factor_releases_fixture_publisher_check'],
    [release({ status: `'placeholder'` }), 'factor_releases_placeholder_publisher_check'],
    [factor({ factor_value: '-1' }), 'emission_factors_factor_value_check'],
    [factor({ factor_value: `'NaN'` }), 'emission_factors_factor_value_check'],
    [factor({ factor_value: `'Infinity'` }), 'emission_factors_factor_value_check'],
    [factor({ gas: `'CO2x'`, gas_coverage: 'NULL' }), 'emission_factors_gas_check'],
    [factor({ gas: `'CO2'` }), 'emission_factors_gas_coverage_check'],
    [factor({ gas_coverage: 'NULL' }), 'emission_factors_gas_coverage_check'],
    [factor({ scope: '2' }), 'emission_factors_scope2_method_check'],
    [factor({ scope: '4' }), 'emission_factors_scope_check'],
    [factor({ calorific_basis: `'GROSS'` }), 'emission_factors_calorific_basis_check'],
    [factor({ activity_type: `'gas oil'` }), 'emission_factors_activity_type_check'],
    [conversion({ multiplier: '0' }), 'unit_conversions_multiplier_check'],
    [conversion({ multiplier: `'Infinity'` }), 'unit_conversions_multiplier_check'],
    [conversion({ activity_type: `'natural gas'` }), 'unit_conversions_activity_type_check'],
    [conversion({ to_unit: `'cubic_metres'` }), 'unit_conversions_units_check'],
    [conversion({ basis: `''` }), 'unit_conversions_text_check'],
    [conversion({ calorific_basis: `'higher'` }), 'unit_conversions_calorific_basis_check'],
  ];
  it.each(cases)('%s → %s', async (sql, constraint) => {
    const e = await failure(
      withRollback(owner, async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE factor_releases DROP CONSTRAINT factor_releases_publisher_check');
        if (!sql.startsWith('INSERT INTO factor_releases')) await tx.$executeRawUnsafe(OPEN_RELEASE_LOAD);
        await tx.$executeRawUnsafe(sql);
      }),
    );
    expect(sqlstateOf(e)).toBe('23514');
    expect(String((e as Error).message)).toContain(constraint);
  });

  it('refuses a malformed activity type on a record', async () => {
    const e = await failure(createRecord(owner, tenant, { ...nextSlot(), category: 'Fuel', scope: 1, activityType: 'die sel' }));
    expect(String((e as Error).message)).toContain('activity_records_activity_type_check');
  });
});

describe('the engine on the real library', () => {
  it('prices metered m³ of natural gas through the seed\'s 11.36 placeholder conversion row (K4)', async () => {
    const engine = new CalculationsService(runtime, INT_FACTOR_POLICY);
    const result = await engine.compute({ category: 'Natural Gas', geographyCode: 'UK', reportingYear: 2026, value: 100, unit: 'cubic_metres' });
    expect(result).toMatchObject({
      snapshotSchema: 2,
      normalizedUnit: 'kWh',
      conversionApplied: true,
      conversionFactor: 11.36,
      calorificBasis: 'gross',
      conversion: { fromUnit: 'cubic_metres', toUnit: 'kWh', multiplier: 11.36, release: { status: 'placeholder' } },
      factorRelease: { publisher: 'TonyAI prototype', status: 'placeholder' },
    });
    expect((result as { normalizedValue: number }).normalizedValue).toBeCloseTo(1136, 9);
  });

  it('refuses the same library where placeholders are refused, naming the gap and the lookup', async () => {
    const engine = new CalculationsService(runtime, Object.freeze({ allowPlaceholders: false }));
    const e = await failure(engine.compute({ category: 'Electricity', geographyCode: 'UK', reportingYear: 2026, value: 100, unit: 'kWh' }));
    expect(e).toBeInstanceOf(NoEmissionFactorError);
    expect((e as NoEmissionFactorError).getResponse()).toMatchObject({
      code: 'placeholder_refused',
      coverage: { category: 'Electricity', activityType: 'grid_electricity', geographyCode: 'UK', reportingYear: 2026, unit: 'kWh' },
    });
  });

  it("never applies another geography's or another year's conversion", async () => {
    // Fixture releases of their own, committed (and sealed) so the runtime can
    // read them, removed in `finally` (fixture rows are the deletable ones).
    const factor: FactorRow = {
      category: 'Natural Gas', activityType: 'natural_gas', gas: 'CO2e', gasCoverage: 'all_ghg',
      geographyCode: 'UK', reportingYear: 2031, dataYear: 2031, scope: 1, scope2Method: 'not_applicable', calorificBasis: 'gross',
      factorValue: 0.2, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'int test', source: 'int test',
    };
    const conversion = (geographyCode: string, reportingYear: number): ConversionRow => ({
      category: 'Natural Gas', activityType: 'natural_gas', geographyCode, reportingYear,
      dataYear: reportingYear, fromUnit: 'cubic_metres', toUnit: 'kWh', multiplier: 10, calorificBasis: 'gross', basis: 'int test',
    });
    const engine = new CalculationsService(runtime, INT_FACTOR_POLICY);
    const input = { category: 'Natural Gas', geographyCode: 'UK', reportingYear: 2031, value: 100, unit: 'cubic_metres' };
    const mismatched = await loadFixture({ factors: [factor], conversions: [conversion('TR', 2031), conversion('UK', 2030)] });
    try {
      expect(await failure(engine.compute(input))).toMatchObject({ code: 'no_conversion' });
    } finally {
      await removeFixture(mismatched.id);
    }
    // Positive control: the matching conversion prices it — a release of its
    // own, since a sealed one takes no row.
    const matching = await loadFixture({ factors: [factor], conversions: [conversion('UK', 2031)] });
    try {
      expect(await engine.compute(input)).toMatchObject({ normalizedValue: 1000, kgCo2e: 200 });
    } finally {
      await removeFixture(matching.id);
    }
  });

  it('answers a foreign subsidiary with the plain 404 — nothing about the factor library', async () => {
    const { records } = lifecycleServices(runtime);
    const dto = {
      subsidiaryId: tenant.subsidiaryId,
      reportingYear: 2031,
      reportingPeriod: 'monthly' as const,
      periodValue: 'January',
      category: 'Electricity' as const,
      activityValue: 1,
      activityUnit: 'kWh',
    };
    const foreignAnswer = await failure(records.previewCreate(foreign.users.superAdmin, dto));
    expect(foreignAnswer).toBeInstanceOf(NotFoundException);
    expect(foreignAnswer).not.toBeInstanceOf(NoEmissionFactorError);
    expect((foreignAnswer as NotFoundException).getResponse()).not.toHaveProperty('coverage');
    // LP3-01: every 404 has a code now — the kind of thing not found, the
    // same one a subsidiary that does not exist gets; never a library code.
    expect((foreignAnswer as NotFoundException).getResponse()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Subsidiary not found',
      code: 'subsidiary_not_found',
    });
    // Positive control: the tenant's own administrator learns the gap.
    const ownAnswer = await failure(records.previewCreate(tenant.users.superAdmin, dto));
    expect((ownAnswer as NoEmissionFactorError).getResponse()).toMatchObject({ code: 'no_factor', coverage: { reportingYear: 2031 } });
  });
});

describe('LP4-02 — a release is sealed in the transaction that loads it, by its loader or the owner', () => {
  const release = (id: string, ordinal: number, extra = '') =>
    `INSERT INTO factor_releases (id, publisher, title, edition, ordinal, status${extra ? ', sealed_at' : ''})
     VALUES ('${id}', '${FIXTURE_PUBLISHER}', 'Int seal test', 'int-${id}', ${ordinal}, 'fixture'${extra ? `, ${extra}` : ''})`;
  const conversion = (releaseId: string, geographyCode = 'UK') =>
    `INSERT INTO unit_conversions (id, release_id, category, activity_type, geography_code, reporting_year, data_year, from_unit, to_unit, multiplier, calorific_basis, basis)
     VALUES (gen_random_uuid(), '${releaseId}', 'Natural Gas', 'natural_gas', '${geographyCode}', 2031, 2031, 'cubic_metres', 'kWh', 10, 'gross', 'int test')`;
  const seal = (id: string, at = 'now()') => `UPDATE factor_releases SET sealed_at = ${at} WHERE id = '${id}'`;
  const withdraw = (id: string) =>
    `UPDATE factor_releases SET status = 'withdrawn', withdrawn_by = 'TonyAI ops', withdrawal_reason = 'int test' WHERE id = '${id}'`;
  /** Each statement's SQLSTATE (null when it went through), in one rolled-back transaction, each behind a savepoint. */
  async function outcomes(client: PrismaService, setup: string[], probes: string[]): Promise<(string | null)[]> {
    return withRollback(client, async (tx) => {
      for (const sql of setup) await tx.$executeRawUnsafe(sql);
      const out: (string | null)[] = [];
      for (const sql of probes) {
        await tx.$executeRawUnsafe('SAVEPOINT probe');
        try {
          await tx.$executeRawUnsafe(sql);
          out.push(null);
        } catch (e) {
          out.push(sqlstateOf(e));
        } finally {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT probe');
        }
      }
      return out;
    });
  }

  it("seals once, by the database's clock, and never undoes it — and a sealed release takes no row (TA012)", async () => {
    const id = randomUUID();
    const sealedAt = await withRollback(owner, async (tx) => {
      await tx.$executeRawUnsafe(release(id, await nextFixtureOrdinal(tx)));
      await tx.$executeRawUnsafe(conversion(id));
      await tx.$executeRawUnsafe(seal(id, `'2001-01-01'`));
      const [row] = await tx.$queryRawUnsafe<{ at: Date; now: Date }[]>(`SELECT sealed_at AS at, now() AS now FROM factor_releases WHERE id = '${id}'`);
      return row;
    });
    expect(sealedAt.at.getTime()).toBe(sealedAt.now.getTime());
    const ordinal = await nextFixtureOrdinal(owner);
    expect(
      await outcomes(owner, [release(id, ordinal), conversion(id), seal(id)], [
        conversion(id, 'TR'),
        `UPDATE factor_releases SET sealed_at = NULL WHERE id = '${id}'`,
        seal(id, `now() + interval '1 day'`),
        `UPDATE factor_releases SET title = 'rewritten' WHERE id = '${id}'`,
        withdraw(id),
      ]),
    ).toEqual(['TA012', 'TA010', 'TA010', 'TA010', null]);
    // Before its seal a release accepts nothing else: not a withdrawal, not
    // its seal and another change in one statement.
    expect(
      await outcomes(owner, [release(id, ordinal)], [
        withdraw(id),
        `UPDATE factor_releases SET sealed_at = now(), title = 'x' WHERE id = '${id}'`,
        `UPDATE factor_releases SET sealed_at = now(), status = 'withdrawn', withdrawn_by = 'x', withdrawal_reason = 'x' WHERE id = '${id}'`,
        seal(id),
      ]),
    ).toEqual(['TA010', 'TA010', 'TA010', null]);
  });

  it('refuses a release loaded sealed (TA011), and a commit that leaves one unsealed (TA011, at the commit)', async () => {
    const id = randomUUID();
    expect(await outcomes(owner, [], [release(id, await nextFixtureOrdinal(owner), 'now()')])).toEqual(['TA011']);
    // The check, run now rather than at the commit, answers with its code…
    expect(
      await outcomes(owner, [release(id, await nextFixtureOrdinal(owner)), conversion(id)], [
        'SET CONSTRAINTS factor_releases_sealed_at_commit IMMEDIATE',
      ]),
    ).toEqual(['TA011']);
    // …and at the commit refuses it whole (Prisma reports a refused COMMIT
    // without its SQLSTATE — the message is the evidence).
    const unsealed = await failure(
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(release(id, await nextFixtureOrdinal(tx)));
        await tx.$executeRawUnsafe(conversion(id));
      }),
    );
    expect(String((unsealed as Error).message)).toMatch(new RegExp(`factor release ${id} was loaded and not sealed`));
    expect(await owner.factorRelease.count({ where: { id } })).toBe(0);
    // Positive control: the same load, sealed, commits.
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(release(id, await nextFixtureOrdinal(tx)));
      await tx.$executeRawUnsafe(conversion(id));
      await tx.$executeRawUnsafe(seal(id));
    });
    try {
      expect(await owner.factorRelease.count({ where: { id, sealedAt: { not: null } } })).toBe(1);
    } finally {
      await removeFixture(id);
    }
  });

  it('lets the loader load, seal and withdraw, recorded as itself — and nothing else', async () => {
    const loader = connectLoader(1);
    const id = randomUUID();
    try {
      // A load commits: the release, its rows and its seal, the actor stated.
      await loader.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL tonyai.actor = 'TonyAI ops'`);
        await tx.$executeRawUnsafe(release(id, await nextFixtureOrdinal(tx)));
        await tx.$executeRawUnsafe(conversion(id));
        await tx.$executeRawUnsafe(seal(id));
      });
      const events = await owner.$queryRawUnsafe<{ event: string; db_role: string; actor: string | null }[]>(
        `SELECT event, db_role, actor FROM factor_release_events WHERE release_id = '${id}' ORDER BY occurred_at`,
      );
      expect(events.map((e) => [e.event, e.db_role, e.actor])).toEqual([
        ['loaded', 'tonyai_factor_loader', 'TonyAI ops'],
        ['rows_added', 'tonyai_factor_loader', 'TonyAI ops'],
        ['sealed', 'tonyai_factor_loader', 'TonyAI ops'],
      ]);
      // A withdrawal (rolled back: a withdrawn fixture can no longer be removed).
      expect(await outcomes(loader, [], [withdraw(id)])).toEqual([null]);
      // Nothing else: no delete, no other column, no other table, no replica
      // mode, no other role, no record of its own making.
      expect(
        await outcomes(loader, [], [
          `DELETE FROM unit_conversions WHERE release_id = '${id}'`,
          `DELETE FROM factor_releases WHERE id = '${id}'`,
          `UPDATE factor_releases SET title = 'x' WHERE id = '${id}'`,
          `UPDATE unit_conversions SET multiplier = 1 WHERE release_id = '${id}'`,
          'TRUNCATE unit_conversions',
          'LOCK TABLE factor_releases IN ACCESS EXCLUSIVE MODE',
          `INSERT INTO factor_release_events (id, release_id, publisher, edition, release_status, event, db_role)
           VALUES (gen_random_uuid(), '${id}', 'x', 'x', 'x', 'loaded', 'x')`,
          'SELECT 1 FROM factor_release_events LIMIT 1',
          'SELECT 1 FROM activity_records LIMIT 1',
          'SELECT 1 FROM profiles LIMIT 1',
          'SET session_replication_role = replica',
          'SET ROLE postgres',
          'SET ROLE tonyai_runtime',
          'CREATE TABLE public.loader_owned (id int)',
        ]),
      ).toEqual(['42501', '42501', '42501', '42501', '42501', '42501', '42501', '42501', '42501', '42501', '42501', '42501', '42501', '42501']);
    } finally {
      await removeFixture(id);
      await loader.$disconnect();
    }
  });

  it('leaves the service role nothing to write: no load, no seal, no withdrawal, no delete — PostgREST included', async () => {
    const { releaseId } = await owner.emissionFactor.findFirstOrThrow({ where: { release: { status: 'placeholder' } } });
    const asServiceRole = (sql: string) => [`SET LOCAL ROLE service_role`, sql];
    const id = randomUUID();
    for (const sql of [
      release(id, 1),
      withdraw(releaseId),
      seal(releaseId),
      `DELETE FROM factor_releases WHERE id = '${releaseId}'`,
      `DELETE FROM emission_factors WHERE release_id = '${releaseId}'`,
      conversion(releaseId),
    ]) {
      const [state] = await outcomes(owner, asServiceRole('SELECT 1'), [sql]);
      expect(state, sql).toBe('42501');
    }
    // The same through PostgREST, the service role's own door (independent
    // review F6: it could withdraw any release).
    expect(
      await refusal(await serviceRest('PATCH', `factor_releases?id=eq.${releaseId}`, { status: 'withdrawn', withdrawn_by: 'x', withdrawal_reason: 'x' })),
    ).toEqual({ ok: false, code: '42501' });
    expect(
      await refusal(
        await serviceRest('POST', 'factor_releases', { id, publisher: FIXTURE_PUBLISHER, title: 'x', edition: `int-${id}`, ordinal: 999999, status: 'fixture' }),
      ),
    ).toEqual({ ok: false, code: '42501' });
    expect(await refusal(await serviceRest('DELETE', `unit_conversions?release_id=eq.${releaseId}`))).toEqual({ ok: false, code: '42501' });
    expect(await owner.factorRelease.count({ where: { id } })).toBe(0);
    expect(await owner.factorRelease.count({ where: { id: releaseId, status: 'withdrawn' } })).toBe(0);
  });

  it('lets a test fixture release go with its rows, withdrawn or not — and no other withdrawn release', async () => {
    const id = randomUUID();
    const left = await withRollback(owner, async (tx) => {
      for (const sql of [release(id, await nextFixtureOrdinal(tx)), conversion(id), seal(id), withdraw(id)]) await tx.$executeRawUnsafe(sql);
      await tx.$executeRawUnsafe(`DELETE FROM unit_conversions WHERE release_id = '${id}'`);
      await tx.$executeRawUnsafe(`DELETE FROM factor_releases WHERE id = '${id}'`);
      return tx.factorRelease.count({ where: { id } });
    });
    expect(left).toBe(0);
    const { releaseId } = await owner.emissionFactor.findFirstOrThrow({ where: { release: { status: 'placeholder' } } });
    expect(
      await outcomes(owner, [withdraw(releaseId)], [
        `DELETE FROM emission_factors WHERE release_id = '${releaseId}'`,
        `DELETE FROM factor_releases WHERE id = '${releaseId}'`,
      ]),
    ).toEqual(['TA010', 'TA010']);
  });

  it('refuses a seal or withdrawal by a session that is neither the loader nor the owner, whatever it was granted (TA013)', async () => {
    const { releaseId } = await owner.emissionFactor.findFirstOrThrow({ where: { release: { status: 'placeholder' } } });
    const columns = '"sealed_at", "status", "withdrawn_at", "withdrawn_by", "withdrawal_reason"';
    // A grant committed for this test alone — the runtime holds none — and
    // revoked whatever happens; `runtime-role.int.spec` would report it.
    await owner.$executeRawUnsafe(`GRANT UPDATE (${columns}) ON factor_releases TO tonyai_runtime`);
    try {
      expect(await outcomes(runtime, [], [withdraw(releaseId)])).toEqual(['TA013']);
    } finally {
      await owner.$executeRawUnsafe(`REVOKE UPDATE (${columns}) ON factor_releases FROM tonyai_runtime`);
    }
    // Positive control: the grant was the only barrier left, and it is gone.
    expect(await outcomes(runtime, [], [withdraw(releaseId)])).toEqual(['42501']);
  });
});
