import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityRecordStatus, Prisma } from '@tonyai/db';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { connect, connectOwner, createRecord, createTenant, recordInput, type Tenant } from './db';
import { lifecycleServices } from './services';

/**
 * inc28-fuel-bulk PR A (tasks 3.3, 3.4): the database rules of the fuel
 * tables and of a batch's records, against the real schema, written as the
 * API's runtime role would write them — no fuel service exists yet.
 *
 *  - the slot key widened by the batch (D2), TA002 untouched and slot-wide;
 *  - the live-row dedupe index (D5), also under two concurrent writers and
 *    after a withdrawal;
 *  - the composite keys: a row's batch is of its account and company, a
 *    record's batch of its company, every link inside one organisation;
 *  - TA028 (a record's batch is fixed) and TA019 (no record for an associate);
 *  - TA029 (D9, the earlier image): without the batch's declaration a status
 *    change, an edit, a delete and an insert of a batch's record are refused
 *    and nothing changes; a void and a period lock pass; a manual record is
 *    untouched; with the declaration the batch step passes.
 */

let runtime: PrismaService;
let second: PrismaService;
let owner: PrismaService;
let tenant: Tenant;

beforeAll(() => {
  runtime = connect(3);
  second = connect();
  owner = connectOwner();
});

afterAll(async () => {
  await Promise.all([runtime, second, owner].map((c) => c.$disconnect()));
});

beforeEach(async () => {
  tenant = await createTenant();
});

afterEach(async () => {
  await tenant.cleanup();
});

function sqlstate(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2010') return String((e.meta as { code?: unknown } | undefined)?.code ?? '');
    if (e.code === 'P2003') return '23503';
    if (e.code === 'P2002') return '23505';
    return e.code;
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    return /PostgresError \{ code: "([0-9A-Z]{5})"/.exec(e.message)?.[1] ?? null;
  }
  return null;
}

async function refused(write: Promise<unknown>): Promise<{ state: string | null; message: string }> {
  try {
    await write;
  } catch (e) {
    return { state: sqlstate(e), message: (e as Error).message };
  }
  throw new Error('expected the database to refuse this write');
}

const digest = (key: string) => createHash('sha256').update(key).digest('hex');

/** A confirmed Petrol Ofisi account of `subsidiaryId`, written as the runtime role. */
async function account(subsidiaryId: string, code = `PO-${randomUUID().slice(0, 6)}`, organisationId = tenant.organisationId) {
  return runtime.fuelAccount.create({
    data: {
      organisationId,
      source: 'petrol_ofisi',
      code,
      name: `Int fleet ${code}`,
      subsidiaryId,
      state: 'confirmed',
      confirmedBy: tenant.users.masterkey.id,
      confirmedAt: new Date(),
      createdBy: tenant.users.masterkey.id,
    },
  });
}

/** A fuel import: no file kept, no company named (C19). */
async function fuelImport(organisationId = tenant.organisationId, source = 'petrol_ofisi') {
  return runtime.importBatch.create({
    data: {
      organisationId,
      uploadedBy: tenant.users.masterkey.id,
      subsidiaryIds: [],
      fileName: 'SatisListesi.xlsx',
      fileFormat: 'xlsx',
      sizeBytes: 1024,
      sha256: digest(randomUUID()),
      status: 'completed',
      totalRows: 1,
      source,
    },
  });
}

async function batch(
  subsidiaryId: string,
  fuelAccountId: string,
  invoiceRef = 'OZK2025000011923',
  sequence = 1,
  organisationId = tenant.organisationId,
) {
  return runtime.fuelBatch.create({
    data: {
      organisationId,
      subsidiaryId,
      fuelAccountId,
      source: 'petrol_ofisi',
      invoiceRef,
      sequence,
      usage: 'on_road',
      category: 'Mobile Combustion',
      createdBy: tenant.users.masterkey.id,
    },
  });
}

function rowData(
  importBatchId: string,
  fuelAccountId: string,
  data: Partial<Prisma.FuelRowUncheckedCreateInput> = {},
): Prisma.FuelRowUncheckedCreateInput {
  return {
    organisationId: tenant.organisationId,
    importBatchId,
    holderId: tenant.users.masterkey.id,
    source: 'petrol_ofisi',
    dedupeDigest: digest(`petrol_ofisi|${randomUUID()}`),
    fuelAccountId,
    rawFuel: 'Motorin Med',
    fuel: 'diesel',
    usage: 'on_road',
    litres: new Prisma.Decimal('31.860'),
    transactionAt: new Date('2025-03-14T10:00:00Z'),
    year: 2025,
    month: 3,
    invoiceRef: 'OZK2025000011923',
    fileRow: 2,
    state: 'ready',
    subsidiaryId: tenant.subsidiaryId,
    ...data,
  };
}

/** A Mobile Combustion record of March 2025, on-road diesel, at company level. */
const mobile = (data: Partial<Prisma.ActivityRecordUncheckedCreateInput> = {}) =>
  recordInput(tenant, {
    reportingYear: 2025,
    periodValue: 'March',
    category: 'Mobile Combustion',
    activityType: 'on_road_diesel',
    activityUnit: 'litres',
    activityValue: 31.86,
    createdBy: tenant.users.masterkey.id,
    ...data,
  });

/** Declares `batchId` for this transaction, as the batch service will (D9): `<batch id>:<transaction id>`. */
const declare = (tx: Prisma.TransactionClient, batchId: string) =>
  tx.$queryRaw`SELECT set_config('tonyai.fuel_batch_step', ${batchId}::text || ':' || pg_current_xact_id()::text, true)`;

/** A write inside a step that declares `batchId`. */
function inStep<T>(client: PrismaService, batchId: string, write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return client.$transaction(async (tx) => {
    await declare(tx, batchId);
    return write(tx);
  });
}

/** A batch's record, inserted inside its step. */
const batchRecord = (batchId: string, data: Partial<Prisma.ActivityRecordUncheckedCreateInput> = {}) =>
  inStep(runtime, batchId, (tx) => tx.activityRecord.create({ data: mobile({ fuelBatchId: batchId, ...data }) }));

describe('the slot key gains the batch (D2)', () => {
  it('lets two batches hold a record of one slot and type, and a manual record beside them', async () => {
    const acc = await account(tenant.subsidiaryId);
    const first = await batch(tenant.subsidiaryId, acc.id, '2025-INV-1');
    const further = await batch(tenant.subsidiaryId, acc.id, '2025-INV-2');
    await batchRecord(first.id);
    await batchRecord(further.id);
    await runtime.activityRecord.create({ data: mobile() });
    expect(await runtime.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(3);
  });

  it('still refuses a second manual record of the slot', async () => {
    await runtime.activityRecord.create({ data: mobile() });
    expect(await refused(runtime.activityRecord.create({ data: mobile() }))).toMatchObject({ state: '23505' });
  });

  it('still refuses a second record of one batch in one slot and type', async () => {
    const acc = await account(tenant.subsidiaryId);
    const b = await batch(tenant.subsidiaryId, acc.id);
    await batchRecord(b.id);
    expect(await refused(batchRecord(b.id))).toMatchObject({ state: '23505' });
  });

  it('keeps TA002 slot-wide across manual and batch records, in both orders', async () => {
    const acc = await account(tenant.subsidiaryId);
    const b = await batch(tenant.subsidiaryId, acc.id);
    // An untyped manual record first, then a typed batch record.
    const untyped = await runtime.activityRecord.create({ data: mobile({ activityType: null }) });
    expect(await refused(batchRecord(b.id))).toMatchObject({ state: 'TA002' });
    await owner.activityRecord.delete({ where: { id: untyped.id } });
    // A typed batch record first, then an untyped manual record.
    await batchRecord(b.id);
    expect(await refused(runtime.activityRecord.create({ data: mobile({ activityType: null }) }))).toMatchObject({
      state: 'TA002',
    });
  });

  it('refuses an untyped or non-fuel record in a batch, so the slot keeps one untyped record (fuel_batch_typed_check)', async () => {
    const acc = await account(tenant.subsidiaryId);
    const first = await batch(tenant.subsidiaryId, acc.id, 'INV-U1');
    const second = await batch(tenant.subsidiaryId, acc.id, 'INV-U2');
    await runtime.activityRecord.create({ data: mobile({ activityType: null }) });
    for (const b of [first, second]) {
      expect(await refused(batchRecord(b.id, { activityType: null }))).toMatchObject({ state: '23514' });
    }
    expect(
      await refused(batchRecord(first.id, { category: 'Electricity', activityType: 'grid', activityUnit: 'kWh' })),
    ).toMatchObject({ state: '23514' });
    expect(await owner.activityRecord.count({ where: { subsidiaryId: tenant.subsidiaryId } })).toBe(1);
  });

  it('still refuses any record for an associate, a batch’s included (TA019)', async () => {
    const associate = await owner.subsidiary.create({
      data: {
        organisationId: tenant.organisationId,
        legalName: 'Int-test associate',
        geographyCode: 'UK',
        nodeType: 'company',
        parentId: tenant.subsidiaryId,
        control: 'associate',
      },
    });
    const acc = await account(associate.id);
    const b = await batch(associate.id, acc.id);
    expect(await refused(batchRecord(b.id, { subsidiaryId: associate.id }))).toMatchObject({ state: 'TA019' });
  });
});

describe('the live-row dedupe index (D5)', () => {
  it('stores a key once among live rows, also for two writers at the same moment', async () => {
    const acc = await account(tenant.subsidiaryId);
    const imp = await fuelImport();
    const key = digest('petrol_ofisi|SATIS-0001');
    const results = await Promise.allSettled([
      runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { dedupeDigest: key }) }),
      second.fuelRow.create({ data: rowData(imp.id, acc.id, { dedupeDigest: key, fileRow: 3 }) }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(sqlstate(loser.reason)).toBe('23505');
    // An insert that skips conflicts, as the upload's will, stores nothing more.
    const skipped = await runtime.fuelRow.createMany({
      data: [rowData(imp.id, acc.id, { dedupeDigest: key, fileRow: 4 })],
      skipDuplicates: true,
    });
    expect(skipped.count).toBe(0);
    expect(await runtime.fuelRow.count({ where: { dedupeDigest: key } })).toBe(1);
  });

  it('frees a withdrawn row’s key for the row that replaces it', async () => {
    const acc = await account(tenant.subsidiaryId);
    const imp = await fuelImport();
    const key = digest('petrol_ofisi|SATIS-0002');
    const withdrawn = await runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { dedupeDigest: key }) });
    await runtime.fuelRow.update({
      where: { id: withdrawn.id },
      data: {
        state: 'withdrawn',
        withdrawnState: 'ready',
        withdrawnBy: tenant.users.masterkey.id,
        withdrawnAt: new Date(),
        withdrawnReason: 'Wrong file',
      },
    });
    const again = await fuelImport();
    const replacing = await runtime.fuelRow.create({
      data: rowData(again.id, acc.id, { dedupeDigest: key, replacesId: withdrawn.id }),
    });
    expect(replacing.replacesId).toBe(withdrawn.id);
    expect(await runtime.fuelRow.count({ where: { dedupeDigest: key } })).toBe(2);
    expect(await refused(runtime.fuelRow.create({ data: rowData(again.id, acc.id, { dedupeDigest: key }) }))).toMatchObject({
      state: '23505',
    });
  });

  it('keeps the litres the file gives, every digit (fuel-file-upload: a quantity keeps its precision)', async () => {
    const acc = await account(tenant.subsidiaryId);
    const imp = await fuelImport();
    for (const litres of ['1.2345', '0.0004', '1168.123456789', '15973.75']) {
      const row = await runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { litres: new Prisma.Decimal(litres) }) });
      const [stored] = await runtime.$queryRaw<{ litres: string }[]>`SELECT litres::text AS litres FROM fuel_rows WHERE id = ${row.id}::uuid`;
      expect(stored!.litres, litres).toBe(litres);
      expect((await runtime.fuelRow.findUniqueOrThrow({ where: { id: row.id } })).litres.toString(), litres).toBe(litres);
    }
    // Their sum, as the database adds it, is exact.
    const [sum] = await runtime.$queryRaw<{ total: string }[]>`SELECT sum(litres)::text AS total FROM fuel_rows WHERE import_batch_id = ${imp.id}::uuid`;
    expect(sum!.total).toBe('17143.108356789');
  });

  it('keeps one organisation’s key apart from another’s: both rows stand', async () => {
    const foreign = await createTenant();
    try {
      const key = digest('petrol_ofisi|SATIS-SHARED');
      const acc = await account(tenant.subsidiaryId);
      const imp = await fuelImport();
      await runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { dedupeDigest: key }) });
      const foreignAcc = await account(foreign.subsidiaryId, 'PO-F', foreign.organisationId);
      const foreignImp = await fuelImport(foreign.organisationId);
      await runtime.fuelRow.create({
        data: rowData(foreignImp.id, foreignAcc.id, {
          organisationId: foreign.organisationId,
          subsidiaryId: foreign.subsidiaryId,
          dedupeDigest: key,
        }),
      });
      expect(await owner.fuelRow.count({ where: { dedupeDigest: key } })).toBe(2);
    } finally {
      await foreign.cleanup();
    }
  });

  it('keeps one key per organisation and source apart from another source’s', async () => {
    const acc = await account(tenant.subsidiaryId);
    const imp = await fuelImport();
    const key = digest('same');
    await runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { dedupeDigest: key }) });
    const shell = await runtime.fuelAccount.create({
      data: {
        organisationId: tenant.organisationId,
        source: 'shell',
        code: 'SH-1',
        name: 'Int Shell',
        createdBy: tenant.users.masterkey.id,
      },
    });
    const shellImport = await fuelImport(tenant.organisationId, 'shell');
    await runtime.fuelRow.create({
      data: rowData(shellImport.id, shell.id, {
        source: 'shell',
        dedupeDigest: key,
        invoiceRef: '2025-03-1',
        state: 'waiting_account',
        subsidiaryId: null,
      }),
    });
    expect(await runtime.fuelRow.count({ where: { dedupeDigest: key } })).toBe(2);
  });
});

describe('the composite keys hold a chain in one company and one organisation (D1)', () => {
  it('refuses a row linked to a batch of another account or another company', async () => {
    const acc = await account(tenant.subsidiaryId);
    const otherAcc = await account(tenant.otherSubsidiaryId);
    const imp = await fuelImport();
    const b = await batch(tenant.subsidiaryId, acc.id);
    const assigned = { state: 'assigned', fuelBatchId: b.id };
    // Its own account and company: stands.
    await runtime.fuelRow.create({ data: rowData(imp.id, acc.id, assigned) });
    // Another account's row in this batch.
    expect(
      await refused(
        runtime.fuelRow.create({ data: rowData(imp.id, otherAcc.id, { ...assigned, subsidiaryId: tenant.subsidiaryId }) }),
      ),
    ).toMatchObject({ state: '23503' });
    // This account's row under another company in this batch.
    expect(
      await refused(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { ...assigned, subsidiaryId: tenant.otherSubsidiaryId }) })),
    ).toMatchObject({ state: '23503' });
    // A record of the batch in another company.
    expect(await refused(batchRecord(b.id, { subsidiaryId: tenant.otherSubsidiaryId }))).toMatchObject({ state: '23503' });
  });

  it('refuses every link across organisations', async () => {
    const foreign = await createTenant();
    try {
      const acc = await account(tenant.subsidiaryId);
      const foreignAcc = await account(foreign.subsidiaryId, 'PO-FOREIGN', foreign.organisationId);
      const imp = await fuelImport();
      const foreignImp = await fuelImport(foreign.organisationId);
      // An account mapped to another organisation's company.
      expect(await refused(account(foreign.subsidiaryId))).toMatchObject({ state: '23503' });
      // A batch of another organisation's account, or company.
      expect(await refused(batch(tenant.subsidiaryId, foreignAcc.id))).toMatchObject({ state: '23503' });
      expect(await refused(batch(foreign.subsidiaryId, acc.id))).toMatchObject({ state: '23503' });
      // A row of another organisation's import, account or company.
      expect(await refused(runtime.fuelRow.create({ data: rowData(foreignImp.id, acc.id) }))).toMatchObject({ state: '23503' });
      expect(
        await refused(runtime.fuelRow.create({ data: rowData(imp.id, foreignAcc.id, { subsidiaryId: null, state: 'waiting_account' }) })),
      ).toMatchObject({ state: '23503' });
      expect(
        await refused(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { subsidiaryId: foreign.subsidiaryId }) })),
      ).toMatchObject({ state: '23503' });
      // A record of another organisation's batch.
      const foreignBatch = await batch(foreign.subsidiaryId, foreignAcc.id, 'X-1', 1, foreign.organisationId);
      expect(await refused(batchRecord(foreignBatch.id))).toMatchObject({ state: '23503' });
    } finally {
      await foreign.cleanup();
    }
  });

  it('refuses a row whose columns do not fit its state', async () => {
    const acc = await account(tenant.subsidiaryId);
    const imp = await fuelImport();
    for (const data of [
      { state: 'ready', fuel: null },
      { state: 'assigned' },
      { state: 'held' },
      { state: 'held', holdReason: 'a reason no one wrote' },
      { state: 'waiting_account' },
      { state: 'withdrawn' },
      { year: 2024 },
      { litres: new Prisma.Decimal(0) },
    ] satisfies Partial<Prisma.FuelRowUncheckedCreateInput>[]) {
      expect(await refused(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, data) })), JSON.stringify(data)).toMatchObject({
        state: '23514',
      });
    }
  });
});

describe('the CHECKs and keys of each table (D1, D4, D8)', () => {
  const check = async (write: Promise<unknown>, what: string) =>
    expect(await refused(write), what).toMatchObject({ state: '23514' });
  const key = async (write: Promise<unknown>, what: string) =>
    expect(await refused(write), what).toMatchObject({ state: '23503' });
  const accountData = (data: Partial<Prisma.FuelAccountUncheckedCreateInput>): Prisma.FuelAccountUncheckedCreateInput => ({
    organisationId: tenant.organisationId,
    source: 'petrol_ofisi',
    code: `C-${randomUUID().slice(0, 6)}`,
    name: 'x',
    createdBy: tenant.users.masterkey.id,
    ...data,
  });

  it('holds an account’s source, code and mapping state', async () => {
    const now = new Date();
    const by = tenant.users.masterkey.id;
    await check(runtime.fuelAccount.create({ data: accountData({ source: 'bp' }) }), 'unknown source');
    await check(runtime.fuelAccount.create({ data: accountData({ code: '' }) }), 'empty code');
    await check(runtime.fuelAccount.create({ data: accountData({ subsidiaryId: tenant.subsidiaryId }) }), 'unmatched with a company');
    await check(runtime.fuelAccount.create({ data: accountData({ state: 'proposed' }) }), 'proposed with no company');
    await check(
      runtime.fuelAccount.create({ data: accountData({ state: 'proposed', subsidiaryId: tenant.subsidiaryId, confirmedBy: by, confirmedAt: now }) }),
      'proposed and confirmed',
    );
    await check(runtime.fuelAccount.create({ data: accountData({ state: 'confirmed', subsidiaryId: tenant.subsidiaryId }) }), 'confirmed by nobody');
    await check(runtime.fuelAccount.create({ data: accountData({ state: 'mapped' }) }), 'unknown state');
  });

  it('holds what an import is: a fuel import keeps no file and names no company (C19)', async () => {
    const base = await fuelImport();
    const data = { ...(await owner.importBatch.findUniqueOrThrow({ where: { id: base.id } })), id: undefined, sha256: digest('x') };
    const { id: _id, createdAt: _c, updatedAt: _u, ...row } = data;
    void _id;
    void _c;
    void _u;
    await check(runtime.importBatch.create({ data: { ...row, source: 'csv' } }), 'unknown source');
    await check(runtime.importBatch.create({ data: { ...row, storagePath: `import-sources/${randomUUID()}` } }), 'a kept file');
    await check(runtime.importBatch.create({ data: { ...row, subsidiaryIds: [tenant.subsidiaryId] } }), 'a named company');
  });

  it('holds a batch’s vocabularies, category by usage, Shell half-month, submission and withdrawal', async () => {
    const acc = await account(tenant.subsidiaryId);
    const shellAcc = await runtime.fuelAccount.create({
      data: accountData({ source: 'shell', state: 'confirmed', subsidiaryId: tenant.subsidiaryId, confirmedBy: tenant.users.masterkey.id, confirmedAt: new Date() }),
    });
    const base = {
      organisationId: tenant.organisationId,
      subsidiaryId: tenant.subsidiaryId,
      fuelAccountId: acc.id,
      source: 'petrol_ofisi',
      invoiceRef: 'INV-C',
      sequence: 1,
      usage: 'on_road',
      category: 'Mobile Combustion',
      createdBy: tenant.users.masterkey.id,
    };
    const by = tenant.users.masterkey.id;
    for (const [what, data] of [
      ['stationary as Mobile Combustion', { usage: 'stationary' }],
      ['on-road as Fuel', { category: 'Fuel' }],
      ['an unknown usage', { usage: 'marine' }],
      ['an unknown status', { status: 'cancelled' }],
      ['sequence 0', { sequence: 0 }],
      ['an empty invoice', { invoiceRef: '' }],
      ['an invoice over 64 characters', { invoiceRef: 'x'.repeat(65) }],
      ['submitted with no submission', { status: 'submitted' }],
      ['approved with no submission', { status: 'approved', submittedAt: new Date() }],
      ['withdrawn with no reason', { status: 'withdrawn', withdrawnBy: by, withdrawnAt: new Date() }],
      ['withdrawn with a blank reason', { status: 'withdrawn', withdrawnBy: by, withdrawnAt: new Date(), withdrawnReason: '  ' }],
      ['a draft carrying a withdrawal', { withdrawnBy: by, withdrawnAt: new Date(), withdrawnReason: 'x' }],
    ] as const) {
      await check(runtime.fuelBatch.create({ data: { ...base, ...data } }), what);
    }
    await check(
      runtime.fuelBatch.create({ data: { ...base, fuelAccountId: shellAcc.id, source: 'shell', invoiceRef: 'OZK0000000000001' } }),
      'a Shell invoice that is no half-month',
    );
    await runtime.fuelBatch.create({ data: { ...base, fuelAccountId: shellAcc.id, source: 'shell', invoiceRef: '2025-03-2' } });
    await key(runtime.fuelBatch.create({ data: { ...base, source: 'shell', invoiceRef: '2025-03-1' } }), 'a source not its account’s');
  });

  it('puts a Shell row in its transaction date’s half-month: day 15 the first, day 16 and the last day the second', async () => {
    const shellAcc = await runtime.fuelAccount.create({
      data: accountData({ source: 'shell', state: 'confirmed', subsidiaryId: tenant.subsidiaryId, confirmedBy: tenant.users.masterkey.id, confirmedAt: new Date() }),
    });
    const imp = await fuelImport(tenant.organisationId, 'shell');
    const shellRow = (day: number, invoiceRef: string, hour = 12) =>
      runtime.fuelRow.create({
        data: rowData(imp.id, shellAcc.id, {
          source: 'shell',
          transactionAt: new Date(Date.UTC(2025, 2, day, hour, 50)),
          invoiceRef,
        }),
      });
    await shellRow(15, '2025-03-1', 23);
    await check(shellRow(15, '2025-03-2'), 'day 15 in the second half');
    await shellRow(16, '2025-03-2', 0);
    await check(shellRow(16, '2025-03-1'), 'day 16 in the first half');
    await shellRow(31, '2025-03-2', 23);
    await check(shellRow(31, '2025-04-1'), 'the 31st in another month');
  });

  it('holds a row’s shape by source and its columns by state', async () => {
    const acc = await account(tenant.subsidiaryId);
    const imp = await fuelImport();
    const tankerAcc = await runtime.fuelAccount.create({
      data: accountData({ source: 'tanker', code: 'ÖRNEK DEPO A.Ş.', state: 'confirmed', subsidiaryId: tenant.subsidiaryId, confirmedBy: tenant.users.masterkey.id, confirmedAt: new Date() }),
    });
    const tankerImp = await fuelImport(tenant.organisationId, 'tanker');
    const tanker = (data: Partial<Prisma.FuelRowUncheckedCreateInput>) =>
      runtime.fuelRow.create({
        data: rowData(tankerImp.id, tankerAcc.id, { source: 'tanker', transactionAt: null, rawFuel: null, invoiceRef: '000101', ...data }),
      });
    await tanker({});
    await check(tanker({ dedupeDigest: digest('t2'), transactionAt: new Date('2025-03-01T00:00:00Z') }), 'a tanker row with a date');
    await check(tanker({ dedupeDigest: digest('t3'), rawFuel: 'Motorin' }), 'a tanker row with a raw name');
    await check(tanker({ dedupeDigest: digest('t4'), fuel: null, state: 'waiting_fuel' }), 'a tanker row with no fuel');
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { rawFuel: null }) }), 'a card row with no raw name');
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { transactionAt: null }) }), 'a card row with no date');
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { month: 13 }) }), 'month 13');
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { dedupeDigest: 'ABC' }) }), 'a digest that is no sha256');
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { fuel: 'lpg' }) }), 'a fuel no file names');
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { usage: 'marine' }) }), 'an unknown usage');
    const b = await batch(tenant.subsidiaryId, acc.id);
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { state: 'excluded', fuelBatchId: b.id }) }), 'an excluded row in a batch');
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { state: 'excluded', holdReason: 'period_locked' }) }), 'an excluded row with a hold');
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { state: 'waiting_fuel' }) }), 'waiting for a fuel it has');
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { state: 'ready', holdReason: 'period_locked' }) }), 'ready with a hold');
    await check(
      runtime.fuelRow.create({
        data: rowData(imp.id, acc.id, { state: 'withdrawn', withdrawnState: 'withdrawn', withdrawnBy: tenant.users.masterkey.id, withdrawnAt: new Date(), withdrawnReason: 'x' }),
      }),
      'withdrawn from withdrawn',
    );
    await check(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { withdrawnReason: 'x' }) }), 'a live row carrying a withdrawal');
  });

  it('keeps a row’s source its import’s and its account’s, its invoice its batch’s, and its replacement in the organisation', async () => {
    const acc = await account(tenant.subsidiaryId);
    const imp = await fuelImport();
    const shellImp = await fuelImport(tenant.organisationId, 'shell');
    await key(runtime.fuelRow.create({ data: rowData(shellImp.id, acc.id) }), 'a Petrol Ofisi row in a Shell import');
    await key(
      runtime.fuelRow.create({ data: rowData(shellImp.id, acc.id, { source: 'shell', invoiceRef: '2025-03-1' }) }),
      'a Shell row of a Petrol Ofisi account',
    );
    const b = await batch(tenant.subsidiaryId, acc.id, 'INV-ONE');
    await runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { state: 'assigned', fuelBatchId: b.id, invoiceRef: 'INV-ONE' }) });
    await key(
      runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { state: 'assigned', fuelBatchId: b.id, invoiceRef: 'INV-TWO' }) }),
      'a row of another invoice in the batch',
    );
    // The import's source is fixed once rows name it.
    await key(runtime.importBatch.update({ where: { id: imp.id }, data: { source: 'template' } }), 'a fuel import turned template');
    const foreign = await createTenant();
    try {
      const foreignAcc = await account(foreign.subsidiaryId, 'PO-R', foreign.organisationId);
      const foreignImp = await fuelImport(foreign.organisationId);
      const foreignRow = await runtime.fuelRow.create({
        data: rowData(foreignImp.id, foreignAcc.id, { organisationId: foreign.organisationId, subsidiaryId: foreign.subsidiaryId }),
      });
      await key(runtime.fuelRow.create({ data: rowData(imp.id, acc.id, { replacesId: foreignRow.id }) }), 'replacing another organisation’s row');
    } finally {
      await foreign.cleanup();
    }
  });
});

describe('TA028: a record’s batch is fixed after insert', () => {
  it('refuses moving a record into, out of or between batches, even inside a step', async () => {
    const acc = await account(tenant.subsidiaryId);
    const b = await batch(tenant.subsidiaryId, acc.id, 'INV-A');
    const other = await batch(tenant.subsidiaryId, acc.id, 'INV-B');
    const manual = await runtime.activityRecord.create({ data: mobile() });
    const inBatch = await batchRecord(b.id, { activityType: 'on_road_petrol' });
    expect(
      await refused(inStep(runtime, b.id, (tx) => tx.activityRecord.update({ where: { id: manual.id }, data: { fuelBatchId: b.id } }))),
    ).toMatchObject({ state: 'TA028' });
    expect(
      await refused(inStep(runtime, b.id, (tx) => tx.activityRecord.update({ where: { id: inBatch.id }, data: { fuelBatchId: null } }))),
    ).toMatchObject({ state: 'TA028' });
    expect(
      await refused(
        inStep(runtime, b.id, (tx) => tx.activityRecord.update({ where: { id: inBatch.id }, data: { fuelBatchId: other.id } })),
      ),
    ).toMatchObject({ state: 'TA028' });
  });
});

describe('TA029: a batch’s record is written only inside a step of that batch (D9)', () => {
  /** A batch with one draft record, and the record's figure as stored. */
  async function draftBatch() {
    const acc = await account(tenant.subsidiaryId);
    const b = await batch(tenant.subsidiaryId, acc.id);
    const record = await batchRecord(b.id);
    return { batch: b, record };
  }

  const snapshot = (id: string) => owner.activityRecord.findUniqueOrThrow({ where: { id } });

  it('refuses the earlier image’s status change, edit, delete and insert, and changes nothing', async () => {
    const { batch: b, record } = await draftBatch();
    const before = await snapshot(record.id);
    const total = () => owner.activityRecord.aggregate({ _sum: { activityValue: true }, where: { subsidiaryId: tenant.subsidiaryId } });
    const totalBefore = await total();
    for (const [what, write] of [
      ['submit', runtime.activityRecord.update({ where: { id: record.id }, data: { status: ActivityRecordStatus.submitted, submittedAt: new Date(), submissionCount: 1 } })],
      ['edit', runtime.activityRecord.update({ where: { id: record.id }, data: { activityValue: 99 } })],
      ['delete', runtime.activityRecord.delete({ where: { id: record.id } })],
      ['insert', runtime.activityRecord.create({ data: mobile({ fuelBatchId: b.id, activityType: 'on_road_petrol' }) })],
    ] as const) {
      const r = await refused(write);
      expect(r.state, what).toBe('TA029');
      expect(r.message, what).toMatch(/record_in_batch/);
    }
    expect(await snapshot(record.id)).toEqual(before);
    expect(await total()).toEqual(totalBefore);
    expect(await owner.activityRecord.count({ where: { fuelBatchId: b.id } })).toBe(1);
  });

  it('refuses a step that declared another batch', async () => {
    const { record } = await draftBatch();
    const acc = await account(tenant.subsidiaryId);
    const other = await batch(tenant.subsidiaryId, acc.id, 'OTHER');
    expect(
      await refused(inStep(runtime, other.id, (tx) => tx.activityRecord.update({ where: { id: record.id }, data: { activityValue: 1 } }))),
    ).toMatchObject({ state: 'TA029' });
  });

  it('lets a step that declared the batch move, edit and delete its records', async () => {
    const { batch: b, record } = await draftBatch();
    const submitted = await inStep(runtime, b.id, (tx) =>
      tx.activityRecord.update({
        where: { id: record.id },
        data: { status: ActivityRecordStatus.submitted, submittedAt: new Date(), submissionCount: 1 },
      }),
    );
    expect(submitted.status).toBe(ActivityRecordStatus.submitted);
    // The declaration is the transaction's own: the next transaction has none.
    expect(await refused(runtime.activityRecord.update({ where: { id: record.id }, data: { reviewNote: 'x' } }))).toMatchObject({
      state: 'TA029',
    });
    await inStep(runtime, b.id, (tx) => tx.activityRecord.update({ where: { id: record.id }, data: { status: ActivityRecordStatus.draft, submittedAt: null } }));
    await inStep(runtime, b.id, (tx) => tx.activityRecord.delete({ where: { id: record.id } }));
    expect(await owner.activityRecord.count({ where: { fuelBatchId: b.id } })).toBe(0);
  });

  it('lets the period lock flip and the masterkey’s void through, as today’s services write them', async () => {
    const { batch: b, record } = await draftBatch();
    await inStep(runtime, b.id, async (tx) => {
      await tx.activityRecord.update({ where: { id: record.id }, data: { status: ActivityRecordStatus.submitted, submittedAt: new Date(), submissionCount: 1 } });
      await tx.activityRecord.update({ where: { id: record.id }, data: { status: ActivityRecordStatus.approved, reviewedBy: tenant.users.masterkey.id, reviewedAt: new Date() } });
    });
    const { periodLocks, records } = lifecycleServices(runtime);
    const lock = await periodLocks.lock(tenant.users.masterkey, {
      subsidiaryId: tenant.subsidiaryId,
      reportingYear: 2025,
      reportingPeriod: 'monthly',
      periodValue: 'March',
    });
    expect((await snapshot(record.id)).status).toBe(ActivityRecordStatus.locked);
    await periodLocks.unlock(tenant.users.masterkey, lock.id);
    expect((await snapshot(record.id)).status).toBe(ActivityRecordStatus.approved);
    const voided = await records.void(tenant.users.masterkey, record.id, 'Restated by the masterkey');
    expect(voided.status).toBe(ActivityRecordStatus.voided);
  });

  /** A batch whose one record is approved, as its steps would leave it. */
  async function approvedBatch() {
    const { batch: b, record } = await draftBatch();
    await inStep(runtime, b.id, async (tx) => {
      await tx.activityRecord.update({ where: { id: record.id }, data: { status: ActivityRecordStatus.submitted, submittedAt: new Date(), submissionCount: 1 } });
      await tx.activityRecord.update({ where: { id: record.id }, data: { status: ActivityRecordStatus.approved } });
    });
    return { batch: b, record };
  }

  it('refuses a void that changes another column too', async () => {
    const { record } = await approvedBatch();
    const voiding = { status: ActivityRecordStatus.voided, voidReason: 'x', voidedBy: tenant.users.masterkey.id, voidedAt: new Date() };
    for (const extra of [{ reviewNote: 'smuggled' }, { anomalyFlag: true }, { varianceReason: 'smuggled' }, { activityValue: 1 }]) {
      expect(
        await refused(runtime.activityRecord.update({ where: { id: record.id }, data: { ...voiding, ...extra } })),
        JSON.stringify(extra),
      ).toMatchObject({ state: 'TA029' });
    }
    expect((await snapshot(record.id)).status).toBe(ActivityRecordStatus.approved);
  });

  it('refuses a period lock’s flip that changes another column too, either way', async () => {
    const { batch: b, record } = await approvedBatch();
    for (const extra of [{ reviewNote: 'smuggled' }, { anomalyFlag: true }, { voidReason: 'smuggled' }]) {
      expect(
        await refused(runtime.activityRecord.update({ where: { id: record.id }, data: { status: ActivityRecordStatus.locked, ...extra } })),
        JSON.stringify(extra),
      ).toMatchObject({ state: 'TA029' });
    }
    await runtime.activityRecord.update({ where: { id: record.id }, data: { status: ActivityRecordStatus.locked } });
    expect(
      await refused(
        runtime.activityRecord.update({ where: { id: record.id }, data: { status: ActivityRecordStatus.approved, reviewNote: 'smuggled' } }),
      ),
    ).toMatchObject({ state: 'TA029' });
    // Not a lock's flip: locked to draft, even inside a step of another batch.
    expect(
      await refused(inStep(runtime, randomUUID(), (tx) => tx.activityRecord.update({ where: { id: record.id }, data: { status: ActivityRecordStatus.draft } }))),
    ).toMatchObject({ state: 'TA029' });
    expect((await snapshot(record.id)).status).toBe(ActivityRecordStatus.locked);
    void b;
  });

  it('refuses the earlier image’s own service paths on a batch’s record, and nothing changes', async () => {
    const { record } = await draftBatch();
    const before = await snapshot(record.id);
    const { records } = lifecycleServices(runtime);
    const author = tenant.users.masterkey;
    for (const [what, call] of [
      ['edit', () => records.update(author, record.id, { activityValue: 77 })],
      ['delete', () => records.remove(author, record.id)],
      ['submit', () => records.submit(author, record.id)],
    ] as const) {
      await expect(call(), what).rejects.toBeDefined();
    }
    expect(await snapshot(record.id)).toEqual(before);
  });

  it('refuses a declaration written for the whole session, and one of another transaction', async () => {
    const { batch: b, record } = await draftBatch();
    try {
      // A slip: `is_local` false. The declaration outlives its transaction but
      // names that transaction, so the next one is refused.
      await second.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('tonyai.fuel_batch_step', ${b.id}::text || ':' || pg_current_xact_id()::text, false)`;
      });
      expect(await refused(second.activityRecord.update({ where: { id: record.id }, data: { reviewNote: 'x' } }))).toMatchObject({
        state: 'TA029',
      });
      // The batch's id alone, as a declaration without its transaction.
      expect(
        await refused(
          second.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT set_config('tonyai.fuel_batch_step', ${b.id}, true)`;
            return tx.activityRecord.update({ where: { id: record.id }, data: { reviewNote: 'x' } });
          }),
        ),
      ).toMatchObject({ state: 'TA029' });
    } finally {
      await second.$queryRaw`SELECT set_config('tonyai.fuel_batch_step', '', false)`;
    }
  });

  it('leaves a manual record to today’s lifecycle', async () => {
    const manual = await createRecord(runtime, tenant, { createdBy: tenant.users.standardUser.id });
    const { records } = lifecycleServices(runtime);
    const edited = await records.update(tenant.users.standardUser, manual.id, { activityValue: 250 });
    expect(edited.activityValue).toBe(250);
    await records.remove(tenant.users.standardUser, manual.id);
    expect(await owner.activityRecord.count({ where: { id: manual.id } })).toBe(0);
  });

  it('lets the runtime role declare a batch for its own transaction only', async () => {
    const id = randomUUID();
    const [inside] = await runtime.$transaction(async (tx) => {
      await declare(tx, id);
      return tx.$queryRaw<{ v: string; xid: string }[]>`SELECT current_setting('tonyai.fuel_batch_step', true) AS v, pg_current_xact_id()::text AS xid`;
    });
    expect(inside.v).toBe(`${id}:${inside.xid}`);
    const [after] = await runtime.$queryRaw<{ v: string | null }[]>`SELECT nullif(current_setting('tonyai.fuel_batch_step', true), '') AS v`;
    expect(after.v).toBeNull();
  });
});
