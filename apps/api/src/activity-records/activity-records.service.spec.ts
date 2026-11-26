import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ActivityRecordStatus, Prisma, type ActivityRecord, type Subsidiary } from '@tonyai/db';
import { DEFAULT_PAGE_LIMIT, isCalculated, PENDING_REVIEW_STATUSES,
  CATEGORY_SCOPE_MAP,
  CATEGORIES,
  needsEvidenceBeforeSubmit,
  mayEditRecord,
} from '@tonyai/shared-types';
import type { CalculationResult, CalculationResultV2, UncalculatedSnapshot } from '@tonyai/shared-types';
import { ActivityRecordsService, SUBMISSION_NOT_NAMED, evidenceReadyWhere, inheritsQuantityElsewhere, submitRowsOf } from './activity-records.service';
import {
  CALCULATION_STALE_MESSAGE,
  CalculationStaleError,
  CreateRoleRefusedError,
  DuplicateActivityRecordError,
  EVIDENCE_REFUSAL_FRAGMENT,
  EvidenceRequiredError,
  ApprovalEvidenceMissingError,
  AuthorOnlyRefusedError,
  EvidenceDetachRequiredError,
  ReviewVersionRequiredError,
  PeriodLockedError,
  RecordNotRecallableError,
  RESUBMIT_AUTHOR_REFUSAL,
  RecordChangedError,
  SelfApprovalRefusedError,
  SelfReviewRefusedError,
  SUBMIT_AUTHOR_REFUSAL,
  SubmitAuthorRefusedError,
  SUBMIT_ROLE_REFUSAL,
  SubmitRoleRefusedError,
  VARIANCE_REFUSAL,
  CEILING_VARIANCE_REFUSAL,
  VarianceReasonRequiredError,
  ActivityTypeSlotConflictError,
  SLOT_HOLDS_UNTYPED_MESSAGE,
  SnapshotImmutableError,
  recordTriggerCode,
  EntityClosedToDataEntryError,
} from './errors';
import { PrismaService } from '../prisma/prisma.service';
import { errorCodeOf } from '../common/api-error';
import { CalculationsService } from '../calculations/calculations.service';
import {
  CalculationInputError,
  FactorLibraryConflictError,
  NoEmissionFactorError,
} from '../calculations/errors';
import { QueryTooBroadError, ResourceNotFoundError } from '../common/api-error';
import type { RequestUser } from '../auth/auth.types';
import { everyCategoryOn } from '../../test/helpers';
import { CategoryNotGrantedError, recordScopeWhere } from './record-scope';
import { awaitingDecisionWhere, NotRecordApproverError } from './record-approver';

import { AuditService } from '../audit/audit.service';
import { EvidenceService } from '../evidence/evidence.service';

/**
 * Audit writes go through the shared AuditService. A single shared spy lets the
 * specs assert WHAT was audited; the row shape it stamps (actor role +
 * organisation) is covered by audit.service.spec.ts.
 */
const audit = { record: vi.fn() };
const auditMock = () => audit as unknown as AuditService;

// Order-independence: some describes below assert `not.toHaveBeenCalled()`.
beforeEach(() => audit.record.mockClear());

// --- Local, DB-free mocks --------------------------------------------------

/**
 * The accounts the approver rule reads (inc26-roles-approval-chain, INC-2.6
 * §1.1): each one's CURRENT role, disabled state, company grants and
 * invitation. The default directory is the seed's shape — a masterkey, a
 * super_admin granted `sub-1` and `sub-2` (so both companies have an active
 * super_admin), a standard user and an auditor — so a standard user's record
 * routes to the super_admin, a super_admin's to the masterkey and a
 * masterkey's to its author. A case about routing edits `prisma.people`.
 */
interface Person {
  role: string;
  disabledAt?: Date | null;
  grants?: string[];
  /** `null`: never invited (seeded, provisioned). */
  invitation?: 'pending' | 'accepted' | null;
  organisationId?: string;
}
function defaultPeople(): Map<string, Person> {
  return new Map<string, Person>([
    ['user-admin', { role: 'masterkey' }],
    ['user-admin-2', { role: 'masterkey' }],
    ['user-super-admin', { role: 'super_admin', grants: ['sub-1', 'sub-2'] }],
    ['user-entry', { role: 'standard_user', grants: ['sub-1', 'sub-2'] }],
    ['user-auditor', { role: 'auditor' }],
  ]);
}
type ProfileQuery = { where?: any; select?: any } | undefined;
type AccessQuery = { where?: any } | undefined;
const isActive = (p: Person) => !p.disabledAt && p.invitation !== 'pending';
function peopleRows(people: Map<string, Person>, args: ProfileQuery) {
  // The actor-name lookup: nothing resolves unless a case stubs it.
  if (!args?.select?.role) return [];
  const where = args.where ?? {};
  return [...people.entries()]
    .filter(([id, p]) =>
      (where.id?.in ? where.id.in.includes(id) : true) &&
      (where.organisationId ? (p.organisationId ?? 'org-1') === where.organisationId : true) &&
      (where.disabledAt === null ? !p.disabledAt : true) &&
      (where.role?.in ? where.role.in.includes(p.role) : true))
    .map(([id, p]) => ({ id, role: p.role, disabledAt: p.disabledAt ?? null }));
}
function personRow(people: Map<string, Person>, args: ProfileQuery) {
  const p = people.get(args?.where?.id);
  if (!p) return null;
  const only = args?.select?.subsidiaryAccess?.where?.subsidiaryId;
  return {
    role: p.role,
    disabledAt: p.disabledAt ?? null,
    subsidiaryAccess: (p.grants ?? []).filter((s) => s === only).map((subsidiaryId) => ({ subsidiaryId })),
  };
}
function staffedRows(people: Map<string, Person>, args: AccessQuery) {
  const ids: string[] = args?.where?.subsidiaryId?.in ?? [];
  const staffed = new Set(
    [...people.values()]
      .filter((p) => p.role === 'super_admin' && isActive(p))
      .flatMap((p) => p.grants ?? []),
  );
  return ids.filter((id) => staffed.has(id)).map((subsidiaryId) => ({ subsidiaryId }));
}

function createPrismaMock() {
  const people = defaultPeople();
  const client = {
    // The lifecycle locks (`lifecycle-lock.ts`): row locks read back one row
    // — the record was there to lock — and the period's advisory lock runs as
    // a statement.
    //
    // Two more readers share it (inc26-central-reporter-onboarding): a standard
    // user's access re-read FOR SHARE inside a create — by default its
    // committed access is what the guard read for `makeStandardUser` (sub-1 and
    // sub-2, every category, assigned) — and the period rule's look for the
    // other party's record, which by default finds none.
    $queryRaw: vi.fn(async (strings: any, ..._values: unknown[]): Promise<any[]> => {
      const sql = (strings as string[]).join('?');
      if (sql.includes('FROM user_subsidiary_access')) {
        return ['sub-1', 'sub-2'].map((subsidiaryId) => ({ subsidiaryId, kind: 'assigned', categories: [...CATEGORIES] }));
      }
      if (sql.includes('LEFT JOIN profiles p ON p.id = r.created_by')) return [];
      // The exact-duplicate look: none by default.
      if (sql.includes('r.activity_type IS NOT DISTINCT FROM')) return [];
      return [{ id: 'locked' }];
    }),
    $executeRaw: vi.fn().mockResolvedValue(1),
    activityRecord: {
      // Default [] so the anomaly baseline query finds no priors (no anomaly)
      // unless a test overrides it.
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _max: { reportingYear: null } }),
    },
    // Default: the record's subsidiary resolves, so K11's recompute at submit
    // and approve (LP4-02 B2) reaches the engine stub. Tests about a missing
    // subsidiary stub `null`.
    subsidiary: {
      findUnique: vi.fn(async () => makeSubsidiary()),
      // The reporting entities' names (C4): none resolves by default.
      findMany: vi.fn().mockResolvedValue([]),
    },
    location: {
      findUnique: vi.fn(),
    },
    activityRecordEvidence: {
      // Default: records have evidence, so evidence-required submits pass.
      count: vi.fn().mockResolvedValue(1),
    },
    periodLock: {
      // Default: period open (no lock row), so existing tests pass unchanged.
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      create: vi.fn(),
      // The record's earlier `submit` rows (WP5's submission number): none by default.
      count: vi.fn().mockResolvedValue(0),
    },
    // Two readers share this namespace. The actor-name lookup
    // (`resolveProfiles`, selecting `email`) answers [] by default: no actor
    // resolves, so every resolved name reads null — the deleted-profile case;
    // tests that care about a real name stub it. The approver rule's readers
    // (`approversFor`, `awaitingDecisionWhere`, selecting `role`) and the
    // decision's re-read (`findUnique`) answer from `people` below.
    profile: {
      // Loosely typed on purpose: cases stub the name lookup's own row shape.
      findMany: vi.fn((args: any): any => Promise.resolve(peopleRows(people, args))),
      findUnique: vi.fn((args: any): any => Promise.resolve(personRow(people, args))),
    },
    // "Which of these companies has an active super_admin" — the one query of
    // `companiesWithActiveSuperAdmin` — answered from `people` too.
    userSubsidiaryAccess: {
      findMany: vi.fn((args: any): any => Promise.resolve(staffedRows(people, args))),
    },
  };
  // Every write runs in one interactive transaction (the lifecycle protocol).
  // Its client shares this mock's spies — so "the record was updated" and
  // "not deleted" assert against the one spy a query really hits, inside or
  // outside — but is a different OBJECT, so a spec can tell which client a
  // collaborator was handed: `audit.record(..., prisma.tx)` fails if the
  // service passes its root client, which would audit outside the write.
  const tx = { ...client };
  return {
    ...client,
    people,
    tx,
    $transaction: vi.fn(async (fn: (c: typeof tx) => unknown) => fn(tx)),
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;

/**
 * The engine's v2 snapshot for `makeRecord`'s default inputs — a labelled
 * fixture, no publication's factor. A record stores what the engine computed,
 * so the stub's default answer and the fixture's default `calculation` are
 * the same snapshot: K11's recompute at submit and approve (LP4-02 B2) finds
 * every default record fresh, and a test that rewrites one finds it stale.
 */
const FRESH_SNAPSHOT: CalculationResultV2 = {
  snapshotSchema: 2,
  category: 'Electricity',
  geographyCode: 'TR',
  reportingYear: 2024,
  scope: 2,
  inputValue: 45000,
  inputUnit: 'kWh',
  normalizedValue: 45000,
  normalizedUnit: 'kWh',
  conversionApplied: false,
  kgCo2e: 19800,
  tCo2e: 19.8,
  factorId: 'factor-1',
  factorValue: 0.44,
  factorUnit: 'kgCO2e/kWh',
  methodology: 'location-based',
  source: 'fixture (not an authoritative source)',
  version: '2024.1',
  activityType: 'unspecified',
  gas: 'CO2e',
  gasCoverage: 'co2e_total',
  calorificBasis: null,
  scope2Method: 'location',
  dataYear: 2024,
  yearPolicy: 'same_year',
  factorRelease: {
    id: 'release-1',
    publisher: 'fixture',
    title: 'Unit-test fixture release',
    edition: '2024.1',
    ordinal: 1,
    status: 'active',
    sourceUrl: null,
    licence: null,
    publishedAt: null,
    gwpSet: null,
  },
  conversion: null,
} as unknown as CalculationResultV2;

/** A calc engine stub: compute() returns a fixed snapshot and records calls. */
function createCalcMock(scope = 2) {
  const snapshot: CalculationResultV2 = { ...FRESH_SNAPSHOT, scope };
  return {
    snapshot,
    compute: vi.fn().mockResolvedValue(snapshot),
  };
}

let seq = 0;
/**
 * Every column `toAuditSnapshot` is allowed to carry, and nothing else.
 *
 * Written out rather than derived, because deriving it from the function's
 * own output would assert nothing. `audit_log` is append-only with no
 * correction path, so a field reaching it is permanent — this list failing is
 * the intended outcome of adding one, resolved or persisted.
 */
const PERSISTED_KEYS = [
  'id', 'subsidiaryId', 'locationId', 'reportingYear', 'reportingPeriod',
  'periodValue', 'category', 'activityType', 'scope', 'status', 'activityValue',
  'activityUnit', 'input', 'parameters', 'calculation', 'createdBy', 'anomalyFlag',
  'anomalyBaselinePriorCount', 'anomalyBaselineTCo2e', 'varianceReason',
  'reviewedBy', 'reviewedAt', 'reviewNote', 'submittedAt', 'submissionCount', 'voidReason', 'voidedBy',
  'voidedAt', 'importBatchId', 'evidenceCount', 'createdAt', 'updatedAt',
  // inc26-central-reporter-onboarding D1: the stored reporting entity, read as
  // it means (empty is the record's own company). Its NAME is resolved, never audited.
  'reportedBySubsidiaryId',
].sort();


function makeRecord(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  seq += 1;
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: `rec-${seq}`,
    subsidiaryId: 'sub-1',
    reportingYear: 2024,
    reportingPeriod: 'annual',
    periodValue: 'Annual',
    category: 'Electricity',
    scope: 2,
    status: ActivityRecordStatus.draft,
    activityValue: 45000,
    activityUnit: 'kWh',
    input: null,
    // `factorId` is not decoration: a STORED record that was calculated always
    // carries one, and `isCalculated()` keys on it to decide whether the record
    // has a figure worth comparing. Without it here the fixture describes a
    // record that cannot exist, and the anomaly gate silently skipped every
    // spec in this file. The whole v2 snapshot since K11, which recomputes it
    // at submit and approve: a figure alone would be a stale legacy record.
    calculation: FRESH_SNAPSHOT as unknown,
    createdBy: 'user-entry',
    anomalyFlag: false,
    // Defaulted for the same reason `factorId` is (see above): a fixture that
    // omits a NOT-NULL-ish column hands `toDTO` an `undefined` where the
    // contract says a number, and the next assertion written against a read
    // path gets written to expect it.
    anomalyBaselinePriorCount: null,
    anomalyBaselineTCo2e: null,
    varianceReason: null,
    submittedAt: null,
    submissionCount: 0,
    // Prisma `_count` shape returned when the service includes evidence counts.
    _count: { evidenceLinks: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as ActivityRecord;
}

function makeSubsidiary(overrides: Partial<Subsidiary> = {}): Subsidiary {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'sub-1',
    organisationId: 'org-1',
    legalName: 'Sub One',
    tradingName: null,
    location: null,
    geographyCode: 'TR',
    businessArea: null,
    sector: null,
    designatedPerson: null,
    reportingStatus: 'active',
    includedScopes: [1, 2],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Subsidiary;
}

function masterkey(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-admin',
    email: 'admin@tonyai.local',
    fullName: 'Admin User',
    role: 'masterkey',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    categoryGrants: {},
    ...overrides,
  };
}

/**
 * A standard user granted `sub-1` (INC-2.6 §1). Unless the overrides name
 * `categoryGrants`, every category is ticked on every granted company — the
 * shape of a carried-over account — so a case about something else is not
 * narrowed by categories by accident.
 */
function standardUser(overrides: Partial<RequestUser> = {}): RequestUser {
  const accessibleSubsidiaryIds = overrides.accessibleSubsidiaryIds ?? ['sub-1'];
  return {
    id: 'user-entry',
    email: 'entry@tonyai.local',
    fullName: 'Entry User',
    role: 'standard_user',
    organisationId: 'org-1',
    accessibleSubsidiaryIds,
    categoryGrants: everyCategoryOn(accessibleSubsidiaryIds),
    ...overrides,
  };
}

/** A company-scoped super_admin granted `sub-1` and `sub-2`: the approver of a
 *  standard user's record in those companies (the default `people`). */
function superAdmin(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-super-admin',
    email: 'approver@tonyai.local',
    fullName: 'Super Admin User',
    role: 'super_admin',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    categoryGrants: {},
    ...overrides,
  };
}

/** An auditor: reads the whole organisation, changes nothing. */
function auditor(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-auditor',
    email: 'review@tonyai.local',
    fullName: 'Auditor User',
    role: 'auditor',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    categoryGrants: {},
    ...overrides,
  };
}

/**
 * A record's evidence LINKS go by themselves through the FK cascade; the files
 * it was the last to hold are deleted by the evidence service in the same
 * transaction, and their objects after it. Only `fileIdsFor`,
 * `deleteUnlinkedRows` and `removeBlobs` are used from here.
 */
function createEvidenceMock() {
  return {
    fileIdsFor: vi.fn().mockResolvedValue([]),
    detachLinksInTx: vi.fn().mockResolvedValue([]),
    deleteUnlinkedRows: vi.fn().mockResolvedValue([]),
    removeBlobs: vi.fn().mockResolvedValue(undefined),
  };
}

function build(scope = 2) {
  const prisma = createPrismaMock();
  const calc = createCalcMock(scope);
  const evidence = createEvidenceMock();
  const service = new ActivityRecordsService(
    prisma as unknown as PrismaService,
    calc as unknown as CalculationsService,
    auditMock(),
    evidence as unknown as EvidenceService,
  );
  return { prisma, calc, evidence, service };
}

const CREATE_DTO = {
  subsidiaryId: 'sub-1',
  reportingYear: 2024,
  reportingPeriod: 'annual' as const,
  periodValue: 'Annual',
  category: 'Electricity' as const,
  activityValue: 45000,
  activityUnit: 'kWh',
};

// ---------------------------------------------------------------------------

describe('ActivityRecordsService — tenant scoping', () => {
  let prisma: PrismaMock;
  let service: ActivityRecordsService;

  beforeEach(() => {

    audit.record.mockClear();
    ({ prisma, service } = build());
  });

  it('a page scopes to accessibleSubsidiaryIds when no filter is given, and fetches one row more than it returns', async () => {
    await service.listPage(standardUser(), {});
    expect(prisma.activityRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subsidiaryId: { in: ['sub-1'] } }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: DEFAULT_PAGE_LIMIT + 1,
      }),
    );
  });

  it('a subsidiaryId outside the accessible set is an empty, final page (no DB hit)', async () => {
    const result = await service.listPage(standardUser(), { subsidiaryId: 'sub-2', limit: 5 });
    expect(result).toEqual({ items: [], limit: 5, nextCursor: null });
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('a page filters on a SET of statuses (the reviewer queue), in the queue order', async () => {
    await service.listPage(masterkey(), { status: [...PENDING_REVIEW_STATUSES], sort: 'review_queue' });
    expect(prisma.activityRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['submitted', 'under_review'] } }),
        orderBy: [{ submittedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      }),
    );
  });

  it('omits every absent filter entirely', async () => {
    // Not `{ in: [] }` — Prisma reads an empty `in` as "match nothing", so a
    // careless refactor here would silently empty every unfiltered list.
    await service.listPage(masterkey(), {});
    const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
    // The company scope and the record scope (inc26-roles-approval-chain,
    // design Decision 6) — which for a masterkey is the company scope again.
    expect(Object.keys(where)).toEqual(['subsidiaryId', 'AND']);
    expect(where.AND).toEqual([{ subsidiaryId: { in: ['sub-1', 'sub-2'] } }]);
  });

  it('applies the added filters: company-level, scope, canonical period value and a literal search', async () => {
    await service.listPage(masterkey(), {
      locationId: null, scope: 2, period: 'monthly', periodValue: 'JANUARY', search: '50%_off\\',
    });
    const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ locationId: null, scope: 2, reportingPeriod: 'monthly', periodValue: 'January' });
    const literal = { contains: '50\\%\\_off\\\\', mode: 'insensitive' };
    expect(where.OR).toEqual([
      { category: literal },
      { periodValue: literal },
      { varianceReason: literal },
      { subsidiary: { tradingName: literal } },
      { subsidiary: { OR: [{ tradingName: null }, { tradingName: '' }], legalName: literal } },
    ]);
  });

  it('continues after the cursor\'s sort key, inside the same scope, and marks each row\'s lock', async () => {
    const t = new Date('2026-03-01T10:00:00.000Z');
    const rows = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001']
      .map((id, i) => ({ ...makeRecord({ id, createdAt: t, periodValue: i === 0 ? 'January' : 'February' }), _count: { evidenceLinks: 0 } }));
    prisma.activityRecord.findMany.mockResolvedValueOnce(rows);
    prisma.periodLock.findMany.mockResolvedValueOnce([
      { subsidiaryId: 'sub-1', reportingYear: rows[0].reportingYear, reportingPeriod: rows[0].reportingPeriod, periodValue: 'January' },
    ]);
    const first = await service.listPage(standardUser(), { limit: 2 });
    expect(first.items.map((r) => [r.id, r.periodLocked])).toEqual([[rows[0].id, true], [rows[1].id, false]]);
    expect(first.nextCursor).toEqual(expect.any(String));
    // The lock lookup asked about the PAGE's periods only, never the extra row's.
    expect(prisma.periodLock.findMany.mock.calls[0][0].where.OR).toHaveLength(2);

    prisma.activityRecord.findMany.mockResolvedValueOnce([]);
    await service.listPage(standardUser(), { limit: 2, cursor: first.nextCursor! });
    expect(prisma.activityRecord.findMany.mock.calls[1][0].where).toEqual({
      AND: [
        { subsidiaryId: { in: ['sub-1'] }, AND: [recordScopeWhere(standardUser())] },
        { OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: rows[1].id } }] },
      ],
    });
  });

  it('refuses a cursor of another filter or sort, even where the caller sees nothing', async () => {
    prisma.activityRecord.findMany.mockResolvedValueOnce(
      [1, 2].map((n) => ({ ...makeRecord({ id: `00000000-0000-4000-8000-00000000000${n}` }), _count: { evidenceLinks: 0 } })),
    );
    const { nextCursor } = await service.listPage(standardUser(), { limit: 1, year: 2026 });
    const refused = expect.objectContaining({ response: expect.objectContaining({ code: 'validation_failed' }) });
    await expect(service.listPage(standardUser(), { limit: 1, year: 2025, cursor: nextCursor! })).rejects.toThrow(refused);
    await expect(service.listPage(standardUser(), { limit: 1, year: 2026, sort: 'review_queue', cursor: nextCursor! })).rejects.toThrow(refused);
    await expect(service.listPage(standardUser(), { limit: 1, year: 2025, subsidiaryId: 'sub-2', cursor: nextCursor! })).rejects.toThrow(refused);
    // The same request's cursor is accepted, whatever the caller's access now is.
    await expect(service.listPage(standardUser({ accessibleSubsidiaryIds: [] }), { limit: 1, year: 2026, cursor: nextCursor! }))
      .resolves.toEqual({ items: [], limit: 1, nextCursor: null });
  });

  describe('a cursor is bound to every filter and to the sort (qa-auditor P2-1)', () => {
    const at = new Date('2026-03-01T10:00:00.000Z');
    const twoRows = () =>
      [1, 2].map((n) => ({ ...makeRecord({ id: `00000000-0000-4000-8000-00000000000${n}`, createdAt: at }), _count: { evidenceLinks: 0 } }));
    const base = {
      subsidiaryId: 'sub-1', year: 2026, period: 'monthly' as const, periodValue: 'January', category: CATEGORIES[0],
      status: ['draft' as const], locationId: null, scope: 2 as const, search: 'abc',
    };
    const refused = expect.objectContaining({ response: expect.objectContaining({ code: 'validation_failed' }) });
    const mint = async () => {
      prisma.activityRecord.findMany.mockResolvedValueOnce(twoRows());
      const { nextCursor } = await service.listPage(standardUser(), { ...base, limit: 1 });
      expect(nextCursor).toEqual(expect.any(String));
      return nextCursor!;
    };

    it.each([
      ['subsidiaryId', { subsidiaryId: undefined }],
      ['year', { year: 2025 }],
      ['period', { period: 'quarterly' as const, periodValue: 'Q1' }],
      ['periodValue', { periodValue: 'February' }],
      ['category', { category: CATEGORIES[1] }],
      ['status', { status: ['submitted' as const] }],
      ['locationId: company-level against every site', { locationId: undefined }],
      ['locationId: company-level against one site', { locationId: '00000000-0000-4000-8000-0000000000aa' }],
      ['scope', { scope: 1 as const }],
      ['search', { search: 'abd' }],
      ['sort', { sort: 'review_queue' as const }],
    ])('another %s is refused', async (_label, change) => {
      const cursor = await mint();
      await expect(service.listPage(standardUser(), { ...base, ...change, limit: 1, cursor })).rejects.toThrow(refused);
    });

    it('another spelling of the same request binds alike — the status set in any order, the period value in any case', async () => {
      const cursor = await mint();
      await expect(
        service.listPage(standardUser(), { ...base, status: ['draft', 'draft'], periodValue: 'JANUARY', limit: 1, cursor }),
      ).resolves.toMatchObject({ limit: 1 });
    });
  });

  it('metadata counts the whole filtered set inside the access, up to the work budget', async () => {
    prisma.activityRecord.count.mockResolvedValueOnce(42);
    prisma.activityRecord.aggregate.mockResolvedValueOnce({ _max: { reportingYear: 2026 } });
    await expect(service.metadata(standardUser(), { status: ['draft'] })).resolves.toEqual({ total: 42, latestReportingYear: 2026 });
    expect(prisma.activityRecord.count).toHaveBeenCalledWith({
      where: { subsidiaryId: { in: ['sub-1'] }, AND: [recordScopeWhere(standardUser())], status: { in: ['draft'] } },
      take: 100_001,
    });
  });

  it('exactly a page of rows is the last page; exactly the budget is counted (boundaries)', async () => {
    prisma.activityRecord.findMany.mockResolvedValueOnce(
      [1, 2].map((n) => ({ ...makeRecord({ id: `00000000-0000-4000-8000-00000000000${n}` }), _count: { evidenceLinks: 0 } })),
    );
    expect((await service.listPage(standardUser(), { limit: 2 })).nextCursor).toBeNull();
    prisma.activityRecord.count.mockResolvedValueOnce(100_000);
    await expect(service.metadata(masterkey(), {})).resolves.toMatchObject({ total: 100_000 });
  });

  it('metadata over the budget is query_too_broad, with no partial count', async () => {
    prisma.activityRecord.count.mockResolvedValueOnce(100_001);
    await expect(service.metadata(masterkey(), {})).rejects.toBeInstanceOf(QueryTooBroadError);
    expect(prisma.activityRecord.aggregate).not.toHaveBeenCalled();
  });

  it('metadata of an inaccessible or empty set is zero and no year, before any budget', async () => {
    await expect(service.metadata(standardUser(), { subsidiaryId: 'sub-2' })).resolves.toEqual({ total: 0, latestReportingYear: null });
    expect(prisma.activityRecord.count).not.toHaveBeenCalled();
    await expect(service.metadata(standardUser(), {})).resolves.toEqual({ total: 0, latestReportingYear: null });
    expect(prisma.activityRecord.aggregate).not.toHaveBeenCalled();
  });

  it('get treats an out-of-scope record as NotFound', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ subsidiaryId: 'sub-2' }),
    );
    await expect(service.get(standardUser(), 'rec-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('get returns a record inside the accessible set', async () => {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-in', subsidiaryId: 'sub-1' }),
    );
    prisma.activityRecordEvidence.count.mockResolvedValue(2);
    const dto = await service.get(standardUser(), 'rec-in');
    expect(dto.id).toBe('rec-in');
    expect(dto.evidenceCount).toBe(2);
    expect(prisma.activityRecordEvidence.count).toHaveBeenCalledWith({
      where: { activityRecordId: 'rec-in' },
    });
  });
});

describe('ActivityRecordsService — create stores the calc snapshot', () => {
  it('calls compute() with the subsidiary geography + derived scope and persists the snapshot', async () => {
    const { prisma, calc, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(standardUser(), CREATE_DTO);

    // compute() called with resolved geography + engine input.
    expect(calc.compute).toHaveBeenCalledWith(
      {
        category: 'Electricity',
        // An implicit category's record names no activity type (LP3-03).
        activityType: null,
        geographyCode: 'TR',
        reportingYear: 2024,
        value: 45000,
        unit: 'kWh',
        reportingPeriod: 'annual',
        parameters: null,
      },
      // A create always chooses its unit, so the category/unit map applies.
      { enforceCategoryUnit: true },
    );
    // Snapshot + derived scope persisted on the row.
    const createArg = prisma.activityRecord.create.mock.calls[0][0];
    expect(createArg.data.scope).toBe(2); // Electricity -> Scope 2
    expect(createArg.data.calculation).toEqual(calc.snapshot);
    expect(createArg.data.status).toBe(ActivityRecordStatus.draft);
    expect(createArg.data.createdBy).toBe('user-entry');
    // Narrowed, not cast: an `as CalculationResult` would still compile if the
    // service regressed to storing the uncalculated shape here, and the
    // assertion below would then compare `undefined` and pass nothing.
    expect(isCalculated(dto.calculation)).toBe(true);
    expect((dto.calculation as CalculationResult).tCo2e).toBeCloseTo(19.8, 6);
    // Audit written.
    expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({
          action: 'create',
          entity: 'activity_record',
        }),
        // Through the write's own transaction client (F02).
        prisma.tx,
      );
  });

  it('resolves the factor geography from the LOCATION when a locationId is given (data_entry_page.md §5.2)', async () => {
    const { prisma, calc, service } = build(2);
    // Subsidiary is TR, but the targeted location is UK -> UK must win.
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.location.findUnique.mockResolvedValue({
      id: 'loc-1',
      subsidiaryId: 'sub-1',
      geographyCode: 'UK',
    });
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), { ...CREATE_DTO, locationId: 'loc-1' });

    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ geographyCode: 'UK' }),
      expect.anything(),
    );
    const createArg = prisma.activityRecord.create.mock.calls[0][0];
    expect(createArg.data.locationId).toBe('loc-1');
  });

    it('rejects a location that belongs to another subsidiary (NotFound, no compute)', async () => {
    const { prisma, calc, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.location.findUnique.mockResolvedValue({
      id: 'loc-x',
      subsidiaryId: 'sub-OTHER', // not the record's subsidiary
      geographyCode: 'UK',
    });

    await expect(
      service.create(standardUser(), { ...CREATE_DTO, locationId: 'loc-x' }),
    ).rejects.toThrow(/Location not found/);
    expect(calc.compute).not.toHaveBeenCalled();
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('maps a duplicate (Prisma P2002) to 409 Conflict, not 500', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.create(standardUser(), CREATE_DTO),
    ).rejects.toBeInstanceOf(ConflictException);
    // And the CLASS the bulk importer branches on — the only place that
    // contract can fail, since the bulk specs mock this service.
    await expect(
      service.create(standardUser(), CREATE_DTO),
    ).rejects.toBeInstanceOf(DuplicateActivityRecordError);
  });

  it('cannot create against an inaccessible subsidiary (NotFound, no compute)', async () => {
    const { prisma, calc, service } = build();
    await expect(
      service.create(standardUser(), { ...CREATE_DTO, subsidiaryId: 'sub-2' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calc.compute).not.toHaveBeenCalled();
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('executive_viewer (read-only role) cannot create -> Forbidden', async () => {
    const { service } = build();
    await expect(
      service.create(
        masterkey({ role: 'auditor' }),
        CREATE_DTO,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/**
 * `locationName` is resolved by a join, not stored on the row. That makes it a
 * read-time convenience — and a liability the moment it reaches `audit_log`,
 * which is append-only and has no correction path. Before the split, `toDTO`
 * served both jobs and the queries disagreed about the include, so a create
 * whose `locationId` was set the whole time logged `locationName: null` and the
 * next unrelated edit logged `null → "Ankara Plant"` — a permanent record of a
 * geography decision that never happened on that day.
 */
describe('ActivityRecordsService — parameters are stored, audited and held to the category (LP4-02, D3)', () => {
  const GAS = { ncvKcalPerSm3: 8100 };
  const storedGas = (over: Partial<ActivityRecord> = {}) => ({
    ...makeRecord({
      id: 'rec-p',
      subsidiaryId: 'sub-1',
      createdBy: 'user-entry',
      category: 'Natural Gas',
      activityUnit: 'kWh',
      ...over,
    }),
    _count: { evidenceLinks: 0 },
    location: null,
  });
  const updatedData = (prisma: ReturnType<typeof build>['prisma']) =>
    prisma.activityRecord.update.mock.calls[0][0].data as Record<string, unknown>;

  function editing(row: ReturnType<typeof storedGas>) {
    const built = build(2);
    built.prisma.activityRecord.findUnique.mockResolvedValue(row);
    built.prisma.activityRecord.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...row,
      ...data,
      parameters: data.parameters === Prisma.DbNull ? null : data.parameters ?? row.parameters,
    }));
    return built;
  }

  it('create writes them to their own column, and the audit row carries them', async () => {
    const { prisma, service } = build(1);
    prisma.activityRecord.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...makeRecord({ id: 'rec-new', subsidiaryId: 'sub-1' }),
      ...data,
      _count: { evidenceLinks: 0 },
      location: null,
    }));

    const dto = await service.create(standardUser(), {
      subsidiaryId: 'sub-1', reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'January',
      category: 'Natural Gas', activityValue: 10, activityUnit: 'kWh', parameters: GAS,
    } as never);

    expect(prisma.activityRecord.create.mock.calls[0][0].data.parameters).toEqual(GAS);
    expect(dto.parameters).toEqual(GAS);
    expect((audit.record.mock.calls[0][1].diff as any).after.parameters).toEqual(GAS);
  });

  it('create refuses parameters the category takes none of, before anything is written', async () => {
    const { prisma, service } = build(1);
    await expect(service.create(standardUser(), {
      subsidiaryId: 'sub-1', reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'January',
      category: 'Electricity', activityValue: 10, activityUnit: 'kWh', parameters: GAS,
    } as never)).rejects.toMatchObject({ code: 'record_parameters_invalid' });
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('an edit that names no category is held to the stored one, and audits the change on both sides', async () => {
    const { prisma, service } = editing(storedGas({ parameters: { ncvKcalPerSm3: 8250 } as never }));

    await service.update(standardUser(), 'rec-p', { parameters: GAS });

    expect(updatedData(prisma).parameters).toEqual(GAS);
    const diff = audit.record.mock.calls[0][1].diff as any;
    expect(diff.before.parameters).toEqual({ ncvKcalPerSm3: 8250 });
    expect(diff.after.parameters).toEqual(GAS);
  });

  it('refuses another category\'s fields on that same edit', async () => {
    const { prisma, service } = editing(storedGas());
    await expect(service.update(standardUser(), 'rec-p', { parameters: { refillKg: 1 } as never }))
      .rejects.toMatchObject({ code: 'record_parameters_invalid' });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('null clears them as SQL NULL, which is what the CHECK means by none', async () => {
    const { prisma, service } = editing(storedGas({ parameters: GAS as never }));
    await service.update(standardUser(), 'rec-p', { parameters: null });
    expect(updatedData(prisma).parameters).toBe(Prisma.DbNull);
  });

  it('an edit that does not name them leaves them alone', async () => {
    const { prisma, service } = editing(storedGas({ parameters: GAS as never }));
    await service.update(standardUser(), 'rec-p', { activityValue: 12 });
    expect(updatedData(prisma)).not.toHaveProperty('parameters');
  });

  it('refuses moving a record to a category its stored parameters do not fit, until they are cleared', async () => {
    const { prisma, service } = editing(storedGas({ parameters: GAS as never }));
    await expect(service.update(standardUser(), 'rec-p', { category: 'Electricity' }))
      .rejects.toMatchObject({ code: 'record_parameters_invalid' });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();

    // The quantity sent too: a kWh gas bill re-filed without it is asked for it (ng-kwh-engine review).
    await service.update(standardUser(), 'rec-p', { category: 'Electricity', parameters: null, activityValue: 100 });
    expect(updatedData(prisma).parameters).toBe(Prisma.DbNull);
  });

  // UAT round 4, BUG-12: a chiller line fits Refrigerants, never Fire Suppression.
  it('refuses moving a refrigerant record with a chiller line to Fire Suppression without new lines', async () => {
    const CHILLER = { equipment: [{ equipmentType: 'chiller', capacityKg: 20, refillKg: 0, leakRateChoice: 'default' }] };
    const { prisma, service } = editing(storedGas({
      category: 'Refrigerants', activityType: 'HFC-227ea', activityUnit: 'kg', parameters: CHILLER as never,
    }));
    await expect(service.update(standardUser(), 'rec-p', { category: 'Fire Suppression' }))
      .rejects.toMatchObject({ code: 'record_parameters_invalid' });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });
});

describe('ActivityRecordsService — the engine reads the effective parameters and period (LP4-02, D11)', () => {
  const GAS = { ncvKcalPerSm3: 8100 };
  const stored = (over: Partial<ActivityRecord> = {}) => ({
    ...makeRecord({ id: 'rec-e', subsidiaryId: 'sub-1', createdBy: 'user-entry', category: 'Natural Gas', activityUnit: 'kWh', ...over }),
    _count: { evidenceLinks: 0 },
    location: null,
  });
  const lastInput = (calc: ReturnType<typeof build>['calc']) => calc.compute.mock.calls.at(-1)![0];
  const editing = (row: ReturnType<typeof stored>) => {
    const built = build(1);
    built.prisma.activityRecord.findUnique.mockResolvedValue(row);
    built.prisma.activityRecord.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data }));
    return built;
  };

  it('an edit naming them prices with them', async () => {
    const { calc, service } = editing(stored());
    await service.update(standardUser(), 'rec-e', { parameters: GAS });
    expect(lastInput(calc)).toMatchObject({ parameters: GAS });
  });

  it('an edit not naming them prices with the stored ones', async () => {
    const { calc, service } = editing(stored({ parameters: GAS as never }));
    await service.update(standardUser(), 'rec-e', { activityValue: 12 });
    expect(lastInput(calc)).toMatchObject({ parameters: GAS });
  });

  it('an edit clearing them prices with none', async () => {
    const { calc, service } = editing(stored({ parameters: GAS as never }));
    await service.update(standardUser(), 'rec-e', { parameters: null });
    expect(lastInput(calc)).toMatchObject({ parameters: null });
  });

  it('an edit moving the period prices under the new one', async () => {
    const { calc, service } = editing(stored({ reportingPeriod: 'monthly', periodValue: 'January' }));
    await service.update(standardUser(), 'rec-e', { reportingPeriod: 'annual', periodValue: 'Annual' });
    expect(lastInput(calc)).toMatchObject({ reportingPeriod: 'annual' });
  });
});

describe('ActivityRecordsService — an Electricity self-generation block (self-gen-model)', () => {
  const BLOCK = { generationTopology: 'A', selfGenerationSource: 'solar', selfGeneratedKwh: 400000, exportedToGridKwh: null } as const;
  const stored = (over: Partial<ActivityRecord> = {}) => ({
    ...makeRecord({
      id: 'rec-sg', subsidiaryId: 'sub-1', createdBy: 'user-entry', category: 'Electricity', activityUnit: 'kWh',
      parameters: BLOCK as never, ...over,
    }),
    _count: { evidenceLinks: 0 },
    location: null,
  });
  const lastInput = (calc: ReturnType<typeof build>['calc']) => calc.compute.mock.calls.at(-1)![0];
  const updatedData = (prisma: ReturnType<typeof build>['prisma']) =>
    prisma.activityRecord.update.mock.calls[0][0].data as Record<string, unknown>;
  const editing = (row: ReturnType<typeof stored>) => {
    const built = build(2);
    built.prisma.activityRecord.findUnique.mockResolvedValue(row);
    built.prisma.activityRecord.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...row,
      ...data,
      parameters: data.parameters === Prisma.DbNull ? null : data.parameters ?? row.parameters,
    }));
    return built;
  };

  beforeEach(() => {
    audit.record.mockClear();
  });
  // The version the editor read (seenUpdatedAt, review of 1802e22e).
  const seen = (row: ReturnType<typeof stored>) => row.updatedAt.toISOString();

  it('a create with a block stores it as sent, null field included, prices with it and audits it', async () => {
    const { prisma, calc, service } = build(2);
    prisma.activityRecord.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...makeRecord({ id: 'rec-new', subsidiaryId: 'sub-1' }),
      ...data,
      _count: { evidenceLinks: 0 },
      location: null,
    }));

    const dto = await service.create(standardUser(), {
      subsidiaryId: 'sub-1', reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'January',
      category: 'Electricity', activityValue: 600000, activityUnit: 'kWh', parameters: BLOCK,
    } as never);

    expect(prisma.activityRecord.create.mock.calls[0][0].data.parameters).toEqual(BLOCK);
    expect(prisma.activityRecord.create.mock.calls[0][0].data.parameters).toHaveProperty('exportedToGridKwh', null);
    expect(lastInput(calc)).toMatchObject({ category: 'Electricity', parameters: BLOCK });
    expect(dto.parameters).toEqual(BLOCK);
    expect((audit.record.mock.calls[0][1].diff as any).after.parameters).toEqual(BLOCK);
  });

  it('a PATCH that omits parameters keeps the stored block, and prices with it', async () => {
    const { prisma, calc, service } = editing(stored());
    await service.update(standardUser(), 'rec-sg', { activityValue: 550000 });
    expect(updatedData(prisma)).not.toHaveProperty('parameters');
    expect(lastInput(calc)).toMatchObject({ value: 550000, parameters: BLOCK });
  });

  it('a PATCH that changes the block recalculates with the new one, and audits both sides', async () => {
    const row = stored();
    const { prisma, calc, service } = editing(row);
    const next = { ...BLOCK, selfGeneratedKwh: 450000, exportedToGridKwh: 10000 };
    await service.update(standardUser(), 'rec-sg', { parameters: next, seenUpdatedAt: seen(row) });
    expect(calc.compute).toHaveBeenCalledTimes(1);
    expect(lastInput(calc)).toMatchObject({ parameters: next });
    expect(updatedData(prisma).parameters).toEqual(next);
    expect(updatedData(prisma).calculation).toEqual(calc.snapshot);
    const diff = audit.record.mock.calls[0][1].diff as any;
    expect(diff.before.parameters).toEqual(BLOCK);
    expect(diff.after.parameters).toEqual(next);
  });

  it('refuses moving the record to another category with its block, and accepts it with parameters: null', async () => {
    const row = stored();
    const { prisma, service } = editing(row);
    await expect(service.update(standardUser(), 'rec-sg', { category: 'Natural Gas', seenUpdatedAt: seen(row) }))
      .rejects.toMatchObject({ code: 'record_parameters_invalid' });
    await expect(service.update(standardUser(), 'rec-sg', { category: 'Natural Gas', parameters: BLOCK, seenUpdatedAt: seen(row) } as never))
      .rejects.toMatchObject({ code: 'record_parameters_invalid' });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();

    await service.update(standardUser(), 'rec-sg', { category: 'Natural Gas', parameters: null, seenUpdatedAt: seen(row) });
    expect(updatedData(prisma).category).toBe('Natural Gas');
    expect(updatedData(prisma).parameters).toBe(Prisma.DbNull);
  });

  it('refuses another category\'s fields on an Electricity edit, before anything is written', async () => {
    const row = stored();
    const { prisma, service } = editing(row);
    await expect(service.update(standardUser(), 'rec-sg', { parameters: { cvBasis: 'net' } as never, seenUpdatedAt: seen(row) }))
      .rejects.toMatchObject({ code: 'record_parameters_invalid' });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  describe('the version an edit names (seenUpdatedAt, review of 1802e22e)', () => {
    it('refuses an edit made on an older version as record_changed, before anything is computed or written', async () => {
      const row = stored();
      const { prisma, calc, service } = editing(row);
      const older = new Date(row.updatedAt.getTime() - 1000).toISOString();
      await expect(service.update(standardUser(), 'rec-sg', { activityValue: 5200, seenUpdatedAt: older }))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'record_changed' }) });
      expect(calc.compute).not.toHaveBeenCalled();
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('applies to every record, a plain one too', async () => {
      const row = stored({ parameters: null });
      const { prisma, service } = editing(row);
      await expect(service.update(standardUser(), 'rec-sg', { activityValue: 1, seenUpdatedAt: '2000-01-01T00:00:00.000Z' }))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'record_changed' }) });
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('accepts an edit made on the version stored, in any spelling of the instant', async () => {
      const row = stored();
      const { prisma, service } = editing(row);
      const sameInstant = row.updatedAt.toISOString().replace('Z', '+00:00');
      await service.update(standardUser(), 'rec-sg', { activityValue: 5200, seenUpdatedAt: sameInstant });
      expect(prisma.activityRecord.update).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['removes the block', { parameters: null }],
      ['replaces it with a block of nulls', { parameters: { generationTopology: null, selfGenerationSource: null, selfGeneratedKwh: null } }],
      ['changes it', { parameters: { ...BLOCK, selfGeneratedKwh: 1 } }],
      ['moves the record to Natural Gas', { category: 'Natural Gas', parameters: null }],
    ])('refuses an edit that names no version and %s, as record_changed', async (_what, change) => {
      const { prisma, calc, service } = editing(stored());
      await expect(service.update(standardUser(), 'rec-sg', change as never))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: 'record_changed' }) });
      expect(calc.compute).not.toHaveBeenCalled();
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('lets an edit that names no version through when it leaves the stored block as it is', async () => {
      for (const change of [{ activityValue: 5200 }, { parameters: { ...BLOCK } }, { parameters: { ...BLOCK, facilityConsumptionKwh: null } }]) {
        const { prisma, service } = editing(stored());
        await service.update(standardUser(), 'rec-sg', change as never);
        expect(prisma.activityRecord.update, JSON.stringify(change)).toHaveBeenCalledTimes(1);
      }
    });

    it('answers a tenant, role or author refusal before a stale version, never 409 (security-rls, architect)', async () => {
      const stale = '2000-01-01T00:00:00.000Z';
      const cases: [string, RequestUser, string][] = [
        ['another tenant', standardUser({ accessibleSubsidiaryIds: ['sub-9'] }), 'record_not_found'],
        ['an executive viewer', auditor(), 'forbidden'],
        ['a data entry user who is not the author', standardUser({ id: 'user-other' }), 'record_author_forbidden'],
        ['a masterkey who is not the author', masterkey(), 'record_author_forbidden'],
      ];
      for (const [who, user, code] of cases) {
        const { prisma, service } = editing(stored());
        const refusal = await service.update(user, 'rec-sg', { parameters: null, seenUpdatedAt: stale }).catch((e) => e);
        expect(errorCodeOf(refusal), who).not.toBe('record_changed');
        if (code !== 'forbidden') expect(errorCodeOf(refusal), who).toBe(code);
        else expect(refusal?.status ?? refusal?.getStatus?.(), who).toBe(403);
        expect(prisma.activityRecord.update, who).not.toHaveBeenCalled();
      }
    });

    it('asks no version of a record that holds no block', async () => {
      const { prisma, service } = editing(stored({ parameters: null }));
      await service.update(standardUser(), 'rec-sg', { category: 'Natural Gas', parameters: null });
      expect(prisma.activityRecord.update).toHaveBeenCalledTimes(1);
    });

    it('lets a client that names no version add a block to a record holding none, or a block of nulls (qa-auditor re-review)', async () => {
      for (const storedParameters of [null, {}, { generationTopology: null, selfGeneratedKwh: null }]) {
        const { prisma, service } = editing(stored({ parameters: storedParameters as never }));
        await service.update(standardUser(), 'rec-sg', { parameters: BLOCK });
        expect(prisma.activityRecord.update, JSON.stringify(storedParameters)).toHaveBeenCalledTimes(1);
      }
    });
  });
});

describe('ActivityRecordsService — an Electricity record\'s supplier is bounded (uat4-quick-fixes, BUG-16)', () => {
  const LONG = 'z'.repeat(201);
  const LEGACY = 'z'.repeat(5000);
  const stored = (over: Partial<ActivityRecord> = {}) => ({
    ...makeRecord({ id: 'rec-el', subsidiaryId: 'sub-1', createdBy: 'user-entry', category: 'Electricity', activityUnit: 'kWh', ...over }),
    _count: { evidenceLinks: 0 },
    location: null,
  });
  const editing = (row: ReturnType<typeof stored>) => {
    const built = build(2);
    built.prisma.activityRecord.findUnique.mockResolvedValue(row);
    built.prisma.activityRecord.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data }));
    return built;
  };
  const updatedData = (prisma: ReturnType<typeof build>['prisma']) =>
    prisma.activityRecord.update.mock.calls[0][0].data as Record<string, unknown>;
  const refused = { response: { code: 'validation_failed', statusCode: 400 } };
  const creating = () => {
    const built = build(2);
    built.prisma.activityRecord.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...makeRecord({ id: 'rec-new', subsidiaryId: 'sub-1' }),
      ...data,
      _count: { evidenceLinks: 0 },
      location: null,
    }));
    return built;
  };
  const create = (service: ActivityRecordsService, category: string, input: unknown) =>
    service.create(standardUser(), {
      subsidiaryId: 'sub-1', reportingYear: 2026, reportingPeriod: 'monthly', periodValue: 'January',
      category, activityValue: 10, activityUnit: 'kWh', input,
    } as never);

  it('create refuses a utility provider over 200 characters or not text, before anything is written', async () => {
    const { prisma, service } = build(2);
    await expect(create(service, 'Electricity', { utility_provider: LONG })).rejects.toMatchObject(refused);
    await expect(create(service, 'Electricity', { utility_provider: 7 })).rejects.toMatchObject(refused);
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('the refusal names the key and the limit, and quotes nothing back', async () => {
    const { service } = build(2);
    const error = await create(service, 'Electricity', { utility_provider: 'SECRET'.repeat(40) }).catch((e: unknown) => e);
    const body = (error as { response: { message: string[] } }).response;
    expect(body.message).toEqual(['input.utility_provider must be at most 200 characters']);
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  it('create stores one of 200 characters', async () => {
    const { prisma, service } = creating();
    await create(service, 'Electricity', { utility_provider: 'y'.repeat(200) });
    expect(prisma.activityRecord.create.mock.calls[0][0].data.input).toEqual({ utility_provider: 'y'.repeat(200) });
  });

  it('an edit of another field of an old record keeps its long supplier', async () => {
    const { prisma, service } = editing(stored({ input: { utility_provider: LEGACY, notes: 'old' } as never }));
    await service.update(standardUser(), 'rec-el', { input: { utility_provider: LEGACY, notes: 'edited' } });
    expect(updatedData(prisma).input).toEqual({ utility_provider: LEGACY, notes: 'edited' });
  });

  it('an edit that sends no input is not asked about the stored one', async () => {
    const { prisma, service } = editing(stored({ input: { utility_provider: LEGACY } as never }));
    await service.update(standardUser(), 'rec-el', { activityValue: 12 });
    expect(updatedData(prisma)).not.toHaveProperty('input');
  });

  it('an edit that changes the supplier is held to the bound, whatever the record held', async () => {
    const { prisma, service } = editing(stored({ input: { utility_provider: LEGACY } as never }));
    await expect(service.update(standardUser(), 'rec-el', { input: { utility_provider: `${LEGACY}!` } })).rejects.toMatchObject(refused);
    await expect(service.update(standardUser(), 'rec-el', { input: { utility_provider: LONG } })).rejects.toMatchObject(refused);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    await service.update(standardUser(), 'rec-el', { input: { utility_provider: 'Enerjisa' } });
    expect(updatedData(prisma).input).toEqual({ utility_provider: 'Enerjisa' });
  });

  it('is asked of the effective category: a record moved to Electricity with a new long supplier is refused', async () => {
    const { prisma, service } = editing(stored({ category: 'Water', activityUnit: 'cubic_metres', input: null }));
    await expect(service.update(standardUser(), 'rec-el', { category: 'Electricity', activityUnit: 'kWh', input: { utility_provider: LONG } }))
      .rejects.toMatchObject(refused);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('another category\'s key of that name is not a supplier and is stored as sent', async () => {
    const { prisma, service } = creating();
    await create(service, 'Water', { utility_provider: LONG });
    expect(prisma.activityRecord.create.mock.calls[0][0].data.input).toEqual({ utility_provider: LONG });
  });
});

describe('ActivityRecordsService — locationName: read-only, never audited', () => {
  const located = { ...CREATE_DTO, locationId: 'loc-1' };

  function withLocation(prisma: PrismaMock) {
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.location.findUnique.mockResolvedValue({
      id: 'loc-1',
      subsidiaryId: 'sub-1',
      geographyCode: 'UK',
    });
  }

  beforeEach(() => {
    audit.record.mockClear();
  });

  it('create returns the name but keeps it out of the audit snapshot', async () => {
    const { prisma, service } = build(2);
    withLocation(prisma);
    prisma.activityRecord.create.mockImplementation(({ data }: any) => ({
      ...makeRecord({ ...data, id: 'rec-new' }),
      location: { name: 'Ankara Plant' },
    }));

    const dto = await service.create(standardUser(), located);

    expect(dto.locationName).toBe('Ankara Plant');
    const diff = audit.record.mock.calls[0][1].diff as any;
    // The persisted column IS audited; the resolved label is not.
    expect(diff.after.locationId).toBe('loc-1');
    expect(diff.after).not.toHaveProperty('locationName');
  });

  it('update audits neither side with a resolved name', async () => {
    const { prisma, service } = build(2);
    withLocation(prisma);
    prisma.activityRecord.findUnique.mockResolvedValue({
      ...makeRecord({
        id: 'rec-u',
        subsidiaryId: 'sub-1',
        locationId: 'loc-1',
        status: ActivityRecordStatus.draft,
        createdBy: 'user-entry',
      }),
      location: { name: 'Ankara Plant' },
    });
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1', locationId: 'loc-1', ...data }),
      _count: { evidenceLinks: 0 },
      location: { name: 'Ankara Plant' },
    }));

    const dto = await service.update(standardUser(), 'rec-u', { activityValue: 5000 });

    expect(dto.locationName).toBe('Ankara Plant');
    const diff = audit.record.mock.calls[0][1].diff as any;
    // Whole key SET, on BOTH halves. A named check ("no `locationName`") is the
    // shape that let a fourth resolved field through, and `diff.before` was
    // asserted nowhere at all — on the very path this leak has a history on.
    expect(Object.keys(diff.before).sort()).toEqual(PERSISTED_KEYS);
    expect(Object.keys(diff.after).sort()).toEqual(PERSISTED_KEYS);
  });

  /**
   * Re-attribution — moving a record between reporting entities (WP18).
   *
   * The server has accepted this since 2026-07-07 and **nothing tested it**:
   * across all 13 `service.update()` calls in this file, not one passed
   * `locationId`, so neither the `connect`/`disconnect` branch nor its 409 had
   * any coverage. It matters more than an ordinary gap, because the client used
   * to abandon the edit on a location change and POST instead — creating the
   * second row that double-counts the month. The web fix only holds if the
   * server behaviour it now relies on is pinned.
   */
  describe('re-attribution (WP18)', () => {
    const draftAt = (locationId: string | null) => ({
      ...makeRecord({
        id: 'rec-move',
        subsidiaryId: 'sub-1',
        locationId,
        status: ActivityRecordStatus.draft,
        createdBy: 'user-entry',
      }),
      location: locationId ? { name: 'Ankara Plant' } : null,
    });

    it('moves a whole-company record onto a site, and recalculates for that site', async () => {
      const { prisma, calc, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
        ...makeRecord({ id: 'rec-move', subsidiaryId: 'sub-1', locationId: 'loc-1', ...data }),
        _count: { evidenceLinks: 0 },
        location: { name: 'Ankara Plant' },
      }));

      await service.update(standardUser(), 'rec-move', { locationId: 'loc-1' });

      // The same row, its site column rewritten: the record MOVES. A scalar
      // write, never the relation's `connect` — since LP4-01 the site key is
      // (location_id, subsidiary_id), and `connect` would copy the site's
      // subsidiary onto the record.
      const data = prisma.activityRecord.update.mock.calls[0][0].data;
      expect(data.locationId).toBe('loc-1');
      expect(data).not.toHaveProperty('location');
      expect(data).not.toHaveProperty('subsidiaryId');
      // And the snapshot is recomputed from the SITE's geography, not the
      // subsidiary's — the location is what decides which factor applies
      // (data_entry_page.md §5.2), so a move that kept the old factor would leave a record
      // whose stored provenance contradicts its own reporting entity.
      expect(calc.compute).toHaveBeenCalledWith(
        expect.objectContaining({ geographyCode: 'UK' }),
        expect.anything(),
      );
    });

    it("answers a site that no longer belongs to the record's subsidiary at the write (P2003) as location_not_found", async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt('loc-1'));
      prisma.activityRecord.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', { code: 'P2003', clientVersion: 'test' }),
      );

      await expect(service.update(standardUser(), 'rec-move', { locationId: 'loc-1' })).rejects.toMatchObject({ code: 'location_not_found' });
    });

    it('detaches a site record back to the whole company', async () => {
      const { prisma, calc, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt('loc-1'));
      prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
        ...makeRecord({ id: 'rec-move', subsidiaryId: 'sub-1', locationId: null, ...data }),
        _count: { evidenceLinks: 0 },
        location: null,
      }));

      await service.update(standardUser(), 'rec-move', { locationId: null });

      // `null` in the column alone: the relation's `disconnect` would NULL
      // the subsidiary half of the composite site key too (P2011, a 500).
      const data = prisma.activityRecord.update.mock.calls[0][0].data;
      expect(data.locationId).toBeNull();
      expect(data).not.toHaveProperty('location');
      expect(data).not.toHaveProperty('subsidiaryId');
      // Back to the SUBSIDIARY's geography. `null` and "omitted" are different
      // requests and the DTO validator lets both through, so this is the half
      // of the tri-state that a `@IsOptional()` reading would silently skip.
      expect(calc.compute).toHaveBeenCalledWith(
        expect.objectContaining({ geographyCode: 'TR' }),
        expect.anything(),
      );
    });

    it('leaves the location alone when the field is omitted', async () => {
      const { prisma, calc, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt('loc-1'));
      prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
        ...makeRecord({ id: 'rec-move', subsidiaryId: 'sub-1', locationId: 'loc-1', ...data }),
        _count: { evidenceLinks: 0 },
        location: { name: 'Ankara Plant' },
      }));

      await service.update(standardUser(), 'rec-move', { activityValue: 5000 });

      // The third arm of the tri-state: no `location` key at all, so an
      // unrelated edit cannot silently re-home the record...
      expect(prisma.activityRecord.update.mock.calls[0][0].data).not.toHaveProperty(
        'location',
      );
      // ...and the recompute still uses the location it already had.
      expect(calc.compute).toHaveBeenCalledWith(
        expect.objectContaining({ geographyCode: 'UK' }),
        expect.anything(),
      );
    });

    it('refuses to move onto an entity that already holds a record', async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      // Exactly the collision the six seeded duplicate pairs would produce if
      // someone tried to resolve one by moving. A 409, never a second row —
      // and never a silent overwrite of the record already sitting there.
      await expect(
        service.update(standardUser(), 'rec-move', { locationId: 'loc-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a location belonging to another subsidiary, before writing anything', async () => {
      const { prisma, service } = build(2);
      prisma.subsidiary.findUnique.mockResolvedValue(
        makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
      );
      prisma.location.findUnique.mockResolvedValue({
        id: 'loc-x',
        subsidiaryId: 'sub-2',
        geographyCode: 'UK',
      });
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));

      await expect(
        service.update(standardUser(), 'rec-move', { locationId: 'loc-x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Tenant isolation: a cross-tenant id must not be probeable through a
      // half-applied write, so nothing may reach the database.
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('cannot move a committed record at all', async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue({
        ...makeRecord({
          id: 'rec-move',
          subsidiaryId: 'sub-1',
          locationId: null,
          status: ActivityRecordStatus.approved,
          createdBy: 'user-entry',
        }),
        location: null,
      });

      // The limit of what PR 1 delivers, pinned so it is not mistaken for a
      // capability: all twelve rows in the six double-counted pairs are
      // `approved`, so the records that most need moving are exactly the ones
      // this refuses. Repairing them needs the audited correction path (PR 3).
      await expect(
        service.update(standardUser(), 'rec-move', { locationId: 'loc-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('re-evaluates the anomaly against the entity it moved TO, not the one it left', async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
        ...makeRecord({ id: 'rec-move', subsidiaryId: 'sub-1', locationId: 'loc-1', ...data }),
        _count: { evidenceLinks: 0 },
        location: { name: 'Ankara Plant' },
      }));

      await service.update(standardUser(), 'rec-move', { locationId: 'loc-1' });

      // The baseline is keyed on the reporting ENTITY (subsidiary + location +
      // category + granularity), and whole-company records form their own pool.
      // Measuring a moved record against the pool it just left would flag it as
      // anomalous for differing from consumption at a different site.
      const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
      expect(where.locationId).toBe('loc-1');
    });

    it('answers 404 for a location that does not exist, before writing anything', async () => {
      const { prisma, service } = build(2);
      prisma.subsidiary.findUnique.mockResolvedValue(
        makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
      );
      prisma.location.findUnique.mockResolvedValue(null);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));

      // Without the `!location` half of the guard this reaches `connect` and
      // Prisma raises P2025 — a 500 for what is plainly a bad request.
      await expect(
        service.update(standardUser(), 'rec-move', { locationId: 'loc-nope' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('does not report an unrelated database failure as a duplicate', async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
          code: 'P2003',
          clientVersion: 'test',
        }),
      );

      // A catch that answered 409 for everything would tell the user "an
      // activity record already exists for this reporting entity" whenever the
      // database failed for any reason at all — a specific, checkable claim,
      // and a false one.
      await expect(
        service.update(standardUser(), 'rec-move', { locationId: 'loc-1' }),
      ).rejects.not.toBeInstanceOf(ConflictException);
    });

    it('answers a lost race, not a duplicate, when the expected-status write matches nothing', async () => {
      // P2025 here is the compare-and-set behind the row lock missing — the
      // record left its status. It cannot happen under the protocol; if a
      // writer ever bypasses it, the answer is "reload", never "duplicate".
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record to update not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      const refusal = service.update(standardUser(), 'rec-move', { locationId: 'loc-1' });
      await expect(refusal).rejects.toBeInstanceOf(RecordChangedError);
      await expect(refusal).rejects.not.toBeInstanceOf(DuplicateActivityRecordError);
    });

    it('records both sides of the move in the audit diff', async () => {
      const { prisma, service } = build(2);
      withLocation(prisma);
      prisma.activityRecord.findUnique.mockResolvedValue(draftAt(null));
      prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
        ...makeRecord({ id: 'rec-move', subsidiaryId: 'sub-1', locationId: 'loc-1', ...data }),
        _count: { evidenceLinks: 0 },
        location: { name: 'Ankara Plant' },
      }));

      await service.update(standardUser(), 'rec-move', { locationId: 'loc-1' });

      // `audit_log` is append-only and has no correction path, so a move that
      // was not captured on both sides would be unreconstructable.
      const diff = audit.record.mock.calls[0][1].diff as any;
      expect(diff.before.locationId).toBeNull();
      expect(diff.after.locationId).toBe('loc-1');
    });
  });

  it('single-record reads carry the same include as the list (GET /:id agrees)', async () => {
    // The contract documents `locationName: null` as "subsidiary-level, or the
    // location has since been removed" — and this work package makes the second
    // case impossible. A GET that answered `null` for a located record would
    // therefore read as "orphaned, investigate".
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue({
      ...makeRecord({ id: 'rec-g', subsidiaryId: 'sub-1', locationId: 'loc-1' }),
      location: { name: 'Ankara Plant' },
    });

    const dto = await service.get(standardUser(), 'rec-g');

    expect(dto.locationName).toBe('Ankara Plant');
    expect(prisma.activityRecord.findUnique).toHaveBeenCalledWith({
      where: { id: 'rec-g' },
      include: { location: { select: { name: true } } },
    });
  });

  it('create asks for the include too — otherwise the 201 body lies', async () => {
    const { prisma, service } = build(2);
    withLocation(prisma);
    prisma.activityRecord.create.mockImplementation(({ data }: any) => ({
      ...makeRecord({ ...data, id: 'rec-new' }),
      location: { name: 'Ankara Plant' },
    }));

    await service.create(standardUser(), located);

    expect(prisma.activityRecord.create.mock.calls[0][0].include).toEqual({
      location: { select: { name: true } },
    });
  });
});

/**
 * Deleting a record cascades its evidence LINKS away inside Postgres, where no
 * application code sees them go. Before links existed that stranded the FILES:
 * storage is a separate system, and the local stack once held 1501 objects
 * against 102 rows. They are utility invoices, so files outliving every
 * pointer to them is a retention problem (KVKK/GDPR).
 *
 * Since WP8 PR7 a file can back several records, so a record delete must not
 * take a file another record still holds: the files are read before the
 * delete and only those left with no link are deleted after it.
 */
describe('ActivityRecordsService — deleting a record reclaims the files only it held', () => {
  function deletableRecord(prisma: PrismaMock) {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-del',
        subsidiaryId: 'sub-1',
        status: ActivityRecordStatus.draft,
        createdBy: 'user-entry',
      }),
    );
  }

  it('locks the record, then its files, deletes it and the files only it held in one transaction, then their objects', async () => {
    const { prisma, evidence, service } = build();
    deletableRecord(prisma);
    evidence.fileIdsFor.mockResolvedValue(['ev-1', 'ev-2']);
    evidence.deleteUnlinkedRows.mockResolvedValue([{ id: 'ev-2', storagePath: 'sub-1/ev-2.pdf' }]);

    await service.remove(standardUser(), 'rec-del');

    // Everything inside goes through the TRANSACTION's client.
    expect(evidence.fileIdsFor).toHaveBeenCalledWith('rec-del', prisma.tx);
    expect(evidence.deleteUnlinkedRows).toHaveBeenCalledWith(['ev-1', 'ev-2'], prisma.tx);
    expect(prisma.tx.activityRecord.delete).toHaveBeenCalledWith({ where: { id: 'rec-del' } });
    const rowLocks = prisma.tx.$queryRaw.mock.calls.map((c) => (c[0] as string[]).join('?'));
    expect(rowLocks[0]).toMatch(/"activity_records"[\s\S]*FOR UPDATE/);
    expect(prisma.tx.$queryRaw.mock.calls[0].slice(1)).toEqual([['rec-del']]);
    expect(rowLocks[1]).toMatch(/"evidence"[\s\S]*FOR UPDATE/);
    expect(prisma.tx.$queryRaw.mock.calls[1].slice(1)).toEqual([['ev-1', 'ev-2']]);
    // Only the objects of rows that went, and only after the commit.
    expect(evidence.removeBlobs).toHaveBeenCalledWith(['sub-1/ev-2.pdf']);
    // Order is the whole point: the period, then the record's lock before the
    // read (an upload's link either committed first and is read, or waits and
    // then fails), the read while the links still exist, the files' locks
    // before the record goes (a concurrent detach of a shared file waits),
    // the sweep once the links are gone, the objects last.
    const order = (fn: { mock: { invocationCallOrder: number[] } }, call = 0) =>
      fn.mock.invocationCallOrder[call];
    expect(order(prisma.tx.$executeRaw)).toBeLessThan(order(prisma.tx.$queryRaw));
    expect(order(prisma.tx.$queryRaw)).toBeLessThan(order(evidence.fileIdsFor));
    expect(order(evidence.fileIdsFor)).toBeLessThan(order(prisma.tx.$queryRaw, 1));
    expect(order(prisma.tx.$queryRaw, 1)).toBeLessThan(order(prisma.tx.activityRecord.delete));
    expect(order(prisma.tx.activityRecord.delete)).toBeLessThan(order(evidence.deleteUnlinkedRows));
    expect(order(evidence.deleteUnlinkedRows)).toBeLessThan(order(audit.record));
    expect(order(audit.record)).toBeLessThan(order(evidence.removeBlobs));
  });

  it('audits the files the record held and the ones deleted with it, with the real count, in the same transaction', async () => {
    // One audit row per record delete, so it is the only trace of the files.
    const { prisma, evidence, service } = build();
    deletableRecord(prisma);
    evidence.fileIdsFor.mockResolvedValue(['ev-1', 'ev-2']);
    evidence.deleteUnlinkedRows.mockResolvedValue([{ id: 'ev-2', storagePath: 'sub-1/ev-2.pdf' }]);

    await service.remove(standardUser(), 'rec-del');

    const [, row, client] = audit.record.mock.calls.at(-1)! as [
      unknown,
      { action: string; diff: { before: { evidenceCount: number }; evidence: unknown } },
      unknown,
    ];
    expect(client).toBe(prisma.tx);
    expect(row.action).toBe('delete');
    expect(row.diff.before.evidenceCount).toBe(2);
    expect(row.diff.evidence).toEqual({ fileIds: ['ev-1', 'ev-2'], deletedFileIds: ['ev-2'] });
  });

  it('removes no object when the audit fails — the delete rolled back', async () => {
    const { prisma, evidence, service } = build();
    deletableRecord(prisma);
    evidence.fileIdsFor.mockResolvedValue(['ev-1']);
    evidence.deleteUnlinkedRows.mockResolvedValue([{ id: 'ev-1', storagePath: 'sub-1/ev-1.pdf' }]);
    audit.record.mockRejectedValueOnce(new Error('audit down'));

    await expect(service.remove(standardUser(), 'rec-del')).rejects.toThrow(/audit down/);
    expect(evidence.removeBlobs).not.toHaveBeenCalled();
  });

  it('answers a lost race when the record was submitted while it waited for the lock', async () => {
    const { prisma, evidence, service } = build();
    const seen = makeRecord({ id: 'rec-del', status: ActivityRecordStatus.draft, createdBy: 'user-entry' });
    prisma.activityRecord.findUnique
      .mockResolvedValueOnce(seen)
      .mockResolvedValueOnce({ ...seen, status: ActivityRecordStatus.submitted });

    await expect(service.remove(standardUser(), 'rec-del')).rejects.toBeInstanceOf(RecordChangedError);
    expect(prisma.tx.activityRecord.delete).not.toHaveBeenCalled();
    expect(evidence.fileIdsFor).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is a 404 with no audit row when a concurrent delete removed the record while it waited for the lock', async () => {
    const { prisma, evidence, service } = build();
    deletableRecord(prisma);
    prisma.tx.$queryRaw.mockResolvedValue([]); // woke to no row

    await expect(service.remove(standardUser(), 'rec-del')).rejects.toBeInstanceOf(NotFoundException);
    expect(evidence.fileIdsFor).not.toHaveBeenCalled();
    expect(prisma.tx.activityRecord.delete).not.toHaveBeenCalled();
    expect(evidence.deleteUnlinkedRows).not.toHaveBeenCalled();
    expect(evidence.removeBlobs).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('touches no file when reading them fails — the record is not deleted either', async () => {
    const { prisma, evidence, service } = build();
    deletableRecord(prisma);
    evidence.fileIdsFor.mockRejectedValue(new Error('db down'));

    await expect(service.remove(standardUser(), 'rec-del')).rejects.toThrow(/db down/);
    expect(prisma.tx.activityRecord.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(evidence.deleteUnlinkedRows).not.toHaveBeenCalled();
    expect(evidence.removeBlobs).not.toHaveBeenCalled();
  });

  it('is not attempted for a record that is refused (gate runs first)', async () => {
    const { prisma, evidence, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.approved, createdBy: 'user-entry' }),
    );

    await expect(service.remove(standardUser(), 'rec-a')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(evidence.fileIdsFor).not.toHaveBeenCalled();
    expect(evidence.deleteUnlinkedRows).not.toHaveBeenCalled();
    expect(evidence.removeBlobs).not.toHaveBeenCalled();
    expect(prisma.tx.activityRecord.delete).not.toHaveBeenCalled();
  });
});

describe('ActivityRecordsService — RBAC', () => {
  it('a standard user cannot approve -> Forbidden', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.submitted, subsidiaryId: 'sub-1' }),
    );
    await expect(service.approve(standardUser(), 'rec-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('an auditor cannot approve -> Forbidden, naming both deciding roles', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.submitted }),
    );

    const refusal = await service.approve(auditor(), 'rec-a').catch((e) => e);
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect(refusal.message).toBe('Only a masterkey or a super_admin may approve records');
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['standard_user', standardUser],
    ['auditor', auditor],
  ] as const)('%s cannot reject -> Forbidden, nothing written (returning stays with the deciders)', async (_role, as) => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.submitted, createdBy: 'someone-else' }),
    );

    await expect(service.reject(as(), 'rec-a', 'Wrong meter')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a super_admin approves a standard user\'s submission in its company (INC-2.6 §1.1)', async () => {
    // Rewritten from the retired K2 case (a consultant approved): the
    // consultant role is gone, and a standard user's record in a company with
    // an active super_admin is that super_admin's to decide. Recorded like any
    // approval: the super_admin is the reviewer, and the audit row is its.
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.submitted, createdBy: 'user-entry' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-a', status: data.status, reviewedBy: data.reviewedBy }),
    );

    const dto = await service.approve(superAdmin(), 'rec-a');
    expect(dto.status).toBe(ActivityRecordStatus.approved);
    expect(prisma.activityRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ActivityRecordStatus.approved, reviewedBy: 'user-super-admin' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-super-admin', role: 'super_admin' }),
      expect.objectContaining({ action: 'approve', entity: 'activity_record' }),
      prisma.tx,
    );
  });

  it('masterkey approves a super_admin\'s submitted record (audited as `approve`)', async () => {
    // A super_admin's record is the masterkey's to decide (INC-2.6 §1.1).
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.submitted, createdBy: 'user-super-admin' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-a', status: data.status }),
    );

    const dto = await service.approve(masterkey(), 'rec-a');
    expect(dto.status).toBe(ActivityRecordStatus.approved);
    expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.objectContaining({
          action: 'approve',
          entity: 'activity_record',
        }),
        // Through the write's own transaction client (F02).
        prisma.tx,
      );
  });

  it('non-owner standard user cannot edit a peer record -> Forbidden', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        subsidiaryId: 'sub-1',
        createdBy: 'someone-else',
        status: ActivityRecordStatus.draft,
      }),
    );
    await expect(
      service.update(standardUser(), 'rec-1', { activityValue: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('masterkey may NOT edit a record created by someone else (BUG-R2-03: author only)', async () => {
    // Before 2026-11-10 a masterkey could change a colleague's draft and,
    // once its author submitted it, approve it — D01 compares the approver with
    // the creator only, so it could not see the edit.
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-o',
        subsidiaryId: 'sub-1',
        createdBy: 'someone-else',
        status: ActivityRecordStatus.draft,
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());

    const refusal = await service.update(masterkey(), 'rec-o', { activityValue: 100 }).catch((e) => e);
    expect(refusal).toBeInstanceOf(AuthorOnlyRefusedError);
    expect(errorCodeOf(refusal)).toBe('record_author_forbidden');
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.tx.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('masterkey edits a record they created', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-own',
        subsidiaryId: 'sub-1',
        createdBy: 'user-admin',
        status: ActivityRecordStatus.draft,
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-own', createdBy: 'user-admin', ...data }),
    );

    const dto = await service.update(masterkey(), 'rec-own', { activityValue: 100 });
    expect(dto.id).toBe('rec-own');
  });

  it('masterkey still deletes a colleague\'s draft — the author-only rule is for edits', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-d', subsidiaryId: 'sub-1', createdBy: 'someone-else', status: ActivityRecordStatus.draft }),
    );
    await service.remove(masterkey(), 'rec-d');
    expect(prisma.tx.activityRecord.delete).toHaveBeenCalledWith({ where: { id: 'rec-d' } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-admin' }),
      expect.objectContaining({ action: 'delete', entity: 'activity_record', entityId: 'rec-d' }),
      prisma.tx,
    );
  });

  // The API's edit gate and the contract's `mayEditRecord`, which the screens
  // read to offer Edit, must never disagree (BUG-R2-03 review).
  const ROLES = [
    ['standard_user author', standardUser(), 'user-entry'],
    ['standard_user, not the author', standardUser(), 'someone-else'],
    ['masterkey author', masterkey(), 'user-admin'],
    ['masterkey, not the author', masterkey(), 'user-entry'],
    ['super_admin author', superAdmin(), 'user-super-admin'],
    ['super_admin, not the author', superAdmin(), 'user-entry'],
    ['auditor author', auditor({ id: 'user-exec' }), 'user-exec'],
  ] as const;
  const STATUSES = Object.values(ActivityRecordStatus);
  it.each(ROLES.flatMap(([name, user, createdBy]) => STATUSES.map((status) => [name, user, createdBy, status] as const)))(
    '%s, %s record: the API refuses exactly when mayEditRecord says no',
    async (_name, user, createdBy, status) => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(
        makeRecord({ id: 'rec-m', subsidiaryId: 'sub-1', createdBy, status }),
      );
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
      prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-m', createdBy, status, ...data }));
      const allowed = mayEditRecord(user, { status, createdBy });
      const outcome = await service.update(user, 'rec-m', { activityValue: 5 }).then(() => 'ok', (e) => e);
      if (allowed) expect(outcome).toBe('ok');
      else expect(outcome).toBeInstanceOf(Error);
    },
  );

  it('a rejected record is edited by its author, but not by a masterkey', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-rj', subsidiaryId: 'sub-1', createdBy: 'user-entry', status: ActivityRecordStatus.rejected }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    await expect(service.update(masterkey(), 'rec-rj', { activityValue: 7 })).rejects.toBeInstanceOf(AuthorOnlyRefusedError);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-rj', status: ActivityRecordStatus.rejected, ...data }),
    );
    const dto = await service.update(standardUser(), 'rec-rj', { activityValue: 7 });
    expect(dto.id).toBe('rec-rj');
  });
});

describe('ActivityRecordsService — evidence on edit (BUG-R2-03, owner decision D1)', () => {
  function editable(prisma: PrismaMock, evidence: ReturnType<typeof build>['evidence'], files: string[]) {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-e', subsidiaryId: 'sub-1', category: 'Water', activityUnit: 'cubic_metres', createdBy: 'user-entry' }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-e', ...data }));
    evidence.fileIdsFor.mockResolvedValue(files);
  }
  const auditOfUpdate = () =>
    (audit.record.mock.calls as unknown[][]).find((c) => (c[1] as { action: string }).action === 'update')?.[1] as {
      diff: { after: { evidenceCount?: number }; evidence?: unknown };
    };

  it('a category change naming every file detaches them in the edit\'s transaction, then removes the deleted blobs', async () => {
    const { prisma, service, evidence } = build(2);
    editable(prisma, evidence, ['ev-1', 'ev-2']);
    evidence.detachLinksInTx.mockResolvedValue([{ id: 'ev-2', storagePath: 'sub-1/ev-2.pdf' }]);

    const dto = await service.update(standardUser(), 'rec-e', {
      category: 'Electricity', activityUnit: 'kWh', detachEvidenceIds: ['ev-2', 'ev-1'],
    } as never);

    expect(evidence.fileIdsFor).toHaveBeenCalledWith('rec-e', prisma.tx);
    expect(evidence.detachLinksInTx).toHaveBeenCalledWith(prisma.tx, expect.objectContaining({ id: 'user-entry' }), 'rec-e', ['ev-2', 'ev-1']);
    expect(evidence.removeBlobs).toHaveBeenCalledWith(['sub-1/ev-2.pdf']);
    expect(dto.evidenceCount).toBe(0);
    expect(auditOfUpdate().diff.after.evidenceCount).toBe(0);
    expect(auditOfUpdate().diff.evidence).toEqual({ detachedFileIds: ['ev-2', 'ev-1'], deletedFileIds: ['ev-2'] });
  });

  it('a category change that leaves a file attached is refused with evidence_detach_required, writing nothing', async () => {
    const { prisma, service, evidence } = build(2);
    editable(prisma, evidence, ['ev-1', 'ev-2']);

    const refusal = await service.update(standardUser(), 'rec-e', {
      category: 'Electricity', activityUnit: 'kWh', detachEvidenceIds: ['ev-1'],
    } as never).catch((e) => e);

    expect(refusal).toBeInstanceOf(EvidenceDetachRequiredError);
    expect(errorCodeOf(refusal)).toBe('evidence_detach_required');
    expect((refusal.getResponse() as { params: unknown }).params).toEqual({ linked: 2 });
    expect(prisma.tx.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(evidence.detachLinksInTx).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a category change with no list is refused the same way when the record has files', async () => {
    const { prisma, service, evidence } = build(2);
    editable(prisma, evidence, ['ev-1']);
    await expect(
      service.update(standardUser(), 'rec-e', { category: 'Electricity', activityUnit: 'kWh' } as never),
    ).rejects.toBeInstanceOf(EvidenceDetachRequiredError);
  });

  it('a category change needs no list when the record has no file', async () => {
    const { prisma, service, evidence } = build(2);
    editable(prisma, evidence, []);
    await service.update(standardUser(), 'rec-e', { category: 'Electricity', activityUnit: 'kWh' } as never);
    expect(evidence.detachLinksInTx).toHaveBeenCalledWith(prisma.tx, expect.anything(), 'rec-e', []);
    expect(evidence.removeBlobs).toHaveBeenCalledWith([]);
  });

  it('a year move with no list keeps every file', async () => {
    const { prisma, service, evidence } = build(2);
    editable(prisma, evidence, ['ev-1', 'ev-2']);
    const dto = await service.update(standardUser(), 'rec-e', { reportingYear: 2023 } as never);
    expect(evidence.detachLinksInTx).toHaveBeenCalledWith(prisma.tx, expect.anything(), 'rec-e', []);
    expect(dto.evidenceCount).toBe(2);
    expect(auditOfUpdate().diff.evidence).toBeUndefined();
  });

  it('a year move naming one file detaches only that one', async () => {
    const { prisma, service, evidence } = build(2);
    editable(prisma, evidence, ['ev-1', 'ev-2']);
    const dto = await service.update(standardUser(), 'rec-e', { reportingYear: 2023, detachEvidenceIds: ['ev-1'] } as never);
    expect(evidence.detachLinksInTx).toHaveBeenCalledWith(prisma.tx, expect.anything(), 'rec-e', ['ev-1']);
    expect(dto.evidenceCount).toBe(1);
  });

  it('a value-only edit may name a file too', async () => {
    const { prisma, service, evidence } = build(2);
    editable(prisma, evidence, ['ev-1']);
    const dto = await service.update(standardUser(), 'rec-e', { activityValue: 12, detachEvidenceIds: ['ev-1'] } as never);
    expect(evidence.detachLinksInTx).toHaveBeenCalledWith(prisma.tx, expect.anything(), 'rec-e', ['ev-1']);
    expect(dto.evidenceCount).toBe(0);
  });

  it('a file that is not linked to the record is evidence_not_found, writing nothing', async () => {
    const { prisma, service, evidence } = build(2);
    editable(prisma, evidence, ['ev-1']);
    const refusal = await service.update(standardUser(), 'rec-e', { activityValue: 12, detachEvidenceIds: ['ev-foreign'] } as never).catch((e) => e);
    expect(refusal).toBeInstanceOf(NotFoundException);
    expect(errorCodeOf(refusal)).toBe('evidence_not_found');
    expect(prisma.tx.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(evidence.detachLinksInTx).not.toHaveBeenCalled();
  });

  it('names one file once, however often the body repeats it', async () => {
    const { prisma, service, evidence } = build(2);
    editable(prisma, evidence, ['ev-1', 'ev-2']);
    await service.update(standardUser(), 'rec-e', { activityValue: 12, detachEvidenceIds: ['ev-1', 'ev-1'] } as never);
    expect(evidence.detachLinksInTx).toHaveBeenCalledWith(prisma.tx, expect.anything(), 'rec-e', ['ev-1']);
  });
});

describe('ActivityRecordsService — a decision names the submission it saw (BUG-R2-03 review)', () => {
  const SUBMITTED_AT = new Date('2026-11-10T09:00:00.000Z');
  function pending(prisma: PrismaMock, status: ActivityRecordStatus = ActivityRecordStatus.submitted) {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-v', subsidiaryId: 'sub-1', createdBy: 'user-entry', status, submittedAt: SUBMITTED_AT }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-v', status: data.status }));
  }

  it('refuses an approval of a submission the reviewer did not see — recalled and resubmitted since', async () => {
    const { prisma, service } = build();
    pending(prisma);
    await expect(service.approve(masterkey(), 'rec-v', '2026-11-10T08:00:00.000Z')).rejects.toBeInstanceOf(RecordChangedError);
    await expect(service.approve(masterkey(), 'rec-v', null)).rejects.toBeInstanceOf(RecordChangedError);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a rejection the same way', async () => {
    const { prisma, service } = build();
    pending(prisma, ActivityRecordStatus.under_review);
    await expect(service.reject(superAdmin(), 'rec-v', 'reason', '2026-11-10T08:00:00.000Z')).rejects.toBeInstanceOf(RecordChangedError);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a decision on the submission seen goes ahead, in any ISO spelling of the same instant', async () => {
    const { prisma, service } = build();
    pending(prisma);
    const dto = await service.reject(superAdmin(), 'rec-v', 'reason', '2026-11-10T11:00:00+02:00');
    expect(dto.status).toBe(ActivityRecordStatus.rejected);
  });

  it('compares nothing when the client names nothing', async () => {
    const { prisma, service } = build();
    pending(prisma);
    const dto = await service.reject(superAdmin(), 'rec-v', 'reason');
    expect(dto.status).toBe(ActivityRecordStatus.rejected);
  });

  it('refuses a decision that names no submission as record_changed, telling the client to reload (owner review P1)', async () => {
    const { prisma, service } = build();
    pending(prisma);
    for (const call of [
      () => service.approve(masterkey(), 'rec-v', SUBMISSION_NOT_NAMED),
      () => service.reject(superAdmin(), 'rec-v', 'reason', SUBMISSION_NOT_NAMED),
    ]) {
      const refusal = await call().catch((e) => e);
      expect(refusal).toBeInstanceOf(ReviewVersionRequiredError);
      expect(errorCodeOf(refusal)).toBe('record_changed');
      expect(refusal.message).toMatch(/Reload it/);
    }
    expect(prisma.tx.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('names the role before the missing submission: a standard user approving is still a 403', async () => {
    const { prisma, service } = build();
    pending(prisma);
    await expect(service.approve(standardUser(), 'rec-v', SUBMISSION_NOT_NAMED)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a super_admin passes the role check, so a missing submission is `record_changed`', async () => {
    const { prisma, service } = build();
    pending(prisma);
    const refusal = await service.approve(superAdmin(), 'rec-v', SUBMISSION_NOT_NAMED).catch((e) => e);
    expect(refusal).toBeInstanceOf(ReviewVersionRequiredError);
    expect(errorCodeOf(refusal)).toBe('record_changed');
    expect(prisma.tx.activityRecord.update).not.toHaveBeenCalled();
  });

  it('names a wrong status before a stale submission', async () => {
    const { prisma, service } = build();
    pending(prisma, ActivityRecordStatus.approved);
    await expect(service.reject(superAdmin(), 'rec-v', 'reason', '2026-11-10T08:00:00.000Z')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ActivityRecordsService — recall (BUG-R2-03)', () => {
  function submitted(prisma: PrismaMock, overrides: Partial<ActivityRecord> = {}) {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-rc', subsidiaryId: 'sub-1', createdBy: 'user-entry', status: ActivityRecordStatus.submitted, ...overrides }),
    );
  }

  it('takes its author\'s submitted record back to draft: inputs untouched, submittedAt cleared, audited as recall', async () => {
    const { prisma, service } = build();
    submitted(prisma);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-rc', status: data.status, submittedAt: data.submittedAt }),
    );

    const dto = await service.recall(standardUser(), 'rec-rc');

    expect(dto.status).toBe(ActivityRecordStatus.draft);
    const write = (prisma.tx.activityRecord.update.mock.calls[0] ?? prisma.activityRecord.update.mock.calls[0])[0];
    // A compare-and-set from the status it was locked in.
    expect(write.where).toEqual({ id: 'rec-rc', status: ActivityRecordStatus.submitted });
    expect(write.data.status).toBe(ActivityRecordStatus.draft);
    expect(write.data.submittedAt).toBeNull();
    // Nothing the figure was computed from, and no review stamp.
    for (const key of ['activityValue', 'activityUnit', 'category', 'calculation', 'parameters', 'reportingYear', 'periodValue', 'locationId', 'reviewedBy', 'reviewedAt']) {
      expect(write.data).not.toHaveProperty(key);
    }
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-entry' }),
      expect.objectContaining({ action: 'recall', entity: 'activity_record', entityId: 'rec-rc' }),
      prisma.tx,
    );
  });

  it('refuses a masterkey who is not the author (record_author_forbidden), writing nothing', async () => {
    const { prisma, service } = build();
    submitted(prisma);
    const refusal = await service.recall(masterkey(), 'rec-rc').catch((e) => e);
    expect(refusal).toBeInstanceOf(AuthorOnlyRefusedError);
    expect(errorCodeOf(refusal)).toBe('record_author_forbidden');
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.tx.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lets a masterkey recall a record they authored', async () => {
    const { prisma, service } = build();
    submitted(prisma, { createdBy: 'user-admin' });
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-rc', status: data.status }));
    const dto = await service.recall(masterkey(), 'rec-rc');
    expect(dto.status).toBe(ActivityRecordStatus.draft);
  });

  // The retired consultant seat is gone; the auditor is the one role left
  // that authors nothing (INC-2.6 §1).
  it('refuses an auditor by role, even on a record they authored', async () => {
    const { prisma, service } = build();
    submitted(prisma, { createdBy: 'user-seat' });
    await expect(service.recall(auditor({ id: 'user-seat' }), 'rec-rc')).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ActivityRecordStatus.draft,
    ActivityRecordStatus.under_review,
    ActivityRecordStatus.approved,
    ActivityRecordStatus.rejected,
    ActivityRecordStatus.locked,
    ActivityRecordStatus.voided,
  ])('refuses a %s record with record_not_recallable naming the status', async (status) => {
    const { prisma, service } = build();
    submitted(prisma, { status });
    const refusal = await service.recall(standardUser(), 'rec-rc').catch((e) => e);
    expect(refusal).toBeInstanceOf(RecordNotRecallableError);
    expect(errorCodeOf(refusal)).toBe('record_not_recallable');
    expect((refusal.getResponse() as { params: unknown }).params).toEqual({ status });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('names the status before the author: a colleague recalling a record in review hears it is in review', async () => {
    const { prisma, service } = build();
    submitted(prisma, { status: ActivityRecordStatus.under_review, createdBy: 'someone-else' });
    await expect(service.recall(standardUser(), 'rec-rc')).rejects.toBeInstanceOf(RecordNotRecallableError);
  });

  it('refuses in a locked period with the lock\'s own answer', async () => {
    const { prisma, service } = build();
    submitted(prisma);
    prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
    await expect(service.recall(standardUser(), 'rec-rc')).rejects.toBeInstanceOf(PeriodLockedError);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers 404 for another tenant\'s record', async () => {
    const { prisma, service } = build();
    submitted(prisma, { subsidiaryId: 'sub-foreign' });
    await expect(service.recall(standardUser(), 'rec-rc')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ActivityRecordsService — start review (FR §6.3)', () => {
  it('a super_admin takes a standard user\'s submitted record into under_review (audited)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-r', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-r', status: data.status }),
    );
    const dto = await service.startReview(superAdmin(), 'rec-r');
    expect(dto.status).toBe(ActivityRecordStatus.under_review);
    expect(prisma.tx.activityRecord.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reviewedBy: 'user-super-admin' }) }),
    );
    // The action taxonomy is the point of the change: a transition must no
    // longer be logged as a blanket 'update'.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ action: 'review', entity: 'activity_record' }),
      // Through the write's own transaction client (F02).
      prisma.tx,
    );
  });

  it(
    'refuses an auditor edit and delete even on a record they authored — the role gate alone',
    async () => {
      // A seat that authored drafts as a standard user and was then made an
      // auditor: the record is theirs and still editable, so only the role
      // gate refuses. The test above cannot see that gate — its record belongs
      // to someone else, and the author check answers first. (The retired
      // consultant seat was the other row of this case.)
      const { prisma, service } = build();
      const seat = auditor({ id: 'user-seat' });
      prisma.activityRecord.findUnique.mockResolvedValue(
        makeRecord({ id: 'rec-own', status: ActivityRecordStatus.draft, createdBy: 'user-seat' }),
      );

      await expect(
        service.update(seat, 'rec-own', { activityValue: 200 } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.remove(seat, 'rec-own')).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(prisma.tx.activityRecord.delete).not.toHaveBeenCalled();
    },
  );

  it('an auditor does not author: may NOT create, update, delete or submit', async () => {
    // INC-2.6 §1: the auditor reads the whole organisation and changes
    // nothing (formerly the consultant's case, decision 2026-07-30).
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-c', status: ActivityRecordStatus.draft }),
    );

    await expect(
      service.create(auditor(), {
        subsidiaryId: 'sub-1',
        locationId: null,
        reportingYear: 2024,
        reportingPeriod: 'quarterly',
        periodValue: 'Q1',
        category: 'Electricity',
        activityValue: 100,
        activityUnit: 'kWh',
      } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(
      service.update(auditor(), 'rec-c', { activityValue: 200 } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await expect(service.remove(auditor(), 'rec-c')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    // The CLASSES the bulk paths branch on: a role refusal is one 403 for a
    // whole batch, so both bulk services re-throw it by class.
    await expect(service.create(auditor(), {
      subsidiaryId: 'sub-1',
      locationId: null,
      reportingYear: 2024,
      reportingPeriod: 'quarterly',
      periodValue: 'Q1',
      category: 'Electricity',
      activityValue: 100,
      activityUnit: 'kWh',
    } as never)).rejects.toBeInstanceOf(CreateRoleRefusedError);
    await expect(service.submit(auditor(), 'rec-c')).rejects.toThrow(
      SUBMIT_ROLE_REFUSAL,
    );
    await expect(service.submit(auditor(), 'rec-c')).rejects.toBeInstanceOf(
      SubmitRoleRefusedError,
    );

    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.tx.activityRecord.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a super_admin takes a standard user\'s record into review and returns it with a comment', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-k', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-k', status: data.status, reviewNote: data.reviewNote }),
    );

    const reviewed = await service.startReview(superAdmin(), 'rec-k');
    expect(reviewed.status).toBe(ActivityRecordStatus.under_review);

    const rejected = await service.reject(superAdmin(), 'rec-k', 'missing invoice');
    expect(rejected.status).toBe(ActivityRecordStatus.rejected);
    expect(rejected.reviewNote).toBe('missing invoice');
  });

  it('a standard user cannot start a review -> Forbidden', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.submitted, subsidiaryId: 'sub-1' }),
    );
    await expect(service.startReview(standardUser(), 'rec-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('only a submitted record can enter review (draft -> BadRequest)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.draft }),
    );
    await expect(service.startReview(superAdmin(), 'rec-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('a locked period blocks starting a review (409, no write)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.submitted }),
    );
    prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
    await expect(service.startReview(superAdmin(), 'rec-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  // WP5 (`uat4-review-resubmit`): the author is refused the start of review —
  // since INC-2.6 every author but a masterkey (whose own record is theirs to
  // decide, a self-approval). Rewritten from the masterkey case.
  it('refuses a super_admin taking their own record into review, writing nothing', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-own', status: ActivityRecordStatus.submitted, createdBy: 'user-super-admin' }),
    );
    const refusal = service.startReview(superAdmin(), 'rec-own');
    await expect(refusal).rejects.toBeInstanceOf(SelfReviewRefusedError);
    await expect(service.startReview(superAdmin(), 'rec-own')).rejects.toMatchObject({
      response: { code: 'self_review_forbidden' },
    });
    await expect(service.startReview(superAdmin(), 'rec-own')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.tx.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a former author, now a super_admin, whatever role they hold now', async () => {
    const { prisma, service } = build();
    prisma.people.set('user-moved', { role: 'super_admin', grants: ['sub-1'] });
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-old', status: ActivityRecordStatus.submitted, createdBy: 'user-moved' }),
    );
    await expect(
      service.startReview(superAdmin({ id: 'user-moved' }), 'rec-old'),
    ).rejects.toBeInstanceOf(SelfReviewRefusedError);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('gives a standard user author the plain role refusal, not self_review_forbidden', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.submitted, createdBy: 'user-entry' }),
    );
    const refusal = service.startReview(standardUser(), 'rec-1');
    await expect(refusal).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.startReview(standardUser(), 'rec-1')).rejects.not.toBeInstanceOf(
      SelfReviewRefusedError,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('still lets a masterkey take a super_admin\'s record into review', async () => {
    // A super_admin's record is the masterkey's (INC-2.6 §1.1); a standard
    // user's, in a company with an active super_admin, is not (see the
    // approver chain below).
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-other', status: ActivityRecordStatus.submitted, createdBy: 'user-super-admin' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-other', status: data.status }),
    );
    const dto = await service.startReview(masterkey(), 'rec-other');
    expect(dto.status).toBe(ActivityRecordStatus.under_review);
  });
});

describe('ActivityRecordsService — transition rules', () => {
  it('approving a draft record -> BadRequest', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ status: ActivityRecordStatus.draft }),
    );
    await expect(service.approve(masterkey(), 'rec-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('editing an approved record -> BadRequest (immutable)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        subsidiaryId: 'sub-1',
        createdBy: 'user-entry',
        status: ActivityRecordStatus.approved,
      }),
    );
    await expect(
      service.update(standardUser(), 'rec-1', { activityValue: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deleting a locked record -> BadRequest (immutable)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        subsidiaryId: 'sub-1',
        createdBy: 'user-entry',
        status: ActivityRecordStatus.locked,
      }),
    );
    await expect(service.remove(standardUser(), 'rec-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('submit moves draft -> submitted (by its author) and audits', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-s', status: ActivityRecordStatus.draft }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-s', status: data.status }),
    );

    const dto = await service.submit(standardUser(), 'rec-s');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ action: 'submit', entity: 'activity_record' }),
      // Through the write's own transaction client (F02).
      prisma.tx,
    );
  });

  it('a REJECTED record can be resubmitted, and keeps the reviewer\'s note', async () => {
    // Rejection must not be a one-way door. `update` allows editing a rejected
    // record but never moved it back to `draft`, and submit accepted only
    // `draft` — so every rejected record was permanently stranded: excluded
    // from the counted statuses, dropped from the inventory, and pinning its
    // report to `contains_incomplete_data` with no API path back.
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-r',
        status: ActivityRecordStatus.rejected,
        reviewNote: 'invoice mismatch',
      }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-r', status: data.status, reviewNote: data.reviewNote }),
    );

    const dto = await service.submit(standardUser(), 'rec-r');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    // The note is NOT destroyed: it is the reviewer's only in-record signal that
    // this record has been round the loop before, and `/review` renders it as
    // "Previous review note". The stale-note problem is solved by rendering it
    // only on a rejected record, not by deleting the value.
    const data = prisma.activityRecord.update.mock.calls[0][0].data;
    expect('reviewNote' in data).toBe(false);
  });

  it('a non-author may not resubmit — that would overturn a rejection', async () => {
    // `update`/`remove` already gate on the author; submit did not, so any
    // data_entry user who could see the subsidiary could undo a reviewer's
    // decision while still being forbidden from fixing the number.
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-n',
        status: ActivityRecordStatus.rejected,
        createdBy: 'someone-else',
      }),
    );

    await expect(service.submit(standardUser(), 'rec-n')).rejects.toThrow(
      RESUBMIT_AUTHOR_REFUSAL,
    );
    await expect(service.submit(standardUser(), 'rec-n')).rejects.toBeInstanceOf(
      SubmitAuthorRefusedError,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  // Decision D02 (2026-09-29): only the author submits — a draft as much as a
  // rejected record, and masterkey is not exempt. Before it, any colleague
  // who could see the subsidiary could submit someone else's draft.
  it.each([
    ['a colleague', standardUser],
    ['a masterkey', masterkey],
  ] as const)("%s may not submit someone else's draft (D02)", async (_who, caller) => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-o', status: ActivityRecordStatus.draft, createdBy: 'someone-else' }),
    );

    await expect(service.submit(caller(), 'rec-o')).rejects.toThrow(SUBMIT_AUTHOR_REFUSAL);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a masterkey may not resubmit a record they did not author either (D02)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-sa',
        status: ActivityRecordStatus.rejected,
        createdBy: 'someone-else',
      }),
    );

    await expect(service.submit(masterkey(), 'rec-sa')).rejects.toBeInstanceOf(
      SubmitAuthorRefusedError,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('a masterkey submits a record they authored', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-own', status: ActivityRecordStatus.draft, createdBy: 'user-admin' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-own', status: data.status, createdBy: 'user-admin' }),
    );

    const dto = await service.submit(masterkey(), 'rec-own');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
  });

  // Decision D01 (2026-09-29): segregation of duties — the approver is neither
  // the record's creator nor its submitter. Since INC-2.6 (ruling R1) a
  // masterkey is the one exception: their own record is theirs alone, as a
  // self-approval (see "the approver chain" below). Rewritten from the
  // masterkey case, whose premise that rule retired.
  it('a super_admin may not approve a record they created (D01)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-self', status: ActivityRecordStatus.submitted, createdBy: 'user-super-admin' }),
    );

    await expect(service.approve(superAdmin(), 'rec-self')).rejects.toBeInstanceOf(
      SelfApprovalRefusedError,
    );
    await expect(service.approve(superAdmin(), 'rec-self')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('D01 binds a former author whose role changed: now a super_admin, they may not approve their own record', async () => {
    // Created as a standard user, then made a super_admin granted the company
    // (`PATCH /users/:id/role` keeps the id). D01 compares the id.
    const { prisma, service } = build();
    prisma.people.set('user-moved', { role: 'super_admin', grants: ['sub-1'] });
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-self', status: ActivityRecordStatus.submitted, createdBy: 'user-moved' }),
    );

    await expect(service.approve(superAdmin({ id: 'user-moved' }), 'rec-self')).rejects.toBeInstanceOf(SelfApprovalRefusedError);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a masterkey author returns their own record — it is theirs to decide (INC-2.6 ruling R1)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-self', status: ActivityRecordStatus.submitted, createdBy: 'user-admin' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-self', status: data.status, createdBy: 'user-admin' }),
    );

    await expect(service.reject(masterkey(), 'rec-self', 'Wrong meter')).resolves.toMatchObject({
      status: ActivityRecordStatus.rejected,
    });
  });

  it('a first submit does not touch reviewNote at all', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-d', status: ActivityRecordStatus.draft }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-d', status: data.status }),
    );

    await service.submit(standardUser(), 'rec-d');
    const data = prisma.activityRecord.update.mock.calls[0][0].data;
    expect('reviewNote' in data).toBe(false);
  });

  /**
   * the revision elements FR §4.3 requires (WP18 PR 2a) — withdrawing an approved figure.
   *
   * The only transition out of `approved` other than the lock/unlock cycle, so
   * every guard here is load-bearing: this is the one path that can remove a
   * reviewed number from the reported inventory.
   */
  describe('void — withdrawing an approved figure (the void path)', () => {
    const approved = (over: Partial<ActivityRecord> = {}) =>
      makeRecord({
        id: 'rec-v',
        status: ActivityRecordStatus.approved,
        calculation: { tCo2e: 19.8, factorId: 'factor-1' },
        ...over,
      } as Partial<ActivityRecord>);

    it('withdraws the figure without deleting the row', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-v', ...data }),
      );

      await service.void(masterkey(), 'rec-v', 'Duplicate of the site invoice for January');

      // The whole point: an UPDATE, never a delete. The row, its evidence and
      // its immutable calculation snapshot all survive — what changes is that
      // it stops counting.
      expect(prisma.tx.activityRecord.delete).not.toHaveBeenCalled();
      const data = prisma.activityRecord.update.mock.calls[0][0].data;
      expect(data.status).toBe(ActivityRecordStatus.voided);
      expect(data.calculation).toBeUndefined();
      // three of the four elements FR §4.3 lists, stamped on the row rather than left for a
      // screen to reconstruct from the audit log.
      expect(data.voidReason).toBe('Duplicate of the site invoice for January');
      expect(data.voidedBy).toBe('user-admin');
      expect(data.voidedAt).toBeInstanceOf(Date);
    });

    it('refuses a record outside the caller\'s accessible set, as NOT FOUND', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(
        approved({ subsidiaryId: 'sub-other' } as Partial<ActivityRecord>),
      );

      // Tenant isolation on the newest mutation endpoint, which had none. Not
      // found rather than forbidden, and refused before any write, so a
      // masterkey of one tenant cannot use the response to confirm that a
      // record exists in another.
      await expect(
        service.void(
          masterkey({ accessibleSubsidiaryIds: ['sub-1'] }),
          'rec-v',
          'A reason long enough to pass',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('checks tenancy BEFORE the role, so a 403 cannot confirm existence', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(
        approved({ subsidiaryId: 'sub-other' } as Partial<ActivityRecord>),
      );

      // A super_admin asking about another company's record must get the same
      // answer as one asking about a record that does not exist.
      // Ordering the role gate first would leak existence through the
      // difference between 403 and 404.
      await expect(
        service.void(
          superAdmin({ accessibleSubsidiaryIds: ['sub-1'] }),
          'rec-v',
          'A reason long enough to pass',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the withdrawal on the record itself, not only in the audit log', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-v', ...data }),
      );

      const dto = await service.void(masterkey(), 'rec-v', 'Superseded by the site invoice');

      // `/audit` is masterkey-only, so for every other seat the record itself
      // is the only place the withdrawal is visible at all.
      expect(dto.voidReason).toBe('Superseded by the site invoice');
      expect(dto.voidedBy).toBe('user-admin');
      expect(dto.voidedAt).not.toBeNull();
    });

    it('names the person on the WRITE response, not only on a later read', async () => {
      const { prisma, service } = build();
      prisma.profile.findMany.mockResolvedValue([]);
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-v', ...data }),
      );

      const dto = await service.void(masterkey(), 'rec-v', 'Superseded by the site invoice');

      // The exact regression three review seats independently found on the
      // reviewer column in WP22 PR D: both screens splice a write response into
      // read-built state, so a write path that omits the name empties the
      // column at the very click that sets the actor — "Withdrawn by —" on a
      // figure this request just withdrew.
      //
      // `profile.findMany` returns NOTHING here on purpose: the acting user is
      // seeded into the actor map from the request itself, so resolving them
      // must not depend on a database round-trip that the write path has no
      // reason to make.
      expect(dto.voidedByName).toBe('Admin User');
    });

    it('distinguishes "never withdrawn" from "the person who withdrew it is gone"', async () => {
      const { prisma, service } = build();
      prisma.profile.findMany.mockResolvedValue([]);
      prisma.activityRecord.findUnique.mockResolvedValue(
        makeRecord({ subsidiaryId: 'sub-1', voidedBy: 'user-ghost' }),
      );

      const dto = await service.get(auditor(), 'rec-1');

      // Both read `voidedByName: null`; `voidedBy` is the discriminator, which
      // is why it stays on the DTO beside the name. Rendering a never-withdrawn
      // record as "withdrawn by a deleted user" would claim a restatement that
      // never happened — and a withdrawal is the one action here that cannot be
      // undone.
      expect(dto.voidedByName).toBeNull();
      expect(dto.voidedBy).toBe('user-ghost');

      prisma.activityRecord.findUnique.mockResolvedValue(
        makeRecord({ subsidiaryId: 'sub-1', voidedBy: null }),
      );
      const never = await service.get(auditor(), 'rec-1');
      expect(never.voidedByName).toBeNull();
      expect(never.voidedBy).toBeNull();
    });

    it('is masterkey only — a super_admin may approve and return, never withdraw (INC-2.6 R4)', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());

      // A super_admin reviews, returns and approves records of their company.
      // Taking an accepted figure out of the reported inventory stays the
      // organisation-wide administrator's: approving does not grant voiding.
      await expect(
        service.void(superAdmin(), 'rec-v', 'Not my call to make'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.void(standardUser(), 'rec-v', 'Not my call to make'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.void(auditor(), 'rec-v', 'Not my call to make'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses anything that is not approved, naming the unlock path', async () => {
      const { prisma, service } = build();
      for (const status of [
        ActivityRecordStatus.draft,
        ActivityRecordStatus.rejected,
        ActivityRecordStatus.submitted,
        ActivityRecordStatus.under_review,
        ActivityRecordStatus.voided,
      ]) {
        prisma.activityRecord.findUnique.mockResolvedValue(approved({ status }));
        await expect(
          service.void(masterkey(), 'rec-v', 'A reason long enough to pass'),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      // `locked` is the one worth naming: it means the period is closed, and
      // letting a void bypass that would make the lock a suggestion.
      prisma.activityRecord.findUnique.mockResolvedValue(
        approved({ status: ActivityRecordStatus.locked }),
      );
      await expect(
        service.void(masterkey(), 'rec-v', 'A reason long enough to pass'),
      ).rejects.toThrow(/unlocked first/i);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('cannot be undone by voiding twice, or edited back into the inventory', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(
        approved({ status: ActivityRecordStatus.voided }),
      );

      // A voided record is outside EDITABLE_STATUSES and SUBMITTABLE_STATUSES,
      // so there is no route back in. That is deliberate: re-entering a figure
      // means recording it again, with its own provenance, not resurrecting a
      // withdrawn one.
      // Its author is refused for the status (a masterkey, since BUG-R2-03,
      // for not being the author).
      await expect(
        service.update(standardUser({ id: approved({}).createdBy ?? 'user-entry' }), 'rec-v', { activityValue: 5000 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update(masterkey(), 'rec-v', { activityValue: 5000 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Nor can it be recalled: recall leaves `submitted` only.
      await expect(service.recall(standardUser(), 'rec-v')).rejects.toBeInstanceOf(RecordNotRecallableError);
      await expect(service.submit(masterkey(), 'rec-v')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.remove(masterkey(), 'rec-v')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses inside a locked period even for an approved record', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });

      await expect(
        service.void(masterkey(), 'rec-v', 'A reason long enough to pass'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('writes only while the record is still approved, so a lock cannot be overwritten', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-v', ...data }),
      );

      await service.void(masterkey(), 'rec-v', 'A reason long enough to pass');

      // The status is part of the WHERE, not just the guard above it. Every
      // other transition writes on the id alone and is safe doing so, because
      // `lock` refuses to run while a pending-review record exists — but
      // `approved` is the one status `lock` DOES mutate. A lock committing
      // between the check and the write would otherwise be silently
      // overwritten, leaving the record voided inside a closed period with no
      // unlock able to reopen it.
      expect(prisma.activityRecord.update.mock.calls[0][0].where).toEqual({
        id: 'rec-v',
        status: ActivityRecordStatus.approved,
      });
    });

    it('answers 409, not 500, when the record moves out from under the write', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record to update not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      // The row plainly exists — it was just read. P2025 here means it stopped
      // being `approved`, in practice because a lock landed in the window, so
      // the honest answer is the lock's own refusal rather than a server error.
      await expect(
        service.void(masterkey(), 'rec-v', 'A reason long enough to pass'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('audits the withdrawal under its own verb, carrying the figure it removed', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.findUnique.mockResolvedValue(approved());
      prisma.activityRecord.update.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-v', ...data }),
      );

      await service.void(masterkey(), 'rec-v', 'Duplicate of the site invoice');

      const call = audit.record.mock.calls[0][1];
      // Its own verb, not a generic `update`: "what was restated and why" has
      // to be filterable in the trail rather than buried in a diff.
      expect(call.action).toBe('void');
      expect(call.diff.transition).toEqual({ from: 'approved', to: 'voided' });
      expect(call.diff.voidReason).toBe('Duplicate of the site invoice');
      // The audit row is the last place the withdrawn figure is reported
      // alongside the reason — FR §4.3's "original value visibility".
      expect(call.diff.before.calculation).toEqual({ tCo2e: 19.8, factorId: 'factor-1' });
      expect(call.diff.before.status).toBe('approved');
    });
  });

  it('still refuses to submit an approved record', async () => {
    // Widening submit to accept `rejected` must not have widened it to anything
    // else — an approved record is immutable.
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.approved }),
    );

    await expect(service.submit(standardUser(), 'rec-a')).rejects.toThrow(
      /draft or returned/i,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('does not re-police the unit when an edit did not change it', async () => {
    // The category/unit map is new. A record stored before it (gas in MWh, say)
    // would otherwise 400 on ANY edit — including one that never touched the
    // unit — with a message telling the user to change a historical figure.
    const { prisma, calc, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-u',
        subsidiaryId: 'sub-1',
        createdBy: 'user-entry',
        status: ActivityRecordStatus.rejected,
        activityUnit: 'MWh',
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(standardUser(), 'rec-u', { varianceReason: 'a note' });

    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ unit: 'MWh' }),
      { enforceCategoryUnit: false },
    );
  });

  it('blocks submit of an evidence-required category with no evidence (FR §4.1)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-e', category: 'Electricity', status: ActivityRecordStatus.draft }),
    );
    prisma.activityRecordEvidence.count.mockResolvedValue(0); // no evidence attached

    // The sentence is user-facing copy (the web mirrors it); the bulk submit
    // tells this refusal from the status one by its CLASS, asserted below.
    await expect(service.submit(standardUser(), 'rec-e')).rejects.toThrow(
      EVIDENCE_REFUSAL_FRAGMENT,
    );
    await expect(service.submit(standardUser(), 'rec-e')).rejects.toBeInstanceOf(
      EvidenceRequiredError,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    // THIS record's files: an unscoped count would let one link anywhere
    // clear the gate for every evidence-required record.
    expect(prisma.activityRecordEvidence.count).toHaveBeenCalledWith({
      where: { activityRecordId: 'rec-e' },
    });
  });

  it('reject moves submitted -> rejected and stores the reviewer note (not varianceReason)', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-r', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({
        id: 'rec-r',
        status: data.status,
        varianceReason: data.varianceReason,
        reviewNote: data.reviewNote,
        reviewedBy: data.reviewedBy,
        reviewedAt: data.reviewedAt,
      }),
    );

    const dto = await service.reject(superAdmin(), 'rec-r', 'invoice mismatch');
    expect(dto.status).toBe(ActivityRecordStatus.rejected);
    const updateArg = prisma.activityRecord.update.mock.calls[0][0];
    // The reviewer's reason is its own field; the author's variance
    // justification (VAR §4) must survive untouched.
    expect(updateArg.data.reviewNote).toBe('invoice mismatch');
    expect(updateArg.data.varianceReason).toBeUndefined();
    expect(updateArg.data.reviewedBy).toBeDefined();
    expect(updateArg.data.reviewedAt).toBeInstanceOf(Date);
    // …and it must be READABLE: the reason is worthless if no DTO exposes it.
    expect(dto.reviewNote).toBe('invoice mismatch');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ action: 'reject', entity: 'activity_record' }),
      // Through the write's own transaction client (F02).
      prisma.tx,
    );
  });

  it('update recomputes the calc snapshot on value change', async () => {
    const { prisma, calc, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-u',
        subsidiaryId: 'sub-1',
        createdBy: 'user-entry',
        status: ActivityRecordStatus.rejected,
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(standardUser(), 'rec-u', { activityValue: 90000 });
    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ value: 90000, geographyCode: 'TR' }),
      expect.anything(),
    );
    const updateArg = prisma.activityRecord.update.mock.calls[0][0];
    expect(updateArg.data.calculation).toEqual(calc.snapshot);
  });
});

describe('ActivityRecordsService — anomaly detection (VAR §4)', () => {
  // calc.compute() returns tCo2e 19.8 for the record being written.
  const MONTHLY_DTO = {
    ...CREATE_DTO,
    reportingPeriod: 'monthly' as const,
    periodValue: 'March',
  };
  // A third prior usually has to come from the PREVIOUS year — the subject is
  // March, and only two months precede it inside 2024. That is not a workaround:
  // the baseline query has no `reportingYear` filter (the year enters through
  // the ordinal key alone, so December seeds January), and until VAR §4.1
  // required three priors nothing exercised it.
  const priorMonth = (periodValue: string, tCo2e: number, reportingYear?: number) =>
    makeRecord({
      reportingPeriod: 'monthly',
      periodValue,
      ...(reportingYear !== undefined ? { reportingYear } : {}),
      status: ActivityRecordStatus.approved,
      // `factorId` for the same reason as makeRecord's default: a stored,
      // calculated prior always carries the factor it used, and isCalculated()
      // is what decides whether a prior can seed the baseline.
      calculation: { tCo2e, factorId: 'f-1' },
    });

  it('flags an anomaly when tCO₂e deviates >50% from the rolling 3-period baseline', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // Baseline avg = 10; current = 19.8 → +98% → anomaly.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 10, 2023),
      priorMonth('January', 10),
      priorMonth('February', 10),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(standardUser(), MONTHLY_DTO);

    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(true);
    expect(dto.anomalyFlag).toBe(true);
  });

  it('does not flag a value within 50% of the baseline', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // Baseline avg = 15; current = 19.8 → +32% → within threshold.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 15, 2023),
      priorMonth('January', 15),
      priorMonth('February', 15),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), MONTHLY_DTO);
    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(false);
  });

  it('does not flag the first-ever entry (no baseline to deviate from)', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([]); // no prior periods
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), MONTHLY_DTO);
    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(false);
  });

  it('judges against an old period when nothing newer exists — the window has no age limit', async () => {
    // The only earlier period of the series is two years back. It is still the
    // history: the window is the most recent periods there ARE, not the last
    // few on the calendar. (A limit is an open question, not a rule.)
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('March', 10, 2022)]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), MONTHLY_DTO);

    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyBaselinePriorCount).toBe(1);
    expect(data.anomalyBaselineTCo2e).toBe(10);
    expect(data.anomalyFlag).toBe(true);
  });

  it('excludes later periods and the record itself from its own baseline', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // A FUTURE month (April) must not seed the March baseline; only Jan/Feb count.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 10, 2023),
      priorMonth('January', 10),
      priorMonth('February', 10),
      priorMonth('April', 40), // later than March → ignored
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), MONTHLY_DTO);
    // The intruder's VALUE is load-bearing. At 19 this test could not fail: an
    // admitted April gives a baseline of 13, and 19.8 is +52% of that — still
    // flagged, still green. At 40 an admitted April gives 20, and 19.8 is -1%,
    // so the assertion below genuinely depends on April being excluded.
    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(true);
  });

  it('scopes the baseline query to the reporting entity + granularity + committed statuses', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), MONTHLY_DTO);

    const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      subsidiaryId: 'sub-1',
      locationId: null,
      category: 'Electricity',
      reportingPeriod: 'monthly',
      status: {
        in: [
          ActivityRecordStatus.submitted,
          ActivityRecordStatus.under_review,
          ActivityRecordStatus.approved,
          ActivityRecordStatus.locked,
        ],
      },
    });
  });

  it('only the most recent 3 priors count (older ones are dropped)', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // Current = May (19.8). Recent 3 (Apr/Mar/Feb) avg = 10 → anomaly; if the
    // oldest (January = 100) also counted, avg = 32.5 → NOT an anomaly.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 100),
      priorMonth('February', 10),
      priorMonth('March', 10),
      priorMonth('April', 10),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), { ...MONTHLY_DTO, periodValue: 'May' });
    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(true);
  });

  // --- The strict window, and the provenance that makes it legible ---------
  //
  // VAR §4.1 asks for the previous THREE periods. The rule used to run on as
  // few as one, so a green cell could mean "compared against one month" and
  // nothing said so. Fewer than three is now NOT EVALUATED, and the count
  // travels with the verdict — without it the strict rule would be strictly
  // less informative than the loose one it replaced.

  it('does not flag a deviation of exactly the threshold (VAR §4.2 says MORE than)', async () => {
    const { prisma, calc, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // 15 against a baseline of 10 is +50% EXACTLY, and all three of 15, 10 and
    // the 5 between them are exact in binary. The suite's usual 19.8 cannot
    // express this case at all: 19.8 - 13.2 is 6.600000000000001, so the ratio
    // lands a hair ABOVE the threshold and the boundary is never reached.
    calc.compute.mockResolvedValue({ ...calc.snapshot, tCo2e: 15, kgCo2e: 15000 });
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 10, 2023),
      priorMonth('January', 10),
      priorMonth('February', 10),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), MONTHLY_DTO);

    // `>` vs `>=` on the threshold survived the whole suite until this test:
    // every other fixture sits far from the boundary, so the one comparison
    // VAR §4.2 words precisely ("more than 50 percent") was unpinned.
    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(false);
    expect(data.anomalyBaselinePriorCount).toBe(3);
    expect(data.anomalyBaselineTCo2e).toBe(10);
  });

  // BUG-R2-07 (2026-11-11): one or two priors are a limited-history verdict.
  // From 2026-08-27 until then this exact case asserted the opposite — flag
  // false, average null — because the rule needed three.
  it('judges a value on two priors against their average, and records how many it had', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // 19.8 against an average of 10 is +98%.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 8),
      priorMonth('February', 12),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(standardUser(), MONTHLY_DTO);

    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(true);
    expect(data.anomalyBaselinePriorCount).toBe(2);
    // The average the rule USED, so a screen can show what the value was
    // judged against — and the count beside it says it was only two periods.
    expect(data.anomalyBaselineTCo2e).toBe(10);
    expect(dto.anomalyFlag).toBe(true);
    expect(dto.anomalyBaselinePriorCount).toBe(2);
    expect(dto.anomalyBaselineTCo2e).toBe(10);
  });

  it.each([
    [10, true], // +98%
    [15, false], // +32%
    [45, true], // -56%: a collapse against the only period there is
  ])('judges a value on ONE prior of %d → flag %s', async (prior, flagged) => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('February', prior)]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), MONTHLY_DTO);

    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(flagged);
    expect(data.anomalyBaselinePriorCount).toBe(1);
    expect(data.anomalyBaselineTCo2e).toBe(prior);
  });

  it('does not flag against a single prior of zero — there is no ratio to take', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('February', 0)]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), MONTHLY_DTO);

    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(false);
    expect(data.anomalyBaselinePriorCount).toBe(1);
    expect(data.anomalyBaselineTCo2e).toBe(0);
  });

  it('persists the baseline it judged against when the window is full', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 9, 2023),
      priorMonth('January', 10),
      priorMonth('February', 11),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(standardUser(), MONTHLY_DTO);

    expect(dto.anomalyBaselinePriorCount).toBe(3);
    expect(dto.anomalyBaselineTCo2e).toBe(10);
    expect(dto.anomalyFlag).toBe(true); // 19.8 vs 10 → +98%
  });

  it('a prior without a figure consumes a slot, leaving the window on limited history', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      // Older — must NOT be pulled in to fill the gap. 100, so that pulling it
      // in would move the average to 40 and clear the flag.
      priorMonth('November', 100, 2023),
      priorMonth('December', 10, 2023),
      priorMonth('January', 10),
      // An invoice-tracked category with no factor: stored, committed, and
      // carrying no tCO₂e. It is the NEWEST prior, so it takes a slot.
      makeRecord({
        reportingPeriod: 'monthly',
        periodValue: 'February',
        status: ActivityRecordStatus.approved,
        calculation: { reasonCode: 'no_emission_factor' },
      }),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), MONTHLY_DTO);

    // Two figures out of three slots → judged on those two, even though a
    // fourth comparable period exists just outside the window.
    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyBaselinePriorCount).toBe(2);
    expect(data.anomalyBaselineTCo2e).toBe(10);
    expect(data.anomalyFlag).toBe(true); // 19.8 vs 10
  });

  it('reports a full window that averages to zero rather than hiding it', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 0, 2023),
      priorMonth('January', 0),
      priorMonth('February', 0),
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), MONTHLY_DTO);

    // No ratio is computable against zero, so no warning — but three priors of
    // zero is a fact about the series, and the record says so instead of
    // reading like a record that had no priors at all.
    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(false);
    expect(data.anomalyBaselinePriorCount).toBe(3);
    expect(data.anomalyBaselineTCo2e).toBe(0);
  });

  it('orders quarterly periods correctly (Q1<Q2<Q3, Q4 excluded)', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q4', reportingYear: 2023, status: ActivityRecordStatus.approved, calculation: { tCo2e: 10, factorId: 'f-1' } }),
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q1', status: ActivityRecordStatus.approved, calculation: { tCo2e: 10, factorId: 'f-1' } }),
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q2', status: ActivityRecordStatus.approved, calculation: { tCo2e: 10, factorId: 'f-1' } }),
      // Same reasoning as the monthly case: at 19 an admitted Q4 still leaves
      // the value flagged, so the exclusion went unproven. At 40 it does not.
      makeRecord({ reportingPeriod: 'quarterly', periodValue: 'Q4', status: ActivityRecordStatus.approved, calculation: { tCo2e: 40, factorId: 'f-1' } }), // later → excluded
    ]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), { ...CREATE_DTO, reportingPeriod: 'quarterly', periodValue: 'Q3' });
    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(true);
  });

  it('recomputes the flag with excludeId on update (a record cannot seed its own baseline)', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1', reportingPeriod: 'monthly', periodValue: 'March', createdBy: 'user-entry' }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 10, 2023),
      priorMonth('January', 10),
      priorMonth('February', 10),
    ]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(standardUser(), 'rec-u', { activityValue: 5000 });
    const updateArg = prisma.activityRecord.update.mock.calls[0][0];
    expect(updateArg.data.anomalyFlag).toBe(true);
    expect(prisma.activityRecord.findMany.mock.calls[0][0].where.id).toEqual({ not: 'rec-u' });
  });

  it('create skips the anomaly check for a record with no figure', async () => {
    const { prisma, service, calc } = build(3);
    // The calc engine hands back the factor-less shape for this write.
    calc.compute.mockResolvedValue({
      snapshotSchema: 1,
      category: 'Water',
      geographyCode: 'TR',
      reportingYear: 2024,
      scope: 3,
      inputValue: 250,
      inputUnit: 'cubic_metres',
      reasonCode: 'no_emission_factor',
      reason: 'No emission factor is available for "Water"',
    });
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), {
      ...MONTHLY_DTO,
      category: 'Water',
      activityUnit: 'cubic_metres',
    } as unknown as typeof MONTHLY_DTO);

    expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(false);
    // The baseline query never runs: detection is skipped, not survived.
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
    // NULL, not 0: the pool was never LOOKED AT, and the record may well sit on
    // a full year of neighbours. A `0` here would be a claim about its history
    // — and one every reader outside TypeScript would have had to re-derive
    // `isCalculated()` to disbelieve.
    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyBaselinePriorCount).toBeNull();
    expect(data.anomalyBaselineTCo2e).toBeNull();
  });

  it('update skips the anomaly check when the recomputed snapshot has no figure', async () => {
    const { prisma, service, calc } = build(3);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1', reportingPeriod: 'monthly', periodValue: 'March', createdBy: 'user-entry' }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    // Editing a record into a factor-less category: calculated -> uncalculated.
    calc.compute.mockResolvedValue({
      snapshotSchema: 1,
      category: 'Water',
      geographyCode: 'TR',
      reportingYear: 2024,
      scope: 3,
      inputValue: 250,
      inputUnit: 'cubic_metres',
      reasonCode: 'no_emission_factor',
      reason: 'No emission factor is available for "Water"',
    });
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(standardUser(), 'rec-u', {
      category: 'Water',
      activityUnit: 'cubic_metres',
    } as never);

    const updateArg = prisma.activityRecord.update.mock.calls[0][0];
    expect(updateArg.data.anomalyFlag).toBe(false);
    expect(updateArg.data.calculation).toMatchObject({
      reasonCode: 'no_emission_factor',
    });
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('a category change re-enforces the unit map even when the unit is not resent', async () => {
    const { prisma, service, calc } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-w',
        subsidiaryId: 'sub-1',
        category: 'Water',
        activityUnit: 'cubic_metres',
        createdBy: 'user-entry',
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-w', ...data }),
    );

    await service.update(standardUser(), 'rec-w', { category: 'Electricity' } as never);

    // Without this the stored `cubic_metres` was re-read under Electricity,
    // normalised at the natural-gas calorific value and multiplied by the grid
    // factor — a fabricated figure carrying full factor provenance.
    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Electricity', unit: 'cubic_metres' }),
      { enforceCategoryUnit: true },
    );
  });

  it('rejects a non-canonical periodValue for its granularity (VAR data integrity)', async () => {
    const { service } = build(2);
    await expect(
      service.create(standardUser(), { ...MONTHLY_DTO, periodValue: 'Mar' }),
    ).rejects.toThrow(/not a valid period/i);
  });

  // --- Submit gate re-evaluates the baseline as of submit time (fix: never
  //     trust the write-time flag; the API is the final enforcement layer). ---

  const draftForSubmit = (over = {}) =>
    makeRecord({
      id: 'rec-s',
      status: ActivityRecordStatus.draft,
      reportingPeriod: 'monthly',
      periodValue: 'March',
      // makeRecord's default calculation: the submit gate only evaluates a
      // record that HAS a figure, and K11 refuses one the engine would not
      // give again.
      varianceReason: null,
      ...over,
    });

  it('blocks submit when the value is anomalous vs. the current baseline and no comment', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draftForSubmit());
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('December', 10, 2023), priorMonth('January', 10), priorMonth('February', 10)]);

    // The whole constant (it is what the user reads), and the CLASS — which
    // is what the bulk submit branches on.
    await expect(service.submit(standardUser(), 'rec-s')).rejects.toThrow(
      VARIANCE_REFUSAL,
    );
    await expect(service.submit(standardUser(), 'rec-s')).rejects.toBeInstanceOf(
      VarianceReasonRequiredError,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('allows submit of an anomalous record once a variance comment is present (persists the fresh flag)', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draftForSubmit({ varianceReason: 'Plant expansion' }));
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('December', 10, 2023), priorMonth('January', 10), priorMonth('February', 10)]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-s', ...data }));

    const dto = await service.submit(standardUser(), 'rec-s');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.anomalyFlag).toBe(true);
  });

  // BUG-R2-07: a flag on limited history is the same gate, not a softer one.
  it.each([
    ['one prior', () => [priorMonth('February', 10)]],
    ['two priors', () => [priorMonth('January', 8), priorMonth('February', 12)]],
  ])('blocks submit of a value anomalous against %s when there is no comment', async (_label, priors) => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draftForSubmit());
    prisma.activityRecord.findMany.mockResolvedValue(priors());

    await expect(service.submit(standardUser(), 'rec-s')).rejects.toBeInstanceOf(
      VarianceReasonRequiredError,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('allows that submit once a variance comment is present, and stores the one-period verdict', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draftForSubmit({ varianceReason: 'New line commissioned' }));
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('February', 10)]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-s', ...data }));

    const dto = await service.submit(standardUser(), 'rec-s');

    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    const { data } = prisma.activityRecord.update.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(true);
    expect(data.anomalyBaselinePriorCount).toBe(1);
    expect(data.anomalyBaselineTCo2e).toBe(10);
  });

  it('judges a draft saved as "not checked" against a prior committed since', async () => {
    // The draft was saved when its series was empty, so it stores count 0 and
    // no flag. A period before it has been submitted in the meantime. The gate
    // must read today's pool, not the verdict the draft carries.
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      draftForSubmit({ anomalyFlag: false, anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null }),
    );
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('February', 10)]);

    await expect(service.submit(standardUser(), 'rec-s')).rejects.toBeInstanceOf(
      VarianceReasonRequiredError,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('does not block submit against a single prior of zero', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draftForSubmit());
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('February', 0)]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-s', ...data }));

    const dto = await service.submit(standardUser(), 'rec-s');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.anomalyFlag).toBe(false);
  });

  it('approve does not check the flag: a flagged record with no comment is approved', async () => {
    // The gate is at submit. Approve reads no pool and asks for no reason, so a
    // record flagged on any basis is the reviewer's to judge, not the API's to
    // refuse — which is why the flag must not get past submit unexplained.
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-a',
        status: ActivityRecordStatus.submitted,
        anomalyFlag: true,
        anomalyBaselinePriorCount: 1,
        anomalyBaselineTCo2e: 10,
        varianceReason: null,
      }),
    );
    prisma.activityRecord.findMany.mockResolvedValue([priorMonth('February', 10)]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-a', status: data.status }),
    );

    const dto = await service.approve(superAdmin(), 'rec-a');
    expect(dto.status).toBe(ActivityRecordStatus.approved);
  });

  // The provenance is written at THREE moments, and until these two tests
  // existed only the first was asserted: dropping the write at update or at
  // submit, or hardcoding it, left the whole suite green. Each test arranges a
  // window that differs from what the record already stores, so a stale value
  // is as visible as a missing one.

  it('update persists the window it re-scored against, not the one create wrote', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-u',
        subsidiaryId: 'sub-1',
        reportingPeriod: 'monthly',
        periodValue: 'March',
        createdBy: 'user-entry',
        // What create wrote when this record was first saved and its series
        // was empty. The pool has moved since.
        anomalyBaselinePriorCount: 0,
        anomalyBaselineTCo2e: null,
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('December', 9, 2023),
      priorMonth('January', 10),
      priorMonth('February', 11),
    ]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    const dto = await service.update(standardUser(), 'rec-u', { activityValue: 5000 });

    const { data } = prisma.activityRecord.update.mock.calls[0][0];
    expect(data.anomalyBaselinePriorCount).toBe(3);
    expect(data.anomalyBaselineTCo2e).toBe(10);
    expect(dto.anomalyBaselinePriorCount).toBe(3);
  });

  it('submit persists the window as of submit time', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      draftForSubmit({ anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: 99 }),
    );
    // Two priors now — fewer than the record claims to have been scored on,
    // with a different average. Both halves of the stale claim must be
    // replaced, not just the flag. 15 each, so 19.8 is within range (+32%) and
    // the submit is not refused for a missing comment.
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 15),
      priorMonth('February', 15),
    ]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-s', ...data }),
    );

    await service.submit(standardUser(), 'rec-s');

    const { data } = prisma.activityRecord.update.mock.calls[0][0];
    expect(data.anomalyBaselinePriorCount).toBe(2);
    expect(data.anomalyBaselineTCo2e).toBe(15);
    expect(data.anomalyFlag).toBe(false);
  });

  it('submit clears a stale full-window claim when no earlier period is left', async () => {
    // The priors the record was scored on have since been voided. The stored
    // count and average must both go, not survive beside a fresh flag.
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      draftForSubmit({ anomalyBaselinePriorCount: 3, anomalyBaselineTCo2e: 99 }),
    );
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-s', ...data }),
    );

    await service.submit(standardUser(), 'rec-s');

    const { data } = prisma.activityRecord.update.mock.calls[0][0];
    expect(data.anomalyBaselinePriorCount).toBe(0);
    expect(data.anomalyBaselineTCo2e).toBeNull();
    expect(data.anomalyFlag).toBe(false);
  });

  it('a record with no calculated figure is never anomalous, so submit is not blocked', async () => {
    const { prisma, calc, service } = build(2);
    // An invoice-tracked category with no factor (WP17): the snapshot carries
    // no tCO₂e at all. Substituting 0 — what a plain `?? 0` does — reads as a
    // 100% drop against this baseline and would demand a variance comment for a
    // value that was never computed.
    const uncalculated = {
      snapshotSchema: 1 as const,
      category: 'Water',
      geographyCode: 'TR',
      reportingYear: 2024,
      scope: 3,
      inputValue: 100,
      inputUnit: 'cubic_metres',
      reasonCode: 'no_emission_factor' as const,
      reason: 'No emission factor is available for "Water"',
    };
    // Still uncalculated when K11 recomputes it at submit.
    calc.compute.mockResolvedValue(uncalculated);
    prisma.activityRecord.findUnique.mockResolvedValue(
      draftForSubmit({ category: 'Water', scope: 3, varianceReason: null, calculation: uncalculated }),
    );
    prisma.activityRecord.findMany.mockResolvedValue([
      priorMonth('January', 500),
      priorMonth('February', 500),
    ]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-s', ...data }),
    );

    const dto = await service.submit(standardUser(), 'rec-s');

    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.anomalyFlag).toBe(false);
    // The baseline was never even queried: detection is skipped, not merely
    // survived. Without this leg the test would still pass if the comparison
    // happened and simply came out under the threshold.
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('does not trust a stale stored flag: submit passes when the current baseline is not anomalous', async () => {
    const { prisma, service } = build(2);
    // Stored flag is true, no comment — but there is no baseline now, so submit
    // must NOT be blocked, and the persisted flag is corrected to false.
    prisma.activityRecord.findUnique.mockResolvedValue(draftForSubmit({ anomalyFlag: true }));
    prisma.activityRecord.findMany.mockResolvedValue([]); // no comparable priors
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-s', ...data }));

    const dto = await service.submit(standardUser(), 'rec-s');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.anomalyFlag).toBe(false);
  });
});

describe('ActivityRecordsService — first-period typo ceiling (BUG-R2-07 tier 3)', () => {
  // The first period of a series has no history; its typo ceiling judges it
  // (Decisions 2026-11-12). calc.compute() returns 19.8 tCO₂e whatever the
  // amount, so these cases turn on the AMOUNT, not on the figure.
  const BIG = { activityValue: 4_500_000, activityUnit: 'kWh' }; // ceiling 1,000,000 kWh
  const priorAnnual = (reportingYear: number, tCo2e: number) =>
    makeRecord({
      reportingYear,
      status: ActivityRecordStatus.approved,
      calculation: { tCo2e, factorId: 'f-1' },
    });
  const draft = (over = {}) =>
    makeRecord({ id: 'rec-c', status: ActivityRecordStatus.draft, varianceReason: null, ...over });

  it('stores a first-period record above its ceiling as flagged, count 0, no average', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(standardUser(), { ...CREATE_DTO, ...BIG });

    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(true);
    expect(data.anomalyBaselinePriorCount).toBe(0);
    expect(data.anomalyBaselineTCo2e).toBeNull();
    expect(dto.anomalyFlag).toBe(true);
  });

  it('judges the canonical unit: 1,200 MWh is above, 900 MWh is not', async () => {
    for (const [activityValue, flagged] of [[1_200, true], [900, false]] as const) {
      const { prisma, service } = build(2);
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
      prisma.activityRecord.findMany.mockResolvedValue([]);
      prisma.activityRecord.create.mockImplementation(({ data }: any) =>
        makeRecord({ ...data, id: 'rec-new' }),
      );
      await service.create(standardUser(), { ...CREATE_DTO, activityValue, activityUnit: 'mwh' });
      expect(prisma.activityRecord.create.mock.calls[0][0].data.anomalyFlag).toBe(flagged);
    }
  });

  it('refuses submit with no reason, naming the ceiling basis — nothing is written', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draft(BIG));
    prisma.activityRecord.findMany.mockResolvedValue([]);

    const refusal = await service.submit(standardUser(), 'rec-c').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(VarianceReasonRequiredError);
    expect((refusal as VarianceReasonRequiredError).getResponse()).toMatchObject({
      code: 'variance_reason_required',
      message: CEILING_VARIANCE_REFUSAL,
      params: { basis: 'ceiling' },
    });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('submits it once a reason is present, storing the ceiling flag', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draft({ ...BIG, varianceReason: 'New plant, metered' }));
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-c', ...data }));

    const dto = await service.submit(standardUser(), 'rec-c');

    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    const { data } = prisma.activityRecord.update.mock.calls[0][0];
    expect(data.anomalyFlag).toBe(true);
    expect(data.anomalyBaselinePriorCount).toBe(0);
    expect(data.anomalyBaselineTCo2e).toBeNull();
  });

  it('a history flag\'s refusal names the history basis', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draft());
    prisma.activityRecord.findMany.mockResolvedValue([priorAnnual(2023, 10)]);

    const refusal = await service.submit(standardUser(), 'rec-c').catch((e: unknown) => e);
    expect((refusal as VarianceReasonRequiredError).getResponse()).toMatchObject({
      message: VARIANCE_REFUSAL,
      params: { basis: 'history' },
    });
  });

  it('an update that lowers the amount below the ceiling clears the flag', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      draft({ ...BIG, anomalyFlag: true, anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null }),
    );
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-c', ...data }));

    await service.update(standardUser(), 'rec-c', { activityValue: 450_000 } as never);

    expect(prisma.activityRecord.update.mock.calls[0][0].data.anomalyFlag).toBe(false);
  });

  it('a draft saved before the ceiling meets it at its next save', async () => {
    // Stored first-period and unflagged (as the old rule wrote it), above the
    // ceiling: the next save re-scores it and flags it (spec: "A draft meets
    // the ceiling at its next save").
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      draft({ ...BIG, anomalyFlag: false, anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null }),
    );
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-c', ...data }));

    await service.update(standardUser(), 'rec-c', { varianceReason: null } as never);

    expect(prisma.activityRecord.update.mock.calls[0][0].data).toMatchObject({
      anomalyFlag: true,
      anomalyBaselinePriorCount: 0,
      anomalyBaselineTCo2e: null,
    });
  });

  it('never judges a record with an earlier period by the ceiling', async () => {
    // One prior of 19.8 tCO₂e: the figure is in line with history, however
    // large the amount.
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draft(BIG));
    prisma.activityRecord.findMany.mockResolvedValue([priorAnnual(2023, 19.8)]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-c', ...data }));

    const dto = await service.submit(standardUser(), 'rec-c');

    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.update.mock.calls[0][0].data).toMatchObject({
      anomalyFlag: false,
      anomalyBaselinePriorCount: 1,
    });
  });

  it('applies the ceiling over a zero average too (owner, 2026-11-13, K1)', async () => {
    // One earlier period of 0 tCO₂e: no ratio can be taken, so history cannot
    // judge — and a January of 0 must not let a typo through in February.
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draft(BIG));
    prisma.activityRecord.findMany.mockResolvedValue([priorAnnual(2023, 0)]);

    const refusal = await service.submit(standardUser(), 'rec-c').catch((e: unknown) => e);
    expect((refusal as VarianceReasonRequiredError).getResponse()).toMatchObject({
      code: 'variance_reason_required',
      params: { basis: 'ceiling' },
    });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('stores a zero-average ceiling flag with the count and the zero average history gave', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draft({ ...BIG, varianceReason: 'New plant, metered' }));
    prisma.activityRecord.findMany.mockResolvedValue([priorAnnual(2023, 0)]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-c', ...data }));

    await service.submit(standardUser(), 'rec-c');

    expect(prisma.activityRecord.update.mock.calls[0][0].data).toMatchObject({
      anomalyFlag: true,
      anomalyBaselinePriorCount: 1,
      anomalyBaselineTCo2e: 0,
    });
  });

  it('leaves a zero average below the ceiling unflagged and not checked', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(draft());
    prisma.activityRecord.findMany.mockResolvedValue([priorAnnual(2023, 0)]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-c', ...data }));

    const dto = await service.submit(standardUser(), 'rec-c');

    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.update.mock.calls[0][0].data).toMatchObject({
      anomalyFlag: false,
      anomalyBaselinePriorCount: 1,
      anomalyBaselineTCo2e: 0,
    });
  });

  it('approve does not check a ceiling flag', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-a',
        status: ActivityRecordStatus.submitted,
        ...BIG,
        anomalyFlag: true,
        anomalyBaselinePriorCount: 0,
        anomalyBaselineTCo2e: null,
        varianceReason: null,
      }),
    );
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-a', status: data.status }),
    );

    const dto = await service.approve(superAdmin(), 'rec-a');
    expect(dto.status).toBe(ActivityRecordStatus.approved);
  });
});

describe('ActivityRecordsService — periodValue is canonicalised on write', () => {
  /**
   * Validation was always case-insensitive; storage was verbatim. Everything
   * that then read the column compared RAW strings — the uniqueness index, both
   * period-lock lookups, the seed's de-duplication key — so `"january"` and
   * `"January"` were two rows for one month, and both counted towards the
   * emissions inventory. The fix is not stricter validation; it is storing one
   * spelling.
   */
  const monthly = (periodValue: string) => ({
    ...CREATE_DTO,
    reportingPeriod: 'monthly' as const,
    periodValue,
  });

  const createdWith = async (dto: Parameters<typeof monthly>[0] | object) => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.activityRecord.create.mockImplementation(({ data }: never) =>
      makeRecord({ id: 'rec-1', ...(data as object) }),
    );
    await service.create(standardUser(), dto as never);
    return prisma;
  };

  it('stores the canonical spelling, whatever casing the caller sent', async () => {
    for (const sent of ['january', 'JANUARY', 'JaNuArY']) {
      const prisma = await createdWith(monthly(sent));
      expect(prisma.activityRecord.create.mock.calls[0][0].data.periodValue).toBe(
        'January',
      );
    }
  });

  it('trims, because a stored space is a different index key', async () => {
    // `" January "` passed validation — which trims only to COMPARE — and was
    // then written with its spaces, occupying a slot of its own.
    const prisma = await createdWith(monthly('  January  '));
    expect(prisma.activityRecord.create.mock.calls[0][0].data.periodValue).toBe(
      'January',
    );
  });

  it('canonicalises quarters and the annual token too', async () => {
    const q = await createdWith({ ...CREATE_DTO, reportingPeriod: 'quarterly', periodValue: 'q3' });
    expect(q.activityRecord.create.mock.calls[0][0].data.periodValue).toBe('Q3');
    const a = await createdWith({ ...CREATE_DTO, periodValue: 'annual' });
    expect(a.activityRecord.create.mock.calls[0][0].data.periodValue).toBe('Annual');
  });

  it('looks the period lock up by the canonical spelling', async () => {
    // The sharpest consequence, and not a data-quality one: a lock stored as
    // `"January"` did not block a record sent as `"january"`, because the gate
    // is raw Postgres equality. A period a masterkey believes is closed went
    // on accepting writes.
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1', subsidiaryId: 'sub-1' });

    await expect(service.create(standardUser(), monthly('january'))).rejects.toThrow(
      /period .* is locked/i,
    );
    expect(prisma.periodLock.findFirst.mock.calls[0][0].where).toMatchObject({
      periodValue: 'January',
    });
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('canonicalises on update, and only when the caller sent one', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-1', reportingPeriod: 'monthly', periodValue: 'March' }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findMany.mockResolvedValue([]);
    prisma.activityRecord.update.mockImplementation(({ data }: never) =>
      makeRecord({ id: 'rec-1', ...(data as object) }),
    );

    await service.update(standardUser(), 'rec-1', { periodValue: 'april' } as never);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.periodValue).toBe('April');

    // An edit that does not mention the period must not rewrite it — that would
    // put a change into the append-only audit diff that the user never made.
    prisma.activityRecord.update.mockClear();
    await service.update(standardUser(), 'rec-1', { activityValue: 12 } as never);
    expect(prisma.activityRecord.update.mock.calls[0][0].data.periodValue).toBeUndefined();
  });

  it('still refuses a value that names no period at all', async () => {
    const { service } = build(2);
    // Canonicalising must not become "accept anything and guess". An
    // abbreviation names no period, so it is a 400 exactly as before.
    await expect(service.create(standardUser(), monthly('Mar'))).rejects.toThrow(
      /not a valid period/i,
    );
    await expect(service.create(standardUser(), monthly('2024-03'))).rejects.toThrow(
      /not a valid period/i,
    );
  });

  it('quotes the value it refuses, naming what it cannot show', async () => {
    // A bulk import repeats this sentence in its report, and a U+202E in the
    // value reversed the rest of it on screen. Built from a code point, never
    // typed.
    const { service } = build(2);
    const rlo = String.fromCharCode(0x202e);

    await expect(
      service.create(standardUser(), monthly(`Ma${rlo}r${'x'.repeat(60)}`)),
    ).rejects.toThrow(
      `"Ma<U+202E>r${'x'.repeat(36)}…" is not a valid period for a monthly record.`,
    );
    // Coded with the canonical granularity only; the value never rides along.
    const response = await service
      .create(standardUser(), monthly(`Ma${rlo}r`))
      .catch((e: BadRequestException) => e.getResponse());
    expect(response).toMatchObject({ code: 'record_period_invalid', params: { granularity: 'monthly' } });
    expect(JSON.stringify((response as { params: unknown }).params)).not.toContain('Ma');
  });

  it('never echoes a non-canonical granularity in the params — a bulk row is caller text until checked', async () => {
    // Called past the DTO, as an internal caller could: the guard, not the
    // pipe, keeps the file's text out of `params` (security-rls P3-2).
    const { service } = build(2);
    const response = await service
      .create(standardUser(), { ...monthly('January'), reportingPeriod: 'weekly<b>' as never })
      .catch((e: BadRequestException) => e.getResponse());
    expect(response).toMatchObject({ code: 'record_period_invalid' });
    expect((response as { params?: unknown }).params).toBeUndefined();
  });
});

describe('ActivityRecordsService — period-lock gate (FR §4.2)', () => {
  const LOCK_ROW = { id: 'lock-1', subsidiaryId: 'sub-1' };

  it('blocks creating a record in a locked period (409, nothing persisted)', async () => {
    const { prisma, service } = build(2);
    prisma.periodLock.findFirst.mockResolvedValue(LOCK_ROW);

    await expect(service.create(standardUser(), CREATE_DTO)).rejects.toThrow(
      /period .* is locked/i,
    );
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('blocks updating a record whose period is locked', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-l', createdBy: 'user-entry' }),
    );
    prisma.periodLock.findFirst.mockResolvedValue(LOCK_ROW);

    await expect(
      service.update(standardUser(), 'rec-l', { activityValue: 1 }),
    ).rejects.toThrow(/period .* is locked/i);
    await expect(
      service.update(standardUser(), 'rec-l', { activityValue: 1 }),
    ).rejects.toBeInstanceOf(PeriodLockedError);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('blocks re-targeting a record INTO a locked period', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-m', reportingPeriod: 'monthly', periodValue: 'March', createdBy: 'user-entry' }),
    );
    // Current period (March) open, target period (April) locked.
    prisma.periodLock.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(LOCK_ROW);

    await expect(
      service.update(standardUser(), 'rec-m', { periodValue: 'April' }),
    ).rejects.toThrow(/period .* is locked/i);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('blocks deleting a record in a locked period', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-d', createdBy: 'user-entry' }),
    );
    prisma.periodLock.findFirst.mockResolvedValue(LOCK_ROW);

    await expect(service.remove(standardUser(), 'rec-d')).rejects.toThrow(
      /period .* is locked/i,
    );
    expect(prisma.tx.activityRecord.delete).not.toHaveBeenCalled();
  });

  it('blocks submitting a draft in a locked period', async () => {
    const { prisma, service } = build(2);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-s', status: ActivityRecordStatus.draft }),
    );
    prisma.periodLock.findFirst.mockResolvedValue(LOCK_ROW);

    await expect(service.submit(standardUser(), 'rec-s')).rejects.toThrow(
      /period .* is locked/i,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('queries the lock with the record period tuple', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), CREATE_DTO);
    expect(prisma.periodLock.findFirst).toHaveBeenCalledWith({
      where: {
        subsidiaryId: 'sub-1',
        reportingYear: 2024,
        reportingPeriod: 'annual',
        periodValue: 'Annual',
      },
    });
  });
});

/**
 * Who entered a record, and who decided it — resolved at read time.
 *
 * `/review` and `/emissions` showed NOTHING about either: a reviewer could not
 * see who submitted the record they were deciding, and "who approved this" was
 * recoverable only by cross-referencing `/audit`. `created_by` and `reviewed_by`
 * are plain UUIDs with no FK to `profiles` (the row must survive the actor's
 * deletion), so there is no `include` — the join happens here.
 */

/**
 * Who entered a record, and who decided it — resolved at read time.
 *
 * `/review` and `/emissions` showed NOTHING about either: a reviewer could not
 * see who submitted the record they were deciding, and "who approved this" was
 * recoverable only by cross-referencing `/audit`. `created_by` and `reviewed_by`
 * are plain UUIDs with no FK to `profiles` (the row must survive the actor's
 * deletion), so there is no `include` — the join happens here.
 */
describe('ActivityRecordsService — actor names are resolved', () => {
  const PROFILES = [
    { id: 'user-entry', email: 'entry@tonyai.local', fullName: 'Entry User' },
    { id: 'user-admin', email: 'admin@tonyai.local', fullName: 'Admin User' },
  ];

  it('list resolves BOTH actor columns in a single query for the whole page', async () => {
    const { prisma, service } = build();
    prisma.profile.findMany.mockResolvedValue(PROFILES);
    prisma.activityRecord.findMany.mockResolvedValue([
      { ...makeRecord({ id: 'r1', reviewedBy: 'user-admin' }), _count: { evidenceLinks: 1 } },
      { ...makeRecord({ id: 'r2', reviewedBy: 'user-admin' }), _count: { evidenceLinks: 0 } },
    ]);

    // An auditor, so neither actor is the caller and both need looking up.
    const rows = (await service.listPage(auditor(), {})).items;

    expect(rows.map((r) => r.createdByName)).toEqual(['Entry User', 'Entry User']);
    expect(rows.map((r) => r.reviewedByName)).toEqual(['Admin User', 'Admin User']);
    // ONE query for the page, not one per row and not one per column. The queue
    // pulls every pending record, so per-row resolution is the shape that
    // quietly turns a review screen into an N+1.
    expect(prisma.profile.findMany).toHaveBeenCalledTimes(1);
    // Sorted, and only the id set is pinned: asserting the literal array would
    // fix the ORDER of a `Set` iteration and forbid ever adding a field to this
    // `where` — a test failing because someone HARDENED the query is a test
    // that will be deleted rather than read.
    const where = prisma.profile.findMany.mock.calls[0][0].where;
    expect([...where.id.in].sort()).toEqual(['user-admin', 'user-entry']);
  });

  it('get resolves the record it returns', async () => {
    const { prisma, service } = build();
    prisma.profile.findMany.mockResolvedValue(PROFILES);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-in', subsidiaryId: 'sub-1', reviewedBy: 'user-admin' }),
    );

    const dto = await service.get(auditor(), 'rec-in');
    expect(dto.createdByName).toBe('Entry User');
    expect(dto.reviewedByName).toBe('Admin User');
  });

  it('names the caller on a create WITHOUT a profile query', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    const dto = await service.create(standardUser(), CREATE_DTO);

    // `created_by` on a create is always the caller, and the auth guard has
    // already loaded that whole profile to build `RequestUser`. This is the
    // measurement behind making the field required: the cost that argued for
    // resolving on reads only is, on the commonest write, zero.
    expect(dto.createdByName).toBe('Entry User');
    expect(dto.reviewedByName).toBeNull();
    expect(prisma.profile.findMany).not.toHaveBeenCalled();
  });

  it('carries the names on update and on a review transition', async () => {
    const { prisma, service } = build();
    prisma.profile.findMany.mockResolvedValue(PROFILES);
    // `update` re-runs the calc, which needs the subsidiary's geography.
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.findUnique.mockResolvedValue({
      ...makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1' }),
      _count: { evidenceLinks: 0 },
    });
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1', ...data }),
      _count: { evidenceLinks: 0 },
    }));

    // Both screens splice a write response straight into state built from a
    // read. When these responses omitted the names, the actor column emptied
    // the instant a reviewer acted — and "Reviewed by —" appeared on a record
    // whose reviewer had just been set by that very click.
    const updated = await service.update(standardUser(), 'rec-u', { activityValue: 5000 });
    expect(updated.createdByName).toBe('Entry User');

    prisma.activityRecord.findUnique.mockResolvedValue({
      ...makeRecord({ id: 'rec-u', subsidiaryId: 'sub-1', status: ActivityRecordStatus.submitted }),
      _count: { evidenceLinks: 1 },
    });
    const reviewed = await service.approve(superAdmin(), 'rec-u');
    expect(reviewed.createdByName).toBe('Entry User');
    expect(reviewed.reviewedByName).toBe('Super Admin User');
    expect(reviewed.reviewedBy).toBe('user-super-admin');
  });

  it('resolves a withdrawal by SOMEONE ELSE, which the acting-user shortcut cannot', async () => {
    const { prisma, service } = build();
    // The mock RESPECTS its filter, and that is the whole point of this test.
    // `mockResolvedValue(PROFILES)` answers every query with every profile, so
    // a name resolves whether or not its id was ever asked for — under that
    // mock, deleting `voidedBy` from `actorsFor`'s gather passes. Measured:
    // that mutation left all 116 tests green until this filter existed.
    prisma.profile.findMany.mockImplementation(({ where }: any) =>
      PROFILES.filter((profile) => where.id.in.includes(profile.id)),
    );
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ subsidiaryId: 'sub-1', voidedBy: 'user-admin' }),
    );

    // Reading SOMEONE ELSE's withdrawal is the only path that needs the query:
    // on a withdrawal the actor is the requesting user, who is seeded into the
    // actor map from the request itself, so the write response resolves the
    // name whether or not the column is gathered at all.
    const dto = await service.get(auditor(), 'rec-1');
    expect(dto.voidedByName).toBe('Admin User');
  });

  it('reads null — not the raw id — when the actor profile is gone', async () => {
    const { prisma, service } = build();
    prisma.profile.findMany.mockResolvedValue([]);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ subsidiaryId: 'sub-1', reviewedBy: 'user-admin' }),
    );

    const dto = await service.get(auditor(), 'rec-1');
    // Erasure has to remove the NAME and keep the row. Leaking the uuid back
    // as a display value would undo exactly what read-time resolution buys.
    expect(dto.createdByName).toBeNull();
    expect(dto.reviewedByName).toBeNull();
    expect(dto.voidedByName).toBeNull();
    expect(dto.createdBy).toBe('user-entry');
  });

  it('distinguishes "nobody has reviewed this" from "the reviewer is gone"', async () => {
    const { prisma, service } = build();
    prisma.profile.findMany.mockResolvedValue(PROFILES);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ subsidiaryId: 'sub-1', reviewedBy: null }),
    );

    const dto = await service.get(auditor(), 'rec-1');
    // Both read `reviewedByName: null`. `reviewedBy` is what tells them apart,
    // which is why it stays on the DTO next to the name — rendering an
    // unreviewed record as "deleted user" would claim someone decided it.
    expect(dto.reviewedByName).toBeNull();
    expect(dto.reviewedBy).toBeNull();
  });

  it('lets NOTHING but a persisted column reach the append-only audit log', async () => {
    const { prisma, service } = build(2);
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ ...data, id: 'rec-new' }),
    );

    await service.create(standardUser(), CREATE_DTO);

    // A WHOLE-KEY-SET assertion, not a list of forbidden names. The first cut
    // checked three known keys were absent, and a review proved that a FOURTH
    // resolved field — an actor email, say — reached the snapshot with both the
    // compiler and the full suite green. This fails on any new key, which
    // forces the decision to be made rather than defaulted.
    //
    // The compiler helps too, but only halfway, and the half matters: with the
    // name fields REQUIRED, `Omit` rejects one written as a direct property
    // (measured: TS2561) where an optional one passed silently. It does NOT
    // reject the same field arriving through a SPREAD — excess-property
    // checking does not apply through one, measured at 0 errors for both
    // `...{ createdByName }` and `...{ createdByEmail }`. This assertion is
    // what covers that form, and it is the form a real leak would take.
    const { diff } = audit.record.mock.calls.at(-1)![1] as { diff: Record<string, unknown> };
    // Kept from the first cut: without it a snapshot that came back undefined
    // fails as `TypeError: Cannot convert undefined or null to object` rather
    // than as a legible assertion about what was audited.
    expect(diff.after).toBeDefined();
    expect(Object.keys(diff.after as object).sort()).toEqual(PERSISTED_KEYS);
  });
});

/**
 * When a record was submitted for review.
 *
 * The queue counted a reviewer's waiting time from `created_at`, i.e. from when
 * the DRAFT was made — a record started in January and submitted in June read
 * as five months overdue. The column was honestly headed "Age" for exactly that
 * reason; this is what lets it become "Waiting" and mean it.
 */
describe('ActivityRecordsService — submittedAt', () => {
  const submittable = (over: Partial<ActivityRecord> = {}) => ({
    ...makeRecord({
      id: 'rec-s',
      subsidiaryId: 'sub-1',
      status: ActivityRecordStatus.draft,
      ...over,
    }),
    _count: { evidenceLinks: 1 },
  });

  const arrange = () => {
    const { prisma, service } = build();
    prisma.subsidiary.findUnique.mockResolvedValue(
      makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-s', subsidiaryId: 'sub-1', ...data }),
      _count: { evidenceLinks: 1 },
    }));
    return { prisma, service };
  };

  it('stamps the submission time on submit', async () => {
    const { prisma, service } = arrange();
    prisma.activityRecord.findUnique.mockResolvedValue(submittable());

    const dto = await service.submit(standardUser(), 'rec-s');

    const written = prisma.activityRecord.update.mock.calls.at(-1)![0].data;
    expect(written.submittedAt).toBeInstanceOf(Date);
    expect(dto.submittedAt).not.toBeNull();
  });

  it('re-stamps on a RESUBMIT rather than keeping the first attempt', async () => {
    const { prisma, service } = arrange();
    // A rejected record carries the previous attempt's stamp. Resubmitting
    // starts the reviewer's clock again — which is the question the queue
    // asks — and matches how `reviewedAt` is already overwritten on every
    // review outcome. The per-attempt history lives in `audit_log`.
    const first = new Date('2026-02-01T09:00:00.000Z');
    prisma.activityRecord.findUnique.mockResolvedValue(
      submittable({
        status: ActivityRecordStatus.rejected,
        submittedAt: first,
        createdBy: 'user-entry',
      }),
    );

    await service.submit(standardUser(), 'rec-s');

    const written = prisma.activityRecord.update.mock.calls.at(-1)![0].data;
    expect(written.submittedAt).toBeInstanceOf(Date);
    expect((written.submittedAt as Date).getTime()).toBeGreaterThan(first.getTime());
  });

  // EVERY non-submit transition, not just approve. Testing one of them let two
  // mutants live: stamping on `under_review` as well passed the whole suite,
  // and that is the WP22-D regression in a new place — WP7 keeps a record in
  // the queue through `under_review`, so a reviewer would watch the Waiting
  // cell drop from 9d to 0d on the click that made them the reviewer.
  const NON_SUBMIT: ReadonlyArray<
    [string, (s: ReturnType<typeof arrange>['service']) => Promise<unknown>, ActivityRecordStatus]
  > = [
    ['startReview', (svc) => svc.startReview(superAdmin(), 'rec-s'), ActivityRecordStatus.submitted],
    ['approve', (svc) => svc.approve(superAdmin(), 'rec-s'), ActivityRecordStatus.submitted],
    ['reject', (svc) => svc.reject(superAdmin(), 'rec-s', 'Meter reading does not match.'), ActivityRecordStatus.submitted],
    ['void', (svc) => svc.void(masterkey(), 'rec-s', 'Duplicate of the site invoice for the month.'), ActivityRecordStatus.approved],
  ];

  it.each(NON_SUBMIT)('leaves it alone on %s', async (_name, act, from) => {
    const { prisma, service } = arrange();
    const stamped = new Date('2026-02-01T09:00:00.000Z');
    prisma.activityRecord.findUnique.mockResolvedValue(
      submittable({ status: from, submittedAt: stamped }),
    );

    await act(service);

    // The submission instant is the START of the reviewer's window. Every one
    // of these either continues that window (startReview) or ends it
    // (approve/reject/void); overwriting the start would erase how long it
    // took, and on `startReview` it would do so while the row is still on
    // screen showing the number.
    const written = prisma.activityRecord.update.mock.calls.at(-1)![0].data;
    expect(written).not.toHaveProperty('submittedAt');
    // WP5: only a submit raises the submission count.
    expect(written).not.toHaveProperty('submissionCount');
  });

  // WP5: the submission count is raised in the submit's own update, and only there.
  it('raises the submission count on a first submit and names submission 1 in the audit row', async () => {
    const { prisma, service } = arrange();
    prisma.activityRecord.findUnique.mockResolvedValue(submittable({ submissionCount: 0 }));
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-s', subsidiaryId: 'sub-1', ...data, submissionCount: 1 }),
      _count: { evidenceLinks: 1 },
    }));

    const dto = await service.submit(standardUser(), 'rec-s');

    const call = prisma.activityRecord.update.mock.calls.at(-1)![0];
    expect(call.data.submissionCount).toBe(1);
    // The increment rides the compare-and-set: a lost race raises nothing.
    expect(call.where).toEqual({ id: 'rec-s', status: ActivityRecordStatus.draft });
    expect(dto.submissionCount).toBe(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'submit',
        diff: expect.objectContaining({ submission: 1 }),
      }),
      prisma.tx,
    );
  });

  it('names submission 2 on a resubmit after a return', async () => {
    const { prisma, service } = arrange();
    prisma.activityRecord.findUnique.mockResolvedValue(
      submittable({ status: ActivityRecordStatus.rejected, submissionCount: 1, createdBy: 'user-entry' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-s', subsidiaryId: 'sub-1', ...data, submissionCount: 2 }),
      _count: { evidenceLinks: 1 },
    }));

    const dto = await service.submit(standardUser(), 'rec-s');

    expect(prisma.activityRecord.update.mock.calls.at(-1)![0].data.submissionCount).toBe(2);
    expect(dto.submissionCount).toBe(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ diff: expect.objectContaining({ submission: 2 }) }),
      prisma.tx,
    );
  });

  it('names the next submission after the record\'s own submit rows when the column says less (the deploy window)', async () => {
    const { prisma, service } = arrange();
    // Submitted once by an image from before the column: a `submit` row, a count of 0.
    prisma.activityRecord.findUnique.mockResolvedValue(submittable({ submissionCount: 0 }));
    prisma.auditLog.count.mockResolvedValue(1);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-s', subsidiaryId: 'sub-1', ...data }),
      _count: { evidenceLinks: 1 },
    }));

    const dto = await service.submit(standardUser(), 'rec-s');

    expect(prisma.auditLog.count).toHaveBeenCalledWith({ where: submitRowsOf('rec-s', 'org-1') });
    // Both shapes the migration counts (a pre-taxonomy `update` moving to
    // `submitted` too), any spelling of the id, within the organisation.
    expect(submitRowsOf('rec-s', 'org-1')).toEqual({
      entity: 'activity_record',
      entityId: { equals: 'rec-s', mode: 'insensitive' },
      organisationId: 'org-1',
      OR: [
        { action: 'submit' },
        { action: 'update', diff: { path: ['transition', 'to'], equals: 'submitted' } },
      ],
    });
    expect(prisma.activityRecord.update.mock.calls.at(-1)![0].data.submissionCount).toBe(2);
    expect(dto.submissionCount).toBe(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ diff: expect.objectContaining({ submission: 2 }) }),
      prisma.tx,
    );
  });

  it('keeps the column when it says more than the submit rows (a backfilled floor)', async () => {
    const { prisma, service } = arrange();
    prisma.activityRecord.findUnique.mockResolvedValue(
      submittable({ status: ActivityRecordStatus.rejected, submissionCount: 3, createdBy: 'user-entry' }),
    );
    prisma.auditLog.count.mockResolvedValue(1);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-s', subsidiaryId: 'sub-1', ...data }),
      _count: { evidenceLinks: 1 },
    }));
    await service.submit(standardUser(), 'rec-s');
    expect(prisma.activityRecord.update.mock.calls.at(-1)![0].data.submissionCount).toBe(4);
  });

  it("writes the author's variance reason into the submit row, as the record holds it", async () => {
    const { prisma, service } = arrange();
    prisma.activityRecord.findUnique.mockResolvedValue(
      submittable({ varianceReason: 'New chiller since March' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-s', subsidiaryId: 'sub-1', varianceReason: 'New chiller since March', ...data }),
      _count: { evidenceLinks: 1 },
    }));
    await service.submit(standardUser(), 'rec-s');
    const diff = audit.record.mock.calls.at(-1)![1].diff;
    expect(diff).toMatchObject({ submission: 1, varianceReason: 'New chiller since March' });
    // The column is not rewritten by the submit.
    expect(prisma.activityRecord.update.mock.calls.at(-1)![0].data).not.toHaveProperty('varianceReason');
  });

  it('writes no reason into a submit row when the record has none', async () => {
    const { prisma, service } = arrange();
    prisma.activityRecord.findUnique.mockResolvedValue(submittable({ varianceReason: null }));
    await service.submit(standardUser(), 'rec-s');
    expect(audit.record.mock.calls.at(-1)![1].diff).not.toHaveProperty('varianceReason');
  });

  it('leaves the count alone on a recall, and the recall names no submission', async () => {
    const { prisma, service } = arrange();
    prisma.activityRecord.findUnique.mockResolvedValue(
      submittable({ status: ActivityRecordStatus.submitted, submissionCount: 1, submittedAt: new Date('2026-02-01T09:00:00.000Z') }),
    );

    await service.recall(standardUser(), 'rec-s');

    const written = prisma.activityRecord.update.mock.calls.at(-1)![0].data;
    expect(written).not.toHaveProperty('submissionCount');
    const diff = audit.record.mock.calls.at(-1)![1].diff;
    expect(diff).not.toHaveProperty('submission');
  });

  it('raises nothing on a refused submit (no evidence attached)', async () => {
    const { prisma, service } = arrange();
    prisma.activityRecord.findUnique.mockResolvedValue(submittable());
    prisma.activityRecordEvidence.count.mockResolvedValue(0); // the gate refuses before any write

    await expect(service.submit(standardUser(), 'rec-s')).rejects.toBeInstanceOf(EvidenceRequiredError);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is null on a record that has never been submitted', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ subsidiaryId: 'sub-1', submittedAt: null }),
    );

    // Every seeded record is in this state: the seed writes straight to
    // `approved` and never calls the submit path, so the backfill found
    // nothing for any of them. The screen has to render that as unknown.
    expect((await service.get(standardUser(), 'rec-1')).submittedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * `previewCreate` is everything `create` DECIDES, with nothing it WRITES.
 *
 * It exists so the bulk importer (WP8) can offer a dry-run that provably
 * persists nothing. The mechanism matters: `create` opens no transaction,
 * so there is no rollback to hide behind — the claim "the dry-run wrote
 * nothing" is only as good as an assertion against the write spies, which is
 * what this block is. If a future change moves any write into the prepare half,
 * these fail, and they fail before a user has imported a thousand rows into a
 * dry run.
 *
 * The gates are asserted here too, not only on `create`. A read-only seam that
 * skipped the role, tenant or period-lock check would be a way to ask the
 * server questions about a tenant you cannot reach.
 */
describe('ActivityRecordsService — previewCreate is the read-only half of create', () => {
  let prisma: PrismaMock;
  let service: ActivityRecordsService;

  beforeEach(() => {
    audit.record.mockClear();
    ({ prisma, service } = build());
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
  });

  /** Every spy on the mock that would leave a trace behind. */
  function expectNothingWritten() {
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.tx.activityRecord.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  }

  it('returns the decisions create would make, and writes nothing', async () => {
    const prepared = await service.previewCreate(standardUser(), CREATE_DTO);

    expect(prepared.periodValue).toBe('Annual');
    expect(prepared.scope).toBe(2);
    expect(isCalculated(prepared.calculation)).toBe(true);
    expect(prepared.verdict).toEqual({
      anomalous: false,
      priorCount: 0,
      baseline: null,
    });
    expectNothingWritten();
  });

  it('canonicalises the period spelling the same way create does', async () => {
    // The stored spelling IS the identity of the period, so a dry-run that
    // reported on " annual " would be answering about a different slot than
    // the apply would write to.
    const prepared = await service.previewCreate(standardUser(), {
      ...CREATE_DTO,
      periodValue: '  aNNual ',
    });
    expect(prepared.periodValue).toBe('Annual');
    expectNothingWritten();
  });

  it('refuses a period value that names no period of that granularity', async () => {
    await expect(
      service.previewCreate(standardUser(), {
        ...CREATE_DTO,
        periodValue: 'Michaelmas',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expectNothingWritten();
  });

  it('enforces the role gate BEFORE it queries anything', async () => {
    // an auditor does not author records, and asking the
    // server to price one is authoring it in every sense but the write.
    // The query assertion is the half that matters: asserting only that a
    // ForbiddenException eventually emerges leaves the gate free to move
    // below the lock lookup, which a mutation proved survives the suite.
    await expect(
      service.previewCreate(auditor(), CREATE_DTO),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.periodLock.findFirst).not.toHaveBeenCalled();
    expect(prisma.subsidiary.findUnique).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('refuses an inaccessible subsidiary as a 404, with a lock in place', async () => {
    // The lock is mocked PRESENT deliberately. With the default empty mock
    // this case passed while the period-lock lookup still ran against another
    // tenant's subsidiary — so the 409/404 split answered "does that
    // subsidiary exist and is that period closed" for a tenant the caller
    // cannot see. Three review seats found it independently.
    prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });

    await expect(
      service.previewCreate(standardUser(), {
        ...CREATE_DTO,
        subsidiaryId: 'sub-99',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.periodLock.findFirst).not.toHaveBeenCalled();
    expect(prisma.subsidiary.findUnique).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('refuses a malformed subsidiary id before Prisma can see it', async () => {
    // `subsidiaryId` is `@IsString`, not `@IsUUID` (the seed's ids are not
    // RFC-4122), but the column is `uuid`: a malformed value reaching a query
    // throws P2023, which the exception filter turns into a 500. In a bulk
    // import that is one 500 and one Sentry event per bad cell.
    await expect(
      service.previewCreate(standardUser(), {
        ...CREATE_DTO,
        subsidiaryId: 'not-a-uuid',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.periodLock.findFirst).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('returns the identities it validated, not just the derived values', async () => {
    // A bulk importer assembling its write from a row template cannot safely
    // re-read the dto the way `create` does. If the preview hands back only
    // the derived half, an unvalidated subsidiaryId can carry a snapshot that
    // WAS validated, and nothing downstream re-checks it.
    const prepared = await service.previewCreate(standardUser(), CREATE_DTO);
    expect(prepared.subsidiaryId).toBe('sub-1');
    expect(prepared.locationId).toBeNull();
  });

  it('still enforces the period-lock gate', async () => {
    prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
    await expect(
      service.previewCreate(standardUser(), CREATE_DTO),
    ).rejects.toBeInstanceOf(ConflictException);
    expectNothingWritten();
  });

  it('evaluates the anomaly baseline against committed priors', async () => {
    // The verdict is the one thing a dry-run can surface that a plain
    // validation pass cannot: an anomalous row with no variance reason imports
    // fine and can then never be submitted.
    // Monthly, and the third prior comes from the previous year, for the same
    // reason the anomaly block above says: only two months precede March in
    // 2024, and the baseline query orders by the ordinal key, not the year.
    const prior = (periodValue: string, reportingYear?: number) =>
      makeRecord({
        reportingPeriod: 'monthly',
        periodValue,
        ...(reportingYear !== undefined ? { reportingYear } : {}),
        status: ActivityRecordStatus.approved,
        calculation: { tCo2e: 5, factorId: 'f-1' },
      });
    prisma.activityRecord.findMany.mockResolvedValue([
      prior('December', 2023),
      prior('January'),
      prior('February'),
    ]);

    // Baseline avg = 5; the calc stub returns 19.8 → +296%.
    const prepared = await service.previewCreate(standardUser(), {
      ...CREATE_DTO,
      reportingPeriod: 'monthly' as const,
      periodValue: 'March',
    });

    expect(prepared.verdict.anomalous).toBe(true);
    expect(prepared.verdict.priorCount).toBe(3);
    expectNothingWritten();
  });

  it('create runs the read half exactly once, and audits exactly once', async () => {
    // The complement of every assertion above: extracting the read half must
    // not have left `create` writing nothing, auditing twice — or previewing
    // twice. Nothing pinned the read half's call count before, so duplicating
    // the call inside `create` passed the whole suite; at one call per row
    // that is two extra queries per imported record, silently.
    const { prisma, calc, service } = build();
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.create.mockResolvedValue(makeRecord());

    await service.create(standardUser(), CREATE_DTO);

    // Twice, deliberately: the read half's early answer, and the lifecycle
    // protocol's check once the period is held — a lock committed between
    // the two is only visible to the second. One extra indexed lookup per
    // imported row, plus the period's advisory lock.
    expect(prisma.periodLock.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    // Twice: the closed-node gate's type and control (inc26-group-tree, D6),
    // and the calculation's geography.
    expect(prisma.subsidiary.findUnique).toHaveBeenCalledTimes(2);
    expect(calc.compute).toHaveBeenCalledTimes(1);
    expect(prisma.activityRecord.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.activityRecord.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('writes the VALIDATED identities and the variance reason it was given', async () => {
    // `varianceReason` had no write-path assertion at all on create: replacing
    // it with a hardcoded null left 735 tests green. WP8 imports variance
    // reasons precisely so anomalous rows can clear the submit gate, so
    // dropping one on the way in would be silent and consequential.
    const { prisma, service } = build();
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.create.mockResolvedValue(makeRecord());

    await service.create(standardUser(), {
      ...CREATE_DTO,
      varianceReason: 'Meter replaced mid-period',
    });

    const { data } = prisma.activityRecord.create.mock.calls[0][0];
    expect(data.subsidiaryId).toBe('sub-1');
    expect(data.locationId).toBeNull();
    expect(data.varianceReason).toBe('Meter replaced mid-period');
  });
});

describe('ActivityRecordsService — the stored unit is the vocabulary spelling', () => {
  // Measured live before this rule (2026-09-17): a bulk row spelt `kw h`
  // priced correctly (the snapshot said `normalizedUnit: kWh`) and was stored
  // as `activity_unit = 'kw h'` — the table then held `kWh`, `litres` and
  // `kw h` as three units. Every consumer that keys on the column
  // (`unitSymbol`, `appliesUnitConversion`, the exports' unit cell) saw the
  // raw text. The service now stores `ACTIVITY_UNITS`' value and hands the
  // engine the spelling that was entered, so `inputUnit` keeps it.

  it('create stores the canonical spelling and prices the entered one', async () => {
    const { prisma, calc, service } = build();
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-unit', ...data }),
    );

    await service.create(standardUser(), { ...CREATE_DTO, activityUnit: 'kw h' } as never);

    expect(prisma.activityRecord.create.mock.calls[0][0].data.activityUnit).toBe('kWh');
    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ unit: 'kw h' }),
      { enforceCategoryUnit: true },
    );
  });

  it('create stores every alias of every vocabulary value as that value', async () => {
    for (const [entered, stored] of [
      ['KWH', 'kWh'],
      ['MWH', 'MWh'],
      ['m3', 'cubic_metres'],
      ['liters', 'litres'],
    ]) {
      const { prisma, service } = build();
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
      prisma.activityRecord.create.mockImplementation(({ data }: any) =>
        makeRecord({ id: 'rec-unit', ...data }),
      );

      await service.create(standardUser(), { ...CREATE_DTO, activityUnit: entered } as never);

      expect(prisma.activityRecord.create.mock.calls[0][0].data.activityUnit).toBe(stored);
    }
  });

  it('update stores the canonical spelling of a unit the edit changed', async () => {
    const { prisma, calc, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-u',
        subsidiaryId: 'sub-1',
        createdBy: 'user-entry',
        status: ActivityRecordStatus.draft,
        activityUnit: 'kWh',
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(standardUser(), 'rec-u', { activityUnit: 'MWH' } as never);

    expect(prisma.activityRecord.update.mock.calls[0][0].data.activityUnit).toBe('MWh');
    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ unit: 'MWH' }),
      { enforceCategoryUnit: true },
    );
  });

  it('update leaves the stored spelling alone when the edit never touched the unit', async () => {
    // The same principle as `periodValue`: an unrelated edit never rewrites a
    // field nobody touched, so nothing the user did not do reaches the audit
    // diff. Rows stored before the rule are the migration's job. The row here
    // stands for one written outside the API — after the migration none is
    // reachable through it.
    const { prisma, calc, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-u',
        subsidiaryId: 'sub-1',
        createdBy: 'user-entry',
        status: ActivityRecordStatus.draft,
        activityUnit: 'kw h',
      }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(standardUser(), 'rec-u', { varianceReason: 'a note' } as never);

    expect(prisma.activityRecord.update.mock.calls[0][0].data.activityUnit).toBe('kw h');
    // The engine is handed the stored spelling and told the unit was not
    // chosen now, so the category/unit map is not re-policed on a mere edit.
    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ unit: 'kw h' }),
      { enforceCategoryUnit: false },
    );
  });
});

describe('ActivityRecordsService — import provenance', () => {
  it('stores the batch a record came from when the importer passes one, and null otherwise', async () => {
    const { prisma, service } = build();
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.create.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-p', ...data }),
    );

    const imported = await service.create(standardUser(), CREATE_DTO as never, {
      importBatchId: 'batch-1',
    });
    expect(prisma.activityRecord.create.mock.calls[0][0].data.importBatchId).toBe('batch-1');
    expect(imported.importBatchId).toBe('batch-1');

    await service.create(standardUser(), { ...CREATE_DTO, periodValue: 'Annual' } as never);
    expect(prisma.activityRecord.create.mock.calls[1][0].data.importBatchId).toBeNull();
  });

  it('never writes the batch id on an update, whatever the body says', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-u', createdBy: 'user-entry', status: ActivityRecordStatus.draft }),
    );
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-u', ...data }),
    );

    await service.update(standardUser(), 'rec-u', { varianceReason: 'x', importBatchId: 'forged' } as never);

    expect(prisma.activityRecord.update.mock.calls[0][0].data).not.toHaveProperty('importBatchId');
  });
});

describe('evidenceReadyWhere — the submit gate as a query', () => {
  // Evaluates the Prisma filter the way Postgres would, for every category and
  // both evidence states, and demands the same answer as the gate. A category
  // added to the evidence list, or a changed rule, fails here instead of
  // silently mislabelling the import batch's "Send N drafts".
  function matches(where: ReturnType<typeof evidenceReadyWhere>, row: { category: string; evidenceCount: number }) {
    return where.OR.some((clause) =>
      clause.category
        ? !clause.category.notIn.includes(row.category)
        : row.evidenceCount > 0,
    );
  }

  it.each(CATEGORIES.flatMap((category) => [0, 1].map((evidenceCount) => ({ category, evidenceCount }))))(
    '$category with $evidenceCount file(s) agrees with needsEvidenceBeforeSubmit',
    (row) => {
      expect(matches(evidenceReadyWhere(), row)).toBe(!needsEvidenceBeforeSubmit(row));
    },
  );
});

describe('ActivityRecordsService — the lifecycle protocol (LP1-01)', () => {
  // The DB-level proof — interleavings and rollbacks on real PostgreSQL — is
  // in `test/int/lifecycle-*.int.spec.ts`. These pin the decisions a mock can
  // see: the gates run against the LOCKED re-read, and which answer a refusal
  // gets.
  const order = (fn: { mock: { invocationCallOrder: number[] } }, call = 0) =>
    fn.mock.invocationCallOrder[call];

  it('takes the period lock, then the row lock, then re-reads, then writes — all inside one transaction', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-a', status: data.status }),
    );

    await service.approve(superAdmin(), 'rec-a');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((prisma.$executeRaw.mock.calls[0][0] as string[]).join('?')).toMatch(
      /pg_advisory_xact_lock_shared/,
    );
    expect((prisma.$queryRaw.mock.calls[0][0] as string[]).join('?')).toMatch(/FOR UPDATE/);
    // findUnique #0 is the caller's read (outside), #1 the locked re-read.
    expect(order(prisma.activityRecord.findUnique, 0)).toBeLessThan(order(prisma.$transaction));
    expect(order(prisma.$executeRaw)).toBeLessThan(order(prisma.$queryRaw));
    expect(order(prisma.$queryRaw)).toBeLessThan(order(prisma.activityRecord.findUnique, 1));
    expect(order(prisma.activityRecord.findUnique, 1)).toBeLessThan(
      order(prisma.activityRecord.update),
    );
    // The expected status rides in the WHERE, behind the lock.
    expect(prisma.activityRecord.update.mock.calls[0][0].where).toEqual({
      id: 'rec-a',
      status: ActivityRecordStatus.submitted,
    });
  });

  it('a status gate failing only on the locked re-read is a lost race (409), and nothing is written', async () => {
    const { prisma, service } = build();
    const seen = makeRecord({ id: 'rec-r', status: ActivityRecordStatus.submitted });
    prisma.activityRecord.findUnique
      .mockResolvedValueOnce(seen)
      .mockResolvedValueOnce({
        ...seen,
        status: ActivityRecordStatus.approved,
        updatedAt: new Date(seen.updatedAt.getTime() + 1),
      });

    await expect(service.startReview(superAdmin(), 'rec-r')).rejects.toBeInstanceOf(
      RecordChangedError,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a request that was already stale on arrival keeps its own answer', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-r', status: ActivityRecordStatus.approved }),
    );

    await expect(service.startReview(superAdmin(), 'rec-r')).rejects.toThrow(
      /Only a submitted record can be taken into review/,
    );
  });

  // LP4-04 slice 2 PR C (M3): each transition refuses with its own code and
  // the record's canonical status, so a screen words it; the English stays.
  it.each([
    ['update', 'record_not_editable', ActivityRecordStatus.approved, (s: ActivityRecordsService) =>
      s.update(standardUser(), 'rec-s', { activityValue: 1 })],
    ['recall', 'record_not_recallable', ActivityRecordStatus.under_review, (s: ActivityRecordsService) =>
      s.recall(standardUser(), 'rec-s')],
    ['submit', 'record_not_submittable', ActivityRecordStatus.approved, (s: ActivityRecordsService) =>
      s.submit(standardUser(), 'rec-s')],
    ['startReview', 'record_not_reviewable', ActivityRecordStatus.approved, (s: ActivityRecordsService) =>
      s.startReview(superAdmin(), 'rec-s')],
    ['approve', 'record_not_approvable', ActivityRecordStatus.draft, (s: ActivityRecordsService) =>
      s.approve(superAdmin(), 'rec-s')],
    ['void', 'record_not_voidable', ActivityRecordStatus.locked, (s: ActivityRecordsService) =>
      s.void(masterkey(), 'rec-s', 'reason')],
    ['reject', 'record_not_rejectable', ActivityRecordStatus.draft, (s: ActivityRecordsService) =>
      s.reject(superAdmin(), 'rec-s', 'reason')],
  ] as const)('%s refuses a record in the wrong status as %s, naming the status', async (_name, code, status, call) => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-s', status, createdBy: standardUser().id }),
    );
    const response = await call(service).then(
      () => { throw new Error('expected a refusal'); },
      (e: BadRequestException) => e.getResponse(),
    );
    expect(response).toMatchObject({ statusCode: 400, code, params: { status } });
  });

  it('a gate the locked re-read still passes goes ahead from where the record now is', async () => {
    // Approve is valid from `under_review` too, so a startReview that got in
    // first does not make the approval a conflict — and the audit row names
    // the state the record actually left.
    const { prisma, service } = build();
    const seen = makeRecord({ id: 'rec-r', status: ActivityRecordStatus.submitted });
    prisma.activityRecord.findUnique
      .mockResolvedValueOnce(seen)
      .mockResolvedValueOnce({ ...seen, status: ActivityRecordStatus.under_review });
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-r', status: data.status }),
    );

    await service.approve(superAdmin(), 'rec-r');
    expect(prisma.activityRecord.update.mock.calls[0][0].where.status).toBe(
      ActivityRecordStatus.under_review,
    );
    const row = audit.record.mock.calls[0][1] as { diff: { transition: unknown } };
    expect(row.diff.transition).toEqual({ from: 'under_review', to: 'approved' });
  });

  it('an edit refuses to land on a record that changed after it was read', async () => {
    const { prisma, service } = build();
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    const seen = makeRecord({ id: 'rec-e', status: ActivityRecordStatus.draft });
    prisma.activityRecord.findUnique
      .mockResolvedValueOnce(seen)
      .mockResolvedValueOnce({ ...seen, updatedAt: new Date(seen.updatedAt.getTime() + 5) });

    await expect(
      service.update(standardUser(), 'rec-e', { activityValue: 7 }),
    ).rejects.toBeInstanceOf(RecordChangedError);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('a record moved to another period meanwhile is a lost race — the period lock taken was the wrong one', async () => {
    const { prisma, service } = build();
    const seen = makeRecord({ id: 'rec-m', status: ActivityRecordStatus.submitted });
    prisma.activityRecord.findUnique
      .mockResolvedValueOnce(seen)
      .mockResolvedValueOnce({ ...seen, periodValue: 'Q4' });

    await expect(service.approve(superAdmin(), 'rec-m')).rejects.toBeInstanceOf(
      RecordChangedError,
    );
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('a period locked after the read keeps the lock\'s own answer, checked under the period lock', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-l', status: ActivityRecordStatus.submitted }),
    );
    prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });

    await expect(service.approve(superAdmin(), 'rec-l')).rejects.toBeInstanceOf(PeriodLockedError);
    expect(order(prisma.$executeRaw)).toBeLessThan(order(prisma.periodLock.findFirst));
  });

  it('create checks the period again once it holds it, and audits through the same transaction', async () => {
    const { prisma, service } = build();
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    prisma.activityRecord.create.mockResolvedValue(makeRecord());
    // Open for the early answer, locked by the time the period is held.
    prisma.periodLock.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'lock-1' });

    await expect(service.create(standardUser(), CREATE_DTO)).rejects.toBeInstanceOf(PeriodLockedError);
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(order(prisma.$executeRaw)).toBeLessThan(order(prisma.periodLock.findFirst, 1));
  });

  it('maps a deadlock or serialisation failure (P2034) to the lost-race answer', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-d', status: ActivityRecordStatus.submitted }),
    );
    prisma.activityRecord.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('deadlock detected', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );

    await expect(service.approve(superAdmin(), 'rec-d')).rejects.toBeInstanceOf(RecordChangedError);
  });
});

describe('ActivityRecordsService — activity type (LP3-03)', () => {
  const FUEL_DTO = { ...CREATE_DTO, category: 'Fuel' as const, activityUnit: 'litres' };
  const triggerError = (code: string) =>
    new Prisma.PrismaClientUnknownRequestError(
      `Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "refused", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
      { clientVersion: '6.19.3' },
    );

  function arrangeCreate(prisma: ReturnType<typeof build>['prisma']) {
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }));
    prisma.activityRecord.create.mockImplementation(({ data }: any) => makeRecord({ ...data, id: 'rec-new' }));
  }

  function arrangeUpdate(prisma: ReturnType<typeof build>['prisma'], existing: Partial<ActivityRecord>) {
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }));
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-t', status: ActivityRecordStatus.draft, createdBy: 'user-entry', ...existing }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-t', ...existing, ...data }),
      _count: { evidenceLinks: 0 },
      location: null,
    }));
  }

  it('refuses a new record in a typed category that names no activity type — before any lookup or write', async () => {
    const { prisma, calc, service } = build(1);
    arrangeCreate(prisma);
    await expect(service.create(standardUser(), FUEL_DTO)).rejects.toMatchObject({
      code: 'activity_type_required',
      status: 400,
    });
    expect(calc.compute).not.toHaveBeenCalled();
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    // The bulk dry run asks the same question through previewCreate.
    await expect(service.previewCreate(standardUser(), FUEL_DTO)).rejects.toBeInstanceOf(CalculationInputError);
  });

  it('stores the named type, prices by it, and baselines it against its own series', async () => {
    const { prisma, calc, service } = build(1);
    arrangeCreate(prisma);
    await service.create(standardUser(), { ...FUEL_DTO, activityType: 'diesel' });
    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Fuel', activityType: 'diesel' }),
      { enforceCategoryUnit: true },
    );
    expect(prisma.activityRecord.create.mock.calls[0][0].data.activityType).toBe('diesel');
    expect(prisma.activityRecord.findMany.mock.calls[0][0].where).toMatchObject({ category: 'Fuel', activityType: 'diesel' });
  });

  it('pools an untyped record only with untyped ones — an explicit null, never a dropped key', async () => {
    const { prisma, service } = build(2);
    arrangeCreate(prisma);
    await service.create(standardUser(), CREATE_DTO);
    const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
    // Prisma drops an `undefined` filter, which would pool diesel with petrol.
    expect(where).toHaveProperty('activityType', null);
    expect(prisma.activityRecord.create.mock.calls[0][0].data.activityType).toBeNull();
  });

  it('answers the slot-kind trigger (TA002) with a 409 that says which side the record is on', async () => {
    const { prisma, service } = build(1);
    arrangeCreate(prisma);
    prisma.activityRecord.create.mockRejectedValue(triggerError('TA002'));
    await expect(service.create(standardUser(), { ...FUEL_DTO, activityType: 'diesel' })).rejects.toMatchObject({
      status: 409,
      message: SLOT_HOLDS_UNTYPED_MESSAGE,
    });
    await expect(service.create(standardUser(), { ...FUEL_DTO, activityType: 'diesel' })).rejects.toBeInstanceOf(
      ActivityTypeSlotConflictError,
    );
  });

  it('lets a pre-LP3-03 untyped Fuel record be edited without naming a type', async () => {
    const { prisma, calc, service } = build(1);
    arrangeUpdate(prisma, { category: 'Fuel', activityType: null, activityUnit: 'litres', scope: 1 });
    await service.update(standardUser(), 'rec-t', { activityValue: 12 });
    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Fuel', activityType: null }),
      expect.anything(),
    );
    // An unrelated edit leaves the column alone.
    expect(prisma.activityRecord.update.mock.calls[0][0].data).not.toHaveProperty('activityType');
  });

  it('requires a type when an edit moves a record INTO a typed category, or clears a typed one', async () => {
    const moved = build(1);
    arrangeUpdate(moved.prisma, { category: 'Electricity', activityType: null });
    await expect(
      moved.service.update(standardUser(), 'rec-t', { category: 'Fuel', activityUnit: 'litres' }),
    ).rejects.toMatchObject({ code: 'activity_type_required' });

    const cleared = build(1);
    arrangeUpdate(cleared.prisma, { category: 'Fuel', activityType: 'diesel', activityUnit: 'litres', scope: 1 });
    await expect(cleared.service.update(standardUser(), 'rec-t', { activityType: null })).rejects.toMatchObject({
      code: 'activity_type_required',
    });
    expect(cleared.prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('checks a kept type against the EFFECTIVE category, so the engine refuses diesel Electricity', async () => {
    const { prisma, calc, service } = build(2);
    arrangeUpdate(prisma, { category: 'Fuel', activityType: 'diesel', activityUnit: 'litres', scope: 1 });
    await service.update(standardUser(), 'rec-t', { category: 'Electricity', activityUnit: 'kWh' });
    expect(calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Electricity', activityType: 'diesel' }),
      expect.anything(),
    );
  });

  it('saves a PATCHed activity type, so the column, slot and pool follow the recomputed snapshot', async () => {
    const { prisma, calc, service } = build(1);
    arrangeUpdate(prisma, { category: 'Fuel', activityType: 'diesel', activityUnit: 'litres', scope: 1 });
    await service.update(standardUser(), 'rec-t', { activityType: 'gas_oil' });
    expect(calc.compute).toHaveBeenCalledWith(expect.objectContaining({ activityType: 'gas_oil' }), expect.anything());
    expect(prisma.activityRecord.update.mock.calls[0][0].data.activityType).toBe('gas_oil');
    expect(prisma.activityRecord.findMany.mock.calls[0][0].where).toMatchObject({ activityType: 'gas_oil' });
  });

  it('answers the slot-kind trigger (TA002) on an update with a 409 too', async () => {
    const { prisma, service } = build(1);
    arrangeUpdate(prisma, { category: 'Fuel', activityType: 'diesel', activityUnit: 'litres', scope: 1 });
    prisma.activityRecord.update.mockRejectedValue(triggerError('TA002'));
    await expect(service.update(standardUser(), 'rec-t', { periodValue: 'Annual' })).rejects.toBeInstanceOf(
      ActivityTypeSlotConflictError,
    );
  });

  it("re-derives the submit gate's anomaly verdict against the record's own activity type", async () => {
    const { prisma, calc, service } = build(1);
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({
        id: 'rec-s',
        category: 'Fuel',
        scope: 1,
        activityType: 'diesel',
        activityUnit: 'litres',
        status: ActivityRecordStatus.draft,
        // What the engine stub gives for it, so K11 finds it fresh.
        calculation: calc.snapshot as unknown as Prisma.JsonValue,
      }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-s', status: data.status }));
    await service.submit(standardUser(), 'rec-s');
    expect(prisma.activityRecord.findMany.mock.calls[0][0].where).toMatchObject({ category: 'Fuel', activityType: 'diesel' });
  });

  it('answers the snapshot trigger (TA001) on an update with a 409, not a 500', async () => {
    const { prisma, service } = build(2);
    arrangeUpdate(prisma, {});
    prisma.activityRecord.update.mockRejectedValue(triggerError('TA001'));
    await expect(service.update(standardUser(), 'rec-t', { activityValue: 5 })).rejects.toBeInstanceOf(SnapshotImmutableError);
  });
});

describe('ActivityRecordsService — K11: submit and approve recompute the figure (LP4-02 B2)', () => {
  // Decisions 2026-10-11 (L4, P6) and 2026-10-13 (C1–C7): the figure is
  // recomputed from the stored inputs with the current library before the
  // lock and compared inside it — after the tenant load, the role and the
  // record's own gates, before the anomaly gate.
  const STALE_FIGURE = { ...FRESH_SNAPSHOT, tCo2e: 0.0001, kgCo2e: 0.1 };
  // The whole body: no `params` — nothing about the figure, the factor or the
  // refusal reaches the caller (follow-up (1)).
  const STALE_BODY = {
    statusCode: 409,
    error: 'Conflict',
    code: 'calculation_stale',
    message: CALCULATION_STALE_MESSAGE,
  };
  const WATER: UncalculatedSnapshot = {
    snapshotSchema: 1,
    category: 'Water',
    geographyCode: 'TR',
    reportingYear: 2024,
    scope: 3,
    inputValue: 100,
    inputUnit: 'cubic_metres',
    reasonCode: 'no_emission_factor',
    reason: 'No emission factor is available for "Water" (TR, 2024), …',
  };

  // A snapshot is a typed object here and `JsonValue` on the row.
  type RecordOver = Omit<Partial<ActivityRecord>, 'calculation'> & { calculation?: unknown };
  const draft = (over: RecordOver = {}) =>
    makeRecord({ id: 'rec-k', status: ActivityRecordStatus.draft, createdBy: 'user-entry', ...over } as Partial<ActivityRecord>);
  const submitted = (over: RecordOver = {}) =>
    makeRecord({ id: 'rec-k', status: ActivityRecordStatus.submitted, createdBy: 'user-entry', ...over } as Partial<ActivityRecord>);

  function arrange(record: ActivityRecord) {
    const ctx = build(2);
    ctx.prisma.activityRecord.findUnique.mockResolvedValue(record);
    ctx.prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary());
    ctx.prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ ...record, ...data }),
    );
    return ctx;
  }

  async function staleBody(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CalculationStaleError);
    return (error as CalculationStaleError).getResponse();
  }

  it('submit recomputes from the stored inputs — the inherited unit, the site’s geography — and commits a fresh record', async () => {
    const record = draft({ locationId: 'loc-1' });
    const { prisma, calc, service } = arrange(record);
    prisma.location.findUnique.mockResolvedValue({ id: 'loc-1', subsidiaryId: 'sub-1', geographyCode: 'TR' });

    const dto = await service.submit(standardUser(), 'rec-k');

    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(calc.compute).toHaveBeenCalledTimes(1);
    expect(calc.compute).toHaveBeenCalledWith(
      {
        category: 'Electricity',
        activityType: null,
        geographyCode: 'TR',
        reportingYear: 2024,
        value: 45000,
        unit: 'kWh',
        reportingPeriod: expect.any(String),
        parameters: null,
      },
      { enforceCategoryUnit: false },
    );
    expect(prisma.location.findUnique).toHaveBeenCalledWith({ where: { id: 'loc-1' } });
  });

  it('approve recomputes too, and commits a fresh record', async () => {
    const { calc, service } = arrange(submitted());
    const dto = await service.approve(superAdmin(), 'rec-k');
    expect(dto.status).toBe(ActivityRecordStatus.approved);
    expect(calc.compute).toHaveBeenCalledTimes(1);
  });

  it('refuses a rewritten figure: 409 calculation_stale with no params, nothing written or audited', async () => {
    const { prisma, service } = arrange(draft({ calculation: STALE_FIGURE }));
    const body = await staleBody(service.submit(standardUser(), 'rec-k'));
    expect(body).toEqual(STALE_BODY);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('approve refuses a submitted record the library has moved under (an erratum), and leaves it untouched', async () => {
    const { prisma, calc, service } = arrange(submitted());
    calc.compute.mockResolvedValue({ ...FRESH_SNAPSHOT, factorValue: 0.5, kgCo2e: 22500, tCo2e: 22.5 });
    await staleBody(service.approve(superAdmin(), 'rec-k'));
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a pre-LP3-03 snapshot is stale even when its figure matches', async () => {
    const { service } = arrange(draft({ calculation: { tCo2e: 19.8, factorId: 'factor-1' } }));
    await staleBody(service.submit(standardUser(), 'rec-k'));
  });

  it('a snapshot that kept the unit as entered (`kwh`) is the same unit as the stored `kWh`', async () => {
    const { service } = arrange(draft({ calculation: { ...FRESH_SNAPSHOT, inputUnit: 'kwh' } }));
    const dto = await service.submit(standardUser(), 'rec-k');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
  });

  it('an uncalculated record recomputed as uncalculated is fresh — and is not scored', async () => {
    const record = draft({ category: 'Water', scope: 3, activityUnit: 'cubic_metres', activityValue: 100, calculation: WATER });
    const { prisma, calc, service } = arrange(record);
    calc.compute.mockResolvedValue(WATER);
    const dto = await service.submit(standardUser(), 'rec-k');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  it('an uncalculated record a factor has since covered is stale', async () => {
    const record = draft({ category: 'Water', scope: 3, activityUnit: 'cubic_metres', activityValue: 100, calculation: WATER });
    const { service } = arrange(record);
    await staleBody(service.submit(standardUser(), 'rec-k'));
  });

  it.each([
    ['no factor (422)', () => new NoEmissionFactorError('No emission factor found', { code: 'no_factor' })],
    ['a withdrawn release’s gap (422)', () => new NoEmissionFactorError('No emission factor found', { code: 'placeholder_refused' })],
    ['an input refusal (400)', () => new CalculationInputError('unit_not_for_category', 'Unit "x" is not valid')],
    ['a library conflict (409)', () => new FactorLibraryConflictError('ambiguous_factor', 'Two releases claim it')],
    ['a site that no longer resolves (404)', () => new ResourceNotFoundError('location_not_found')],
  ])('a recompute that refuses — %s — answers calculation_stale, never its own code', async (_label, refusal) => {
    const onSubmit = arrange(draft());
    onSubmit.calc.compute.mockRejectedValue(refusal());
    expect(await staleBody(onSubmit.service.submit(standardUser(), 'rec-k'))).toEqual(STALE_BODY);
    const onApprove = arrange(submitted());
    onApprove.calc.compute.mockRejectedValue(refusal());
    expect(await staleBody(onApprove.service.approve(superAdmin(), 'rec-k'))).toEqual(STALE_BODY);
    expect(onApprove.prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a plain Error', () => new Error('Engine defect: kWh normalised to m3')],
    // `qa-auditor` A1/A2: a 5xx is the server's fault, never the record's.
    ['a 500', () => new InternalServerErrorException('Engine defect')],
    ['a 503', () => new ServiceUnavailableException('Engine defect')],
  ])('an engine defect (%s) is not stale: it propagates', async (_label, defect) => {
    const { prisma, calc, service } = arrange(draft());
    calc.compute.mockRejectedValue(defect());
    await expect(service.submit(standardUser(), 'rec-k')).rejects.toThrow(/Engine defect/);
    await expect(service.submit(standardUser(), 'rec-k')).rejects.not.toBeInstanceOf(CalculationStaleError);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  // --- Order (follow-up (1)): a stale figure never answers for another gate.

  it('a record outside the caller’s subsidiaries answers 404 and is never recomputed', async () => {
    const { calc, service } = arrange(draft({ subsidiaryId: 'sub-9', calculation: STALE_FIGURE }));
    await expect(service.submit(standardUser(), 'rec-k')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.approve(superAdmin({ accessibleSubsidiaryIds: ['sub-1'] }), 'rec-k')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(calc.compute).not.toHaveBeenCalled();
  });

  it('a role refusal comes before the recompute', async () => {
    const { calc, service } = arrange(submitted({ calculation: STALE_FIGURE }));
    await expect(service.submit(auditor(), 'rec-k')).rejects.toBeInstanceOf(SubmitRoleRefusedError);
    await expect(service.approve(auditor(), 'rec-k')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.approve(standardUser(), 'rec-k')).rejects.toBeInstanceOf(ForbiddenException);
    expect(calc.compute).not.toHaveBeenCalled();
  });

  it.each([
    [
      'submit by someone other than the author',
      (s: ActivityRecordsService) => s.submit(standardUser({ id: 'user-other' }), 'rec-k'),
      draft,
      SubmitAuthorRefusedError,
    ],
    ['submit of an approved record', (s: ActivityRecordsService) => s.submit(standardUser(), 'rec-k'), (o: RecordOver) => draft({ ...o, status: ActivityRecordStatus.approved }), BadRequestException],
    ['approve of a draft', (s: ActivityRecordsService) => s.approve(superAdmin(), 'rec-k'), draft, BadRequestException],
    ['approve of one’s own record', (s: ActivityRecordsService) => s.approve(superAdmin({ id: 'user-entry' }), 'rec-k'), submitted, SelfApprovalRefusedError],
  ] as const)('%s keeps its own answer over a stale figure', async (_label, act, fixture, refusal) => {
    const { prisma, service } = arrange(fixture({ calculation: STALE_FIGURE }));
    // The own-record row: the author, since made a super_admin, approves (a
    // masterkey's own record is a self-approval since INC-2.6, not a refusal).
    // The other rows never reach the approver check.
    prisma.people.set('user-entry', { role: 'super_admin', grants: ['sub-1'] });
    await expect(act(service)).rejects.toBeInstanceOf(refusal);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('a locked period keeps its own answer over a stale figure, on submit and on approve', async () => {
    for (const [record, act] of [
      [draft({ calculation: STALE_FIGURE }), (s: ActivityRecordsService) => s.submit(standardUser(), 'rec-k')],
      [submitted({ calculation: STALE_FIGURE }), (s: ActivityRecordsService) => s.approve(superAdmin(), 'rec-k')],
    ] as const) {
      const { prisma, service } = arrange(record);
      prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
      await expect(act(service)).rejects.toBeInstanceOf(PeriodLockedError);
    }
  });

  it('a missing evidence file is named before a stale figure (the contract’s order)', async () => {
    const { prisma, service } = arrange(draft({ calculation: STALE_FIGURE }));
    prisma.activityRecordEvidence.count.mockResolvedValue(0);
    await expect(service.submit(standardUser(), 'rec-k')).rejects.toBeInstanceOf(EvidenceRequiredError);
  });

  it('a stale anomalous record answers 409, and its baseline is never queried', async () => {
    const { prisma, service } = arrange(
      draft({ reportingPeriod: 'monthly', periodValue: 'March', calculation: STALE_FIGURE }),
    );
    prisma.activityRecord.findMany.mockResolvedValue([{ tCo2e: 1 }]);
    await staleBody(service.submit(standardUser(), 'rec-k'));
    expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
  });

  // `security-rls` P2-1 (B2 review): the totals group by the record's own
  // `scope` column, which the snapshot does not carry and the engine does not
  // read — so a direct writer's Electricity row filed under Scope 3 passed
  // K11 with an honest figure and moved its tCO₂e between scopes.
  it.each([
    ['submit', 3, (s: ActivityRecordsService) => s.submit(standardUser(), 'rec-k'), draft],
    ['approve', 1, (s: ActivityRecordsService) => s.approve(superAdmin(), 'rec-k'), submitted],
  ] as const)('%s refuses a record whose scope is not its category’s (Electricity filed as Scope %s)', async (op, scope, act, fixture) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { prisma, service } = arrange(fixture({ scope }));
      await staleBody(act(service));
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toBe(`calculation_stale: ${op} of record rec-k refused — input differ`);
    } finally {
      warn.mockRestore();
    }
  });

  // `security-rls` re-review P2-B: the period lock is looked up by exact
  // value, while the totals trim and lower-case it — a direct writer's
  // `annual`/`'January '` slipped past a lock and still landed in the period.
  it.each([
    ['a period value in another spelling', { periodValue: 'annual' }],
    ['a period value with a trailing space', { reportingPeriod: 'monthly', periodValue: 'January ' }],
    ['a granularity that does not exist', { reportingPeriod: 'weekly', periodValue: 'Annual' }],
  ] as const)('refuses %s: the period is an input too', async (_label, period) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { prisma, service } = arrange(draft(period));
      await staleBody(service.submit(standardUser(), 'rec-k'));
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toBe('calculation_stale: submit of record rec-k refused — input differ');
      const onApprove = arrange(submitted(period));
      await staleBody(onApprove.service.approve(superAdmin(), 'rec-k'));
    } finally {
      warn.mockRestore();
    }
  });

  it('the scope is judged on the record as LOCKED, not as first read; a period moved meanwhile is a lost race', async () => {
    // The scope is no engine input, so a change between the read and the
    // lock is caught only because the locked row is read (`qa-auditor`
    // re-review, mutant S2). A period that changed is the lock protocol's
    // own lost race (`withLockedRecord`), before K11.
    const seen = draft();
    const scope = arrange(seen);
    scope.prisma.activityRecord.findUnique.mockResolvedValueOnce(seen).mockResolvedValueOnce({ ...seen, scope: 3 });
    await staleBody(scope.service.submit(standardUser(), 'rec-k'));
    const period = arrange(seen);
    period.prisma.activityRecord.findUnique.mockResolvedValueOnce(seen).mockResolvedValueOnce({ ...seen, periodValue: 'annual' });
    await expect(period.service.submit(standardUser(), 'rec-k')).rejects.toBeInstanceOf(RecordChangedError);
  });

  it('a scope mismatch beside a figure mismatch logs both, input first', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service } = arrange(draft({ scope: 3, calculation: STALE_FIGURE }));
      await staleBody(service.submit(standardUser(), 'rec-k'));
      expect(String(warn.mock.calls[0][0])).toBe('calculation_stale: submit of record rec-k refused — input, figure differ');
      const both = arrange(draft({ scope: 3, calculation: { ...FRESH_SNAPSHOT, inputValue: 1 } }));
      await staleBody(both.service.submit(standardUser(), 'rec-k'));
      expect(String(warn.mock.calls[1][0])).toBe('calculation_stale: submit of record rec-k refused — input differ');
    } finally {
      warn.mockRestore();
    }
  });

  // --- Between the recompute and the lock (C1-a, C2-A).

  it('inputs changed between the read and the lock: record_changed, not a verdict on the new inputs', async () => {
    const seen = draft();
    const { prisma, calc, service } = arrange(seen);
    prisma.activityRecord.findUnique
      .mockResolvedValueOnce(seen)
      .mockResolvedValueOnce({ ...seen, activityValue: 50000, updatedAt: new Date('2026-02-01T00:00:00.000Z') });
    await expect(service.submit(standardUser(), 'rec-k')).rejects.toBeInstanceOf(RecordChangedError);
    expect(calc.compute).toHaveBeenCalledWith(expect.objectContaining({ value: 45000 }), { enforceCategoryUnit: false });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it.each([
    ['subsidiaryId', 'sub-2'],
    ['locationId', 'loc-2'],
    ['category', 'Natural Gas'],
    ['activityType', 'natural_gas'],
    ['reportingYear', 2025],
    ['reportingPeriod', 'monthly'],
    ['activityUnit', 'MWh'],
    ['parameters', { ncvKcalPerSm3: 8100 }],
  ] as const)('a change of %s between the read and the lock is a change of inputs', async (field, value) => {
    const seen = submitted();
    const { prisma, service } = arrange(seen);
    prisma.activityRecord.findUnique.mockResolvedValueOnce(seen).mockResolvedValueOnce({ ...seen, [field]: value });
    await expect(service.approve(superAdmin(), 'rec-k')).rejects.toBeInstanceOf(RecordChangedError);
  });

  it('a status-only change between the read and the lock is not a change of inputs', async () => {
    const seen = submitted();
    const { prisma, service } = arrange(seen);
    prisma.activityRecord.findUnique
      .mockResolvedValueOnce(seen)
      .mockResolvedValueOnce({ ...seen, status: ActivityRecordStatus.under_review, updatedAt: new Date('2026-02-01T00:00:00.000Z') });
    const dto = await service.approve(superAdmin(), 'rec-k');
    expect(dto.status).toBe(ActivityRecordStatus.approved);
  });

  it('a figure re-saved fresh between the read and the lock is judged as locked', async () => {
    // The stored figure was stale when read, and an audited save recomputed
    // it before the lock: the record as locked is what commits.
    const seen = draft({ calculation: STALE_FIGURE });
    const { prisma, service } = arrange(seen);
    prisma.activityRecord.findUnique.mockResolvedValueOnce(seen).mockResolvedValueOnce(draft());
    const dto = await service.submit(standardUser(), 'rec-k');
    expect(dto.status).toBe(ActivityRecordStatus.submitted);
  });

  // --- The log line (follow-up (6)): which part, never the values.

  it('logs the operation, the record and which part mismatched — never a figure or an input', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service } = arrange(draft({ calculation: { ...STALE_FIGURE, factorValue: 0.0000022 } }));
      await staleBody(service.submit(standardUser(), 'rec-k'));
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toBe('calculation_stale: submit of record rec-k refused — figure, factor differ');
      expect(line).not.toMatch(/0\.0001|19\.8|45000|0\.44/);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a legacy snapshot and a refusal by name', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const legacy = arrange(submitted({ calculation: { tCo2e: 19.8, factorId: 'factor-1' } }));
      await staleBody(legacy.service.approve(superAdmin(), 'rec-k'));
      const refused = arrange(draft());
      refused.calc.compute.mockRejectedValue(new NoEmissionFactorError('No emission factor found', { code: 'no_factor' }));
      await staleBody(refused.service.submit(standardUser(), 'rec-k'));
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringMatching(/^calculation_stale: approve of record rec-k refused — legacy snapshot/),
        'calculation_stale: submit of record rec-k refused — recompute refused (no_factor)',
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ActivityRecordsService — a typed category’s record names its type before it is committed (LP4-02 B2, C8)', () => {
  // Decision C8 (owner, 2026-10-13): a record of Fuel, Mobile Combustion or
  // Refrigerants with no activity type is refused `activity_type_required`
  // at submit and approve — whoever wrote it. A pre-LP3-03 record may still
  // be EDITED untyped in its own category, but names its fuel or gas before
  // it is committed; a draft a direct writer inserted untyped never is. The
  // check runs under the lock after the record's own gates and before K11,
  // so the answer names the remedy (choose the type), not "save again".
  type RecordOver = Omit<Partial<ActivityRecord>, 'calculation'> & { calculation?: unknown };
  const untyped = (category: string, over: RecordOver = {}) =>
    makeRecord({
      id: 'rec-t',
      category,
      // The category's own scope: K11 refuses any other (P2-1).
      scope: CATEGORY_SCOPE_MAP[category as keyof typeof CATEGORY_SCOPE_MAP],
      activityType: null,
      activityUnit: 'litres',
      status: ActivityRecordStatus.draft,
      createdBy: 'user-entry',
      ...over,
    } as Partial<ActivityRecord>);

  function arrange(record: ActivityRecord) {
    const ctx = build(1);
    ctx.prisma.activityRecord.findUnique.mockResolvedValue(record);
    ctx.prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ ...record, ...data }));
    return ctx;
  }

  async function refusalOf(promise: Promise<unknown>) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CalculationInputError);
    expect((error as CalculationInputError).code).toBe('activity_type_required');
    return error as CalculationInputError;
  }

  it.each(['Fuel', 'Mobile Combustion', 'Refrigerants'])(
    'submit refuses an untyped %s draft whose figure is otherwise fresh — 400 activity_type_required, nothing written',
    async (category) => {
      const { prisma, calc, service } = build(1);
      const record = untyped(category, { calculation: calc.snapshot });
      prisma.activityRecord.findUnique.mockResolvedValue(record);
      const error = await refusalOf(service.submit(standardUser(), 'rec-t'));
      expect(error.getStatus()).toBe(400);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('approve refuses an untyped Fuel record submitted before the rule — the reviewer returns it', async () => {
    const { prisma, calc, service } = build(1);
    prisma.activityRecord.findUnique.mockResolvedValue(
      untyped('Fuel', { status: ActivityRecordStatus.submitted, calculation: calc.snapshot }),
    );
    await refusalOf(service.approve(superAdmin(), 'rec-t'));
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('a rejected pre-LP3-03 record is not resubmitted untyped', async () => {
    const { prisma, calc, service } = build(1);
    prisma.activityRecord.findUnique.mockResolvedValue(
      untyped('Fuel', { status: ActivityRecordStatus.rejected, calculation: calc.snapshot }),
    );
    await refusalOf(service.submit(standardUser(), 'rec-t'));
  });

  it('named the type, the record submits; an untyped record of an untyped category is unaffected', async () => {
    const typed = arrange(untyped('Fuel', { activityType: 'diesel' }));
    typed.prisma.activityRecord.findUnique.mockResolvedValue(
      untyped('Fuel', { activityType: 'diesel', calculation: typed.calc.snapshot }),
    );
    expect((await typed.service.submit(standardUser(), 'rec-t')).status).toBe(ActivityRecordStatus.submitted);
    // The record's own type reaches the engine (`qa-auditor` A5): priced as
    // `unspecified` instead, a diesel record would be refused by every recompute.
    expect(typed.calc.compute).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'Fuel', activityType: 'diesel', unit: 'litres' }),
      { enforceCategoryUnit: false },
    );
    const water = arrange(untyped('Water', { activityUnit: 'cubic_metres' }));
    water.prisma.activityRecord.findUnique.mockResolvedValue(
      untyped('Water', { activityUnit: 'cubic_metres', calculation: water.calc.snapshot }),
    );
    expect((await water.service.submit(standardUser(), 'rec-t')).status).toBe(ActivityRecordStatus.submitted);
  });

  it('is checked before K11 at approve too: the reviewer is told the record lacks its type, not to have it saved again', async () => {
    // The real pre-LP3-03 case (`qa-auditor` re-review): an untyped submitted
    // record whose snapshot is the old, untagged one.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { prisma, service } = build(1);
      prisma.activityRecord.findUnique.mockResolvedValue(
        untyped('Fuel', { status: ActivityRecordStatus.submitted, calculation: { tCo2e: 2.6, factorId: 'factor-1' } }),
      );
      await refusalOf(service.approve(superAdmin(), 'rec-t'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('is checked before K11: an untyped record with a stale figure is told to name its type, and nothing is logged stale', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { prisma, service } = build(1);
      prisma.activityRecord.findUnique.mockResolvedValue(
        untyped('Fuel', { calculation: { ...FRESH_SNAPSHOT, tCo2e: 0.0001 } }),
      );
      await refusalOf(service.submit(standardUser(), 'rec-t'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['a submit by someone else', (s: ActivityRecordsService) => s.submit(standardUser({ id: 'user-other' }), 'rec-t'), ActivityRecordStatus.draft, SubmitAuthorRefusedError],
    ['a submit of an approved record', (s: ActivityRecordsService) => s.submit(standardUser(), 'rec-t'), ActivityRecordStatus.approved, BadRequestException],
    ['an approve of one’s own record', (s: ActivityRecordsService) => s.approve(superAdmin({ id: 'user-entry' }), 'rec-t'), ActivityRecordStatus.submitted, SelfApprovalRefusedError],
  ] as const)('%s keeps its own answer over a missing type', async (_label, act, status, refusal) => {
    const { prisma, calc, service } = build(1);
    // As above: the own-record row's author is since a super_admin.
    prisma.people.set('user-entry', { role: 'super_admin', grants: ['sub-1'] });
    prisma.activityRecord.findUnique.mockResolvedValue(untyped('Fuel', { status, calculation: calc.snapshot }));
    const error = await act(service).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(refusal);
    if (refusal === BadRequestException) expect(error).not.toBeInstanceOf(CalculationInputError);
  });

  it('a locked period and a missing evidence file are named before a missing type', async () => {
    const locked = build(1);
    locked.prisma.activityRecord.findUnique.mockResolvedValue(untyped('Fuel', { calculation: locked.calc.snapshot }));
    locked.prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
    await expect(locked.service.submit(standardUser(), 'rec-t')).rejects.toBeInstanceOf(PeriodLockedError);
    const bare = build(1);
    bare.prisma.activityRecord.findUnique.mockResolvedValue(untyped('Fuel', { calculation: bare.calc.snapshot }));
    bare.prisma.activityRecordEvidence.count.mockResolvedValue(0);
    await expect(bare.service.submit(standardUser(), 'rec-t')).rejects.toBeInstanceOf(EvidenceRequiredError);
  });
});

describe('ActivityRecordsService — every Scope 1–2 category needs a file before it is committed (K3)', () => {
  // Decision K3 (owner, 2026-11-10; QA BUG-R2-02): Mobile Combustion,
  // Refrigerants and Fugitive Gas join the evidence-required set, and the
  // check runs at approve as well as submit — after the record's own gates and
  // the period lock, before C8 and K11 — so a record submitted before the rule
  // is not approved without one. No exemption by date or audit row (C8).
  type RecordOver = Omit<Partial<ActivityRecord>, 'calculation'> & { calculation?: unknown };
  const TYPE: Record<string, string | null> = {
    'Mobile Combustion': 'on_road_diesel',
    Refrigerants: 'R-32',
    'Fugitive Gas': null,
    Waste: null,
  };
  const UNIT: Record<string, string> = {
    'Mobile Combustion': 'litres',
    Refrigerants: 'kg',
    'Fugitive Gas': 'standard_cubic_metres',
    Waste: 'tonnes',
  };
  const NEW_SET = ['Mobile Combustion', 'Refrigerants', 'Fugitive Gas'] as const;

  function arrange(category: string, over: RecordOver = {}, files = 0) {
    const scope = CATEGORY_SCOPE_MAP[category as keyof typeof CATEGORY_SCOPE_MAP];
    const ctx = build(scope);
    const record = makeRecord({
      id: 'rec-v',
      category,
      scope,
      activityType: TYPE[category],
      activityUnit: UNIT[category],
      status: ActivityRecordStatus.draft,
      createdBy: 'user-entry',
      calculation: ctx.calc.snapshot,
      ...over,
    } as Partial<ActivityRecord>);
    ctx.prisma.activityRecord.findUnique.mockResolvedValue(record);
    ctx.prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ ...record, ...data }));
    ctx.prisma.activityRecordEvidence.count.mockResolvedValue(files);
    return ctx;
  }

  async function caught(promise: Promise<unknown>) {
    return promise.then(
      () => null,
      (e: unknown) => e,
    );
  }

  describe('submit', () => {
    it.each(NEW_SET)('refuses a %s draft with no file — evidence_required, nothing written', async (category) => {
      const { prisma, service } = arrange(category);
      const error = await caught(service.submit(standardUser(), 'rec-v'));
      expect(error).toBeInstanceOf(EvidenceRequiredError);
      expect((error as EvidenceRequiredError).getResponse()).toMatchObject({
        code: 'evidence_required',
        params: { category },
      });
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      // THIS record's files, not any link anywhere.
      expect(prisma.activityRecordEvidence.count).toHaveBeenCalledWith({ where: { activityRecordId: 'rec-v' } });
    });

    it.each(NEW_SET)('submits a %s draft with one file', async (category) => {
      const { service } = arrange(category, {}, 1);
      expect((await service.submit(standardUser(), 'rec-v')).status).toBe(ActivityRecordStatus.submitted);
    });

    it('refuses a rejected Refrigerants record resubmitted without a file', async () => {
      const { prisma, service } = arrange('Refrigerants', { status: ActivityRecordStatus.rejected });
      await expect(service.submit(standardUser(), 'rec-v')).rejects.toBeInstanceOf(EvidenceRequiredError);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('names a locked period before the missing file at submit', async () => {
      const { prisma, service } = arrange('Mobile Combustion');
      prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
      await expect(service.submit(standardUser(), 'rec-v')).rejects.toBeInstanceOf(PeriodLockedError);
    });

    it('submits a Waste draft with no file, and never counts its files', async () => {
      const { prisma, service } = arrange('Waste');
      expect((await service.submit(standardUser(), 'rec-v')).status).toBe(ActivityRecordStatus.submitted);
      expect(prisma.activityRecordEvidence.count).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it.each([
      ['Mobile Combustion', ActivityRecordStatus.submitted],
      ['Mobile Combustion', ActivityRecordStatus.under_review],
      ['Fugitive Gas', ActivityRecordStatus.submitted],
      ['Fugitive Gas', ActivityRecordStatus.under_review],
      ['Refrigerants', ActivityRecordStatus.submitted],
    ] as const)('refuses a %s record (%s) with no file — approval_evidence_missing, nothing written', async (category, status) => {
      const { prisma, service } = arrange(category, { status });
      const error = await caught(service.approve(superAdmin(), 'rec-v'));
      expect(error).toBeInstanceOf(ApprovalEvidenceMissingError);
      expect((error as ApprovalEvidenceMissingError).getStatus()).toBe(400);
      expect((error as ApprovalEvidenceMissingError).getResponse()).toMatchObject({
        code: 'approval_evidence_missing',
        params: { category },
      });
      // The approver is told the remedy open to them: return it to the author.
      expect((error as Error).message).toMatch(/return the record/);
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(prisma.activityRecordEvidence.count).toHaveBeenCalledWith({ where: { activityRecordId: 'rec-v' } });
    });

    it.each(NEW_SET)('approves a submitted %s record with one file', async (category) => {
      const { service } = arrange(category, { status: ActivityRecordStatus.submitted }, 1);
      expect((await service.approve(superAdmin(), 'rec-v')).status).toBe(ActivityRecordStatus.approved);
    });

    it('approves a submitted Waste record with no file, and never counts its files', async () => {
      const { prisma, service } = arrange('Waste', { status: ActivityRecordStatus.submitted });
      expect((await service.approve(superAdmin(), 'rec-v')).status).toBe(ActivityRecordStatus.approved);
      expect(prisma.activityRecordEvidence.count).not.toHaveBeenCalled();
    });

    it('holds a super_admin approver to the same gates: no file, then a locked period', async () => {
      const noFile = arrange('Mobile Combustion', { status: ActivityRecordStatus.submitted });
      await expect(noFile.service.approve(superAdmin(), 'rec-v')).rejects.toBeInstanceOf(ApprovalEvidenceMissingError);
      expect(noFile.prisma.activityRecord.update).not.toHaveBeenCalled();
      const locked = arrange('Mobile Combustion', { status: ActivityRecordStatus.submitted }, 1);
      locked.prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
      await expect(locked.service.approve(superAdmin(), 'rec-v')).rejects.toBeInstanceOf(PeriodLockedError);
      expect(locked.prisma.activityRecord.update).not.toHaveBeenCalled();
      const ok = arrange('Mobile Combustion', { status: ActivityRecordStatus.submitted }, 1);
      expect((await ok.service.approve(superAdmin(), 'rec-v')).status).toBe(ActivityRecordStatus.approved);
    });

    it('names self-approval and a locked period before the missing file', async () => {
      const self = arrange('Mobile Combustion', { status: ActivityRecordStatus.submitted, createdBy: 'user-super-admin' });
      await expect(self.service.approve(superAdmin(), 'rec-v')).rejects.toBeInstanceOf(SelfApprovalRefusedError);
      const locked = arrange('Mobile Combustion', { status: ActivityRecordStatus.submitted });
      locked.prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
      await expect(locked.service.approve(superAdmin(), 'rec-v')).rejects.toBeInstanceOf(PeriodLockedError);
    });

    it('names the missing file before a missing type (C8) and before a stale figure (K11)', async () => {
      const untyped = arrange('Mobile Combustion', { status: ActivityRecordStatus.submitted, activityType: null });
      await expect(untyped.service.approve(superAdmin(), 'rec-v')).rejects.toBeInstanceOf(ApprovalEvidenceMissingError);
      const stale = arrange('Refrigerants', {
        status: ActivityRecordStatus.submitted,
        calculation: { tCo2e: 0.0001, factorId: 'factor-1' },
      });
      await expect(stale.service.approve(superAdmin(), 'rec-v')).rejects.toBeInstanceOf(ApprovalEvidenceMissingError);
    });
  });
});

describe('recordTriggerCode', () => {
  it('reads the SQLSTATE of an activity_records trigger from either Prisma error shape', () => {
    const unknown = (code: string) =>
      new Prisma.PrismaClientUnknownRequestError(`kind: QueryError(PostgresError { code: "${code}", message: "x" })`, {
        clientVersion: '6',
      });
    expect(recordTriggerCode(unknown('TA001'))).toBe('TA001');
    expect(recordTriggerCode(unknown('TA002'))).toBe('TA002');
    // Another trigger's code, or a message merely mentioning one, is not this.
    expect(recordTriggerCode(unknown('TA010'))).toBeNull();
    expect(recordTriggerCode(new Prisma.PrismaClientUnknownRequestError('TA001 mentioned in passing', { clientVersion: '6' }))).toBeNull();
    const raw = new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: '6', meta: { code: 'TA002' } });
    expect(recordTriggerCode(raw)).toBe('TA002');
    expect(recordTriggerCode(new Error('code: "TA001"'))).toBeNull();
  });
});

describe('a stored net bill\'s quantity is re-entered where it would be read otherwise (ng-kwh-engine review)', () => {
  const net = { category: 'Natural Gas', activityUnit: 'kWh', locationId: 'site-tr', parameters: { cvBasis: 'net' } };
  it.each([
    ['another site, its geography unknown here', { ...net, locationId: 'site-uk' }, true],
    ['the whole subsidiary instead of its site', { ...net, locationId: null }, true],
    ['a volume unit', { ...net, activityUnit: 'standard_cubic_metres', parameters: null }, true],
    ['MWh instead of kWh', { ...net, activityUnit: 'MWh' }, true],
    ['the basis dropped', { ...net, parameters: null }, true],
    ['the basis changed to gross', { ...net, parameters: { cvBasis: 'gross' } }, true],
    ['another category', { ...net, category: 'Electricity', parameters: null }, true],
    ['nothing that changes how it is read', { ...net }, false],
    ['the same unit in another spelling', { ...net, activityUnit: 'kwh' }, false],
    ['MWh in another spelling', { ...net, activityUnit: 'mwh' }, true],
    ['the basis sent as {}', { ...net, parameters: {} }, true],
    ['the basis sent as null', { ...net, parameters: { cvBasis: null } }, true],
  ] as const)('%s: %s', (_case, next, refused) => {
    expect(inheritsQuantityElsewhere(net, next)).toBe(refused);
  });

  it('lets a gross bill, a volume reading or another category move site or basis, on the same unit and category', () => {
    const gross = { ...net, parameters: { cvBasis: 'gross' } };
    expect(inheritsQuantityElsewhere(gross, { ...gross, locationId: 'site-uk', parameters: null })).toBe(false);
    const volume = { ...net, activityUnit: 'standard_cubic_metres', parameters: null };
    expect(inheritsQuantityElsewhere(volume, { ...volume, locationId: 'site-uk' })).toBe(false);
    const grid = { ...net, category: 'Electricity', parameters: null };
    expect(inheritsQuantityElsewhere(grid, { ...grid, locationId: 'site-uk' })).toBe(false);
  });

  it.each([
    ['a gross bill to MWh (×1,000)', { ...net, parameters: { cvBasis: 'gross' } }, { activityUnit: 'MWh' }],
    ['a gross bill to Sm³ with its basis cleared', { ...net, parameters: { cvBasis: 'gross' } }, { activityUnit: 'standard_cubic_metres', parameters: null }],
    ['a gross bill re-filed as Water', { ...net, parameters: { cvBasis: 'gross' } }, { category: 'Water', activityUnit: 'cubic_metres', parameters: null }],
  ] as const)('asks for the quantity of %s, whatever its basis (second review)', (_case, stored, change) => {
    expect(inheritsQuantityElsewhere(stored, { ...stored, ...change })).toBe(true);
  });

  it('keeps the API\'s inheritance for every other record, as before', () => {
    const grid = { ...net, category: 'Electricity', parameters: null };
    expect(inheritsQuantityElsewhere(grid, { ...grid, activityUnit: 'MWh' })).toBe(false);
    const volume = { ...net, activityUnit: 'cubic_metres', parameters: null };
    expect(inheritsQuantityElsewhere(volume, { ...volume, category: 'Water' })).toBe(false);
  });
});


describe('ActivityRecordsService — generationFuelRecord (self-gen-form, design 6)', () => {
  const CHP = { generationTopology: 'A', selfGenerationSource: 'natural_gas_chp', selfGeneratedKwh: 400000 } as const;
  const chpRecord = (over: Partial<ActivityRecord> = {}) =>
    makeRecord({
      id: 'rec-chp', subsidiaryId: 'sub-1', locationId: 'loc-1', reportingYear: 2026, createdBy: 'user-entry',
      category: 'Electricity', activityUnit: 'kWh', parameters: CHP as never, ...over,
    });
  /** True for the fuel lookup's query, and for no other `findMany` the service runs. */
  const isFuelLookup = (args: any) => args?.select?.activityType === true && args?.where?.status?.not === 'voided';
  /** The fuel lookup answers `rows`; every other `findMany` keeps answering `[]`. */
  function fuelRows(prisma: PrismaMock, rows: unknown[]) {
    prisma.activityRecord.findMany.mockImplementation(async (args: any) => (isFuelLookup(args) ? rows : []));
  }
  const gasAtSite = { subsidiaryId: 'sub-1', locationId: 'loc-1', reportingYear: 2026, category: 'Natural Gas', activityType: null };
  const lookups = (prisma: PrismaMock) => prisma.activityRecord.findMany.mock.calls.filter(([a]: any) => isFuelLookup(a));

  beforeEach(() => {
    audit.record.mockClear();
  });

  it('a page resolves every row in one lookup, and a plain row reads null', async () => {
    const { prisma, service } = build();
    const rows = [
      { ...chpRecord({ id: 'a' }), _count: { evidenceLinks: 0 }, location: null },
      { ...chpRecord({ id: 'b', locationId: 'loc-2' }), _count: { evidenceLinks: 0 }, location: null },
      { ...makeRecord({ id: 'c', category: 'Electricity' }), _count: { evidenceLinks: 0 }, location: null },
    ];
    prisma.activityRecord.findMany.mockImplementation(async (args: any) => (isFuelLookup(args) ? [gasAtSite] : rows));
    const page = await service.listPage(standardUser(), {});
    expect(page.items.map((r) => [r.id, r.generationFuelRecord])).toEqual([
      ['a', 'present'],
      ['b', 'missing'],
      ['c', null],
    ]);
    expect(lookups(prisma)).toHaveLength(1);
    expect((lookups(prisma)[0][0] as any).where.subsidiaryId).toEqual({ in: ['sub-1'] });
  });

  it('a single read resolves its record', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue({ ...chpRecord(), location: null });
    fuelRows(prisma, []);
    expect((await service.get(standardUser(), 'rec-chp')).generationFuelRecord).toBe('missing');
    fuelRows(prisma, [gasAtSite]);
    expect((await service.get(standardUser(), 'rec-chp')).generationFuelRecord).toBe('present');
  });

  it('a create answers the state and never audits it', async () => {
    const { prisma, service } = build(2);
    prisma.location.findUnique.mockResolvedValue({ id: 'loc-1', subsidiaryId: 'sub-1', geographyCode: 'TR' });
    prisma.activityRecord.create.mockImplementation(async ({ data }: any) => ({
      ...chpRecord({ id: 'rec-new' }),
      ...data,
      _count: { evidenceLinks: 0 },
      location: null,
    }));
    fuelRows(prisma, [gasAtSite]);
    const dto = await service.create(standardUser(), {
      subsidiaryId: 'sub-1', locationId: 'loc-1', reportingYear: 2026, reportingPeriod: 'quarterly', periodValue: 'Q1',
      category: 'Electricity', activityValue: 600000, activityUnit: 'kWh', parameters: CHP,
    } as never);
    expect(dto.generationFuelRecord).toBe('present');
    const diff = audit.record.mock.calls[0][1].diff as any;
    expect(Object.keys(diff.after).sort()).toEqual(PERSISTED_KEYS);
  });

  it('an update answers the state and audits neither side with it', async () => {
    const { prisma, service } = build(2);
    const row = { ...chpRecord(), _count: { evidenceLinks: 0 }, location: null };
    prisma.location.findUnique.mockResolvedValue({ id: 'loc-1', subsidiaryId: 'sub-1', geographyCode: 'TR' });
    prisma.activityRecord.findUnique.mockResolvedValue(row);
    prisma.activityRecord.update.mockImplementation(async ({ data }: any) => ({ ...row, ...data }));
    fuelRows(prisma, []);
    const dto = await service.update(standardUser(), 'rec-chp', { activityValue: 550000 });
    expect(dto.generationFuelRecord).toBe('missing');
    const diff = audit.record.mock.calls[0][1].diff as any;
    expect(Object.keys(diff.before).sort()).toEqual(PERSISTED_KEYS);
    expect(Object.keys(diff.after).sort()).toEqual(PERSISTED_KEYS);
  });

  it('a review step answers the state, so the sheet keeps its notice', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(chpRecord({ status: ActivityRecordStatus.submitted }));
    prisma.activityRecord.update.mockImplementation(async ({ data }: any) => ({
      ...chpRecord({ status: data.status }),
      _count: { evidenceLinks: 0 },
    }));
    fuelRows(prisma, []);
    const dto = await service.startReview(superAdmin(), 'rec-chp');
    expect(dto.status).toBe(ActivityRecordStatus.under_review);
    expect(dto.generationFuelRecord).toBe('missing');
  });

  it('a solar record asks nothing', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue({
      ...chpRecord({ parameters: { ...CHP, selfGenerationSource: 'solar' } as never }),
      location: null,
    });
    fuelRows(prisma, [gasAtSite]);
    expect((await service.get(standardUser(), 'rec-chp')).generationFuelRecord).toBeNull();
    expect(lookups(prisma)).toHaveLength(0);
  });
});

describe('ActivityRecordsService — start review names the submission it saw (self-gen-form, outside review of b8b0d78b)', () => {
  const SUBMITTED_AT = new Date('2026-11-20T10:00:00.000Z');
  function submittedRecord(prisma: PrismaMock) {
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-sr', status: ActivityRecordStatus.submitted, submittedAt: SUBMITTED_AT }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({
      ...makeRecord({ id: 'rec-sr', status: data.status, submittedAt: SUBMITTED_AT }),
      _count: { evidenceLinks: 0 },
    }));
  }

  beforeEach(() => {
    audit.record.mockClear();
  });

  it('refuses a resubmitted record as record_changed, writing nothing', async () => {
    const { prisma, service } = build();
    submittedRecord(prisma);
    await expect(service.startReview(superAdmin(), 'rec-sr', '2026-11-19T10:00:00.000Z')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'record_changed' }),
    });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('takes the submission it saw into review, and compares nothing when none is named', async () => {
    const { prisma, service } = build();
    submittedRecord(prisma);
    expect((await service.startReview(superAdmin(), 'rec-sr', SUBMITTED_AT.toISOString())).status).toBe(
      ActivityRecordStatus.under_review,
    );
    expect((await service.startReview(superAdmin(), 'rec-sr')).status).toBe(ActivityRecordStatus.under_review);
  });
});

// ---------------------------------------------------------------------------
// inc26-roles-approval-chain (INC-2.6 §1.1, design Decision 7): who decides a
// record. Every refusal below asserts that nothing was written — no record
// update and no audit row (the mock's transaction client shares these spies).
// ---------------------------------------------------------------------------

describe('ActivityRecordsService — the approver chain (inc26-roles-approval-chain)', () => {
  const SUBMITTED_AT = new Date('2026-11-25T09:00:00.000Z');
  const SEEN = SUBMITTED_AT.toISOString();

  function arrange(over: Partial<ActivityRecord> = {}) {
    const ctx = build();
    const record = makeRecord({
      id: 'rec-p',
      subsidiaryId: 'sub-1',
      status: ActivityRecordStatus.submitted,
      submittedAt: SUBMITTED_AT,
      createdBy: 'user-entry',
      ...over,
    });
    ctx.prisma.activityRecord.findUnique.mockResolvedValue(record);
    ctx.prisma.activityRecord.update.mockImplementation(({ data }: any) => ({ ...record, ...data, _count: { evidenceLinks: 1 } }));
    return { ...ctx, record };
  }
  function nothingWritten(prisma: PrismaMock) {
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(prisma.tx.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  }
  async function refusal(promise: Promise<unknown>) {
    return promise.then(() => null, (e: unknown) => e as any);
  }
  it('a role that decides nothing is refused 403 even for a record it cannot read — the role refusal comes first (owner\'s review)', async () => {
    const { service, prisma } = arrange({ subsidiaryId: 'sub-hidden' });
    for (const decide of [
      () => service.approve(auditor({ accessibleSubsidiaryIds: ['sub-1'] }), 'rec-p', SEEN),
      () => service.reject(auditor({ accessibleSubsidiaryIds: ['sub-1'] }), 'rec-p', 'why', SEEN),
      () => service.startReview(auditor({ accessibleSubsidiaryIds: ['sub-1'] }), 'rec-p', SEEN),
    ]) {
      const error = await refusal(decide());
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error).not.toBeInstanceOf(ResourceNotFoundError);
    }
    expect(prisma.activityRecord.findUnique).not.toHaveBeenCalled();
    nothingWritten(prisma);
  });

  function expectNotApprover(error: unknown, approver: string) {
    expect(error).toBeInstanceOf(NotRecordApproverError);
    expect((error as NotRecordApproverError).getStatus()).toBe(403);
    expect(errorCodeOf(error)).toBe('not_record_approver');
    expect((error as NotRecordApproverError).getResponse()).toMatchObject({ params: { approver } });
  }
  /** The one audit row a decision wrote: its actor and its action. */
  function onlyAuditRow() {
    expect(audit.record).toHaveBeenCalledTimes(1);
    const [actor, entry, client] = audit.record.mock.calls[0] as [RequestUser, any, unknown];
    return { actor, entry, client };
  }

  describe('Only a masterkey or a super_admin decides records', () => {
    it.each([
      ['review', (s: ActivityRecordsService, u: RequestUser) => s.startReview(u, 'rec-p'), 'Only a masterkey or a super_admin may review records'],
      ['return', (s: ActivityRecordsService, u: RequestUser) => s.reject(u, 'rec-p', 'Wrong meter', SEEN), 'Only a masterkey or a super_admin may return records'],
      ['approve', (s: ActivityRecordsService, u: RequestUser) => s.approve(u, 'rec-p', SEEN), 'Only a masterkey or a super_admin may approve records'],
    ] as const)('a standard user and an auditor are refused to %s as forbidden, naming both roles, and nothing changes', async (_kind, act, message) => {
      for (const user of [standardUser(), auditor()]) {
        const { prisma, service } = arrange({ createdBy: 'someone-else' });
        const error = await refusal(act(service, user));
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error).not.toBeInstanceOf(NotRecordApproverError);
        expect(error.message).toBe(message);
        nothingWritten(prisma);
        // The role gate is answered before the decision's transaction opens.
        expect(prisma.$transaction).not.toHaveBeenCalled();
      }
    });
  });

  describe("A record's approver follows its author's role", () => {
    it("a standard user's record: approved by a super_admin granted its company, audited as `approve` by a super_admin", async () => {
      const { prisma, service } = arrange();
      const dto = await service.approve(superAdmin(), 'rec-p', SEEN);
      expect(dto.status).toBe(ActivityRecordStatus.approved);
      expect(prisma.tx.activityRecord.update.mock.calls[0][0].data.reviewedBy).toBe('user-super-admin');
      const { actor, entry, client } = onlyAuditRow();
      expect(actor).toMatchObject({ id: 'user-super-admin', role: 'super_admin' });
      expect(entry).toMatchObject({ action: 'approve', entity: 'activity_record', entityId: 'rec-p' });
      expect(client).toBe(prisma.tx);
    });

    it("a super_admin's record: approved by a masterkey, who is its reviewer", async () => {
      const { prisma, service } = arrange({ createdBy: 'user-super-admin' });
      const dto = await service.approve(masterkey(), 'rec-p', SEEN);
      expect(dto.status).toBe(ActivityRecordStatus.approved);
      expect(prisma.tx.activityRecord.update.mock.calls[0][0].data.reviewedBy).toBe('user-admin');
      expect(onlyAuditRow().entry.action).toBe('approve');
    });

    it("another masterkey's record: refused not_record_approver naming the author, the record stays submitted", async () => {
      const { prisma, service } = arrange({ createdBy: 'user-admin-2' });
      expectNotApprover(await refusal(service.approve(masterkey(), 'rec-p', SEEN)), 'author');
      nothingWritten(prisma);
    });

    it('an author since made a super_admin: a masterkey approves it', async () => {
      const { prisma, service } = arrange();
      prisma.people.set('user-entry', { role: 'super_admin', grants: ['sub-1'] });
      expect((await service.approve(masterkey(), 'rec-p', SEEN)).status).toBe(ActivityRecordStatus.approved);
      // …and the company's super_admin no longer may.
      const again = arrange();
      again.prisma.people.set('user-entry', { role: 'super_admin', grants: ['sub-1'] });
      expectNotApprover(await refusal(again.service.approve(superAdmin(), 'rec-p', SEEN)), 'masterkey');
    });

    it('an author since made an auditor: a super_admin granted the company approves it', async () => {
      const { prisma, service } = arrange();
      prisma.people.set('user-entry', { role: 'auditor' });
      expect((await service.approve(superAdmin(), 'rec-p', SEEN)).status).toBe(ActivityRecordStatus.approved);
    });

    it("a masterkey author's account disabled since: a super_admin granted the company approves it, as `approve`", async () => {
      const { prisma, service } = arrange({ createdBy: 'user-admin-2' });
      prisma.people.set('user-admin-2', { role: 'masterkey', disabledAt: new Date('2026-11-25T10:00:00.000Z') });
      expect((await service.approve(superAdmin(), 'rec-p', SEEN)).status).toBe(ActivityRecordStatus.approved);
      expect(onlyAuditRow().entry.action).toBe('approve');
    });
  });

  describe('A company without an active super_admin falls back to the masterkey', () => {
    it.each([
      ['no super_admin is assigned', (p: PrismaMock) => p.people.delete('user-super-admin')],
      ['its only super_admin has not accepted the invitation', (p: PrismaMock) => p.people.set('user-super-admin', { role: 'super_admin', grants: ['sub-1', 'sub-2'], invitation: 'pending' })],
      ['its only super_admin is disabled', (p: PrismaMock) => p.people.set('user-super-admin', { role: 'super_admin', grants: ['sub-1', 'sub-2'], disabledAt: new Date() })],
    ] as const)("%s: a masterkey approves a standard user's record, audited as `approve` by a masterkey", async (_label, unstaff) => {
      const { prisma, service } = arrange();
      unstaff(prisma);
      expect((await service.approve(masterkey(), 'rec-p', SEEN)).status).toBe(ActivityRecordStatus.approved);
      const { actor, entry } = onlyAuditRow();
      expect(actor).toMatchObject({ role: 'masterkey' });
      expect(entry.action).toBe('approve');
    });

    it('is evaluated at the decision: a super_admin appointed since the submit takes the record from the masterkey', async () => {
      const { prisma, service } = arrange();
      prisma.people.delete('user-super-admin');
      expect((await service.get(masterkey(), 'rec-p')).approver).toBe('masterkey');
      // Appointed and accepted before the masterkey decides.
      prisma.people.set('user-new-sa', { role: 'super_admin', grants: ['sub-1'], invitation: 'accepted' });
      expectNotApprover(await refusal(service.approve(masterkey(), 'rec-p', SEEN)), 'super_admin');
      nothingWritten(prisma);
    });
  });

  describe("Only a record's approver approves it", () => {
    it("a masterkey approving a standard user's record in a company with a super_admin: not_record_approver naming super_admin", async () => {
      const { prisma, service } = arrange();
      expectNotApprover(await refusal(service.approve(masterkey(), 'rec-p', SEEN)), 'super_admin');
      nothingWritten(prisma);
    });

    it("a super_admin approving a colleague super_admin's record: not_record_approver naming masterkey", async () => {
      const { prisma, service } = arrange({ createdBy: 'user-super-admin-2' });
      prisma.people.set('user-super-admin-2', { role: 'super_admin', grants: ['sub-1'] });
      expectNotApprover(await refusal(service.approve(superAdmin(), 'rec-p', SEEN)), 'masterkey');
      nothingWritten(prisma);
    });

    it('a super_admin approving in a company they are not granted is answered exactly as a record that does not exist', async () => {
      const outside = arrange({ subsidiaryId: 'sub-3' });
      const foreign = await refusal(outside.service.approve(superAdmin(), 'rec-p', SEEN));
      const missing = arrange();
      missing.prisma.activityRecord.findUnique.mockResolvedValue(null);
      const absent = await refusal(missing.service.approve(superAdmin(), 'rec-p', SEEN));
      expect(foreign).toBeInstanceOf(NotFoundException);
      expect(errorCodeOf(foreign)).toBe(errorCodeOf(absent));
      expect(foreign.getResponse()).toEqual(absent.getResponse());
      nothingWritten(outside.prisma);
    });

    it("a super_admin approving a standard user's record into a locked period hears the period lock", async () => {
      const { prisma, service } = arrange();
      prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
      expect(await refusal(service.approve(superAdmin(), 'rec-p', SEEN))).toBeInstanceOf(PeriodLockedError);
      nothingWritten(prisma);
    });

    it("a masterkey approving a super_admin's record without evidence hears the evidence refusal", async () => {
      const { prisma, service } = arrange({ createdBy: 'user-super-admin' });
      prisma.activityRecordEvidence.count.mockResolvedValue(0);
      expect(await refusal(service.approve(masterkey(), 'rec-p', SEEN))).toBeInstanceOf(ApprovalEvidenceMissingError);
      nothingWritten(prisma);
    });

    it('the approver check comes before the period lock and the evidence: a masterkey who is not the approver hears not_record_approver', async () => {
      const { prisma, service } = arrange();
      prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
      prisma.activityRecordEvidence.count.mockResolvedValue(0);
      expectNotApprover(await refusal(service.approve(masterkey(), 'rec-p', SEEN)), 'super_admin');
      nothingWritten(prisma);
    });
  });

  describe('Nobody but a masterkey approves a record they created', () => {
    it('a super_admin approving their own record: self_approval_forbidden, nothing changes', async () => {
      const { prisma, service } = arrange({ createdBy: 'user-super-admin' });
      const error = await refusal(service.approve(superAdmin(), 'rec-p', SEEN));
      expect(error).toBeInstanceOf(SelfApprovalRefusedError);
      expect(errorCodeOf(error)).toBe('self_approval_forbidden');
      nothingWritten(prisma);
    });

    it('a former standard user, now a super_admin granted the company, approving their own old record: self_approval_forbidden', async () => {
      const { prisma, service } = arrange();
      prisma.people.set('user-entry', { role: 'super_admin', grants: ['sub-1'] });
      expect(await refusal(service.approve(superAdmin({ id: 'user-entry' }), 'rec-p', SEEN))).toBeInstanceOf(SelfApprovalRefusedError);
      nothingWritten(prisma);
    });
  });

  describe("A masterkey's approval of their own record is a self-approval", () => {
    it('approves, the reviewer and the author the same user, with exactly one `self_approve` row by a masterkey', async () => {
      const { prisma, service } = arrange({ createdBy: 'user-admin', status: ActivityRecordStatus.under_review });
      const dto = await service.approve(masterkey(), 'rec-p', SEEN);
      expect(dto.status).toBe(ActivityRecordStatus.approved);
      const write = prisma.tx.activityRecord.update.mock.calls[0][0];
      expect(write.data.reviewedBy).toBe('user-admin');
      expect(dto.createdBy).toBe('user-admin');
      const { actor, entry, client } = onlyAuditRow();
      expect(actor).toMatchObject({ id: 'user-admin', role: 'masterkey' });
      expect(entry.action).toBe('self_approve');
      expect(client).toBe(prisma.tx);
    });

    it("its row carries the same content as an approval's: another masterkey's approval of a super_admin's record writes `approve` with the same diff", async () => {
      const self = arrange({ createdBy: 'user-admin' });
      await self.service.approve(masterkey(), 'rec-p', SEEN);
      const selfRow = onlyAuditRow().entry;
      audit.record.mockClear();

      const other = arrange({ createdBy: 'user-super-admin' });
      await other.service.approve(masterkey(), 'rec-p', SEEN);
      const otherRow = onlyAuditRow().entry;

      expect(selfRow.action).toBe('self_approve');
      expect(otherRow.action).toBe('approve');
      const { action: _a, ...selfRest } = selfRow;
      const { action: _b, ...otherRest } = otherRow;
      expect(selfRest).toEqual(otherRest);
      expect(selfRest.diff).toEqual({ transition: { from: 'submitted', to: 'approved' }, reviewNote: null });
    });

    it('a self-approval without evidence is refused with the evidence refusal, and no audit row is written', async () => {
      const { prisma, service } = arrange({ createdBy: 'user-admin' });
      prisma.activityRecordEvidence.count.mockResolvedValue(0);
      expect(await refusal(service.approve(masterkey(), 'rec-p', SEEN))).toBeInstanceOf(ApprovalEvidenceMissingError);
      nothingWritten(prisma);
    });

    it('a self-approval into a locked period is refused with the lock, and no audit row is written', async () => {
      const { prisma, service } = arrange({ createdBy: 'user-admin' });
      prisma.periodLock.findFirst.mockResolvedValue({ id: 'lock-1' });
      expect(await refusal(service.approve(masterkey(), 'rec-p', SEEN))).toBeInstanceOf(PeriodLockedError);
      nothingWritten(prisma);
    });

    it('a self-approval of a stale figure is refused as calculation_stale, and no audit row is written', async () => {
      const { prisma, service } = arrange({ createdBy: 'user-admin', calculation: { tCo2e: 0.0001, factorId: 'factor-1' } as never });
      expect(await refusal(service.approve(masterkey(), 'rec-p', SEEN))).toBeInstanceOf(CalculationStaleError);
      nothingWritten(prisma);
    });

    it('a former super_admin, now a masterkey, approving their own old record writes `self_approve`', async () => {
      const { prisma, service } = arrange({ createdBy: 'user-promoted' });
      prisma.people.set('user-promoted', { role: 'masterkey' });
      expect((await service.approve(masterkey({ id: 'user-promoted' }), 'rec-p', SEEN)).status).toBe(ActivityRecordStatus.approved);
      expect(onlyAuditRow().entry.action).toBe('self_approve');
    });

    it('a masterkey takes their own record into review and returns it — ordinary `review` and `reject` rows', async () => {
      const reviewed = arrange({ createdBy: 'user-admin' });
      expect((await reviewed.service.startReview(masterkey(), 'rec-p', SEEN)).status).toBe(ActivityRecordStatus.under_review);
      expect(onlyAuditRow().entry.action).toBe('review');
      audit.record.mockClear();
      const returned = arrange({ createdBy: 'user-admin', status: ActivityRecordStatus.under_review });
      expect((await returned.service.reject(masterkey(), 'rec-p', 'Wrong meter', SEEN)).status).toBe(ActivityRecordStatus.rejected);
      expect(onlyAuditRow().entry.action).toBe('reject');
    });
  });

  describe("Taking into review and returning belong to the record's approver", () => {
    it("a super_admin takes a standard user's record into review, as its reviewer", async () => {
      const { prisma, service } = arrange();
      const dto = await service.startReview(superAdmin(), 'rec-p', SEEN);
      expect(dto.status).toBe(ActivityRecordStatus.under_review);
      expect(prisma.tx.activityRecord.update.mock.calls[0][0].data.reviewedBy).toBe('user-super-admin');
    });

    it("a super_admin returns a standard user's record with a comment, naming the submission seen", async () => {
      const { prisma, service } = arrange({ status: ActivityRecordStatus.under_review });
      const dto = await service.reject(superAdmin(), 'rec-p', 'Attach the March invoice', SEEN);
      expect(dto.status).toBe(ActivityRecordStatus.rejected);
      expect(prisma.tx.activityRecord.update.mock.calls[0][0].data.reviewNote).toBe('Attach the March invoice');
    });

    it.each([
      ['takes into review', (s: ActivityRecordsService) => s.startReview(masterkey(), 'rec-p', SEEN)],
      ['returns', (s: ActivityRecordsService) => s.reject(masterkey(), 'rec-p', 'Wrong meter', SEEN)],
    ] as const)("a masterkey who %s a standard user's record in a company with a super_admin: not_record_approver naming super_admin", async (_label, act) => {
      const { prisma, service } = arrange();
      expectNotApprover(await refusal(act(service)), 'super_admin');
      nothingWritten(prisma);
    });

    it("a masterkey returning another masterkey's record: not_record_approver naming the author", async () => {
      const { prisma, service } = arrange({ createdBy: 'user-admin-2' });
      expectNotApprover(await refusal(service.reject(masterkey(), 'rec-p', 'Wrong meter', SEEN)), 'author');
      nothingWritten(prisma);
    });

    it('a super_admin taking their own record into review: self_review_forbidden, no reviewer, no audit row', async () => {
      const { prisma, service } = arrange({ createdBy: 'user-super-admin' });
      const error = await refusal(service.startReview(superAdmin(), 'rec-p', SEEN));
      expect(error).toBeInstanceOf(SelfReviewRefusedError);
      expect(errorCodeOf(error)).toBe('self_review_forbidden');
      nothingWritten(prisma);
    });

    it('a super_admin returning their own record: not_record_approver naming masterkey — and the author can still recall it', async () => {
      const { prisma, service } = arrange({ createdBy: 'user-super-admin' });
      expectNotApprover(await refusal(service.reject(superAdmin(), 'rec-p', 'Mine', SEEN)), 'masterkey');
      nothingWritten(prisma);
      expect((await service.recall(superAdmin(), 'rec-p')).status).toBe(ActivityRecordStatus.draft);
      expect(onlyAuditRow().entry.action).toBe('recall');
    });

    it('a decision started by a super_admin who then lost the grant: another super_admin granted the company approves it', async () => {
      const { prisma, service } = arrange({ status: ActivityRecordStatus.under_review, reviewedBy: 'user-super-admin' });
      prisma.people.set('user-super-admin', { role: 'super_admin', grants: ['sub-2'] });
      prisma.people.set('user-super-admin-2', { role: 'super_admin', grants: ['sub-1'] });
      // The first, still holding a token that names sub-1, is answered as for
      // an unknown record by the decision's own re-read.
      expect(await refusal(service.approve(superAdmin(), 'rec-p', SEEN))).toBeInstanceOf(ResourceNotFoundError);
      nothingWritten(prisma);
      const dto = await service.approve(superAdmin({ id: 'user-super-admin-2' }), 'rec-p', SEEN);
      expect(dto.status).toBe(ActivityRecordStatus.approved);
      expect(prisma.tx.activityRecord.update.mock.calls[0][0].data.reviewedBy).toBe('user-super-admin-2');
    });
  });

  describe('the refusal order, pairwise', () => {
    const STALE = '2026-11-25T08:00:00.000Z';

    it('the role gate before record_changed: a standard user or an auditor with a stale or missing submission hears forbidden', async () => {
      for (const seen of [STALE, SUBMISSION_NOT_NAMED] as const) {
        for (const user of [standardUser(), auditor()]) {
          const { prisma, service } = arrange();
          const error = await refusal(service.approve(user, 'rec-p', seen));
          expect(error).toBeInstanceOf(ForbiddenException);
          expect(errorCodeOf(error)).not.toBe('record_changed');
          const returned = await refusal(service.reject(user, 'rec-p', 'x', seen));
          expect(returned).toBeInstanceOf(ForbiddenException);
          expect(errorCodeOf(returned)).not.toBe('record_changed');
          nothingWritten(prisma);
        }
      }
    });

    it('record_changed before self_approval_forbidden and self_review_forbidden: a super_admin acting on their own resubmitted record', async () => {
      const { prisma, service } = arrange({ createdBy: 'user-super-admin' });
      expect(await refusal(service.approve(superAdmin(), 'rec-p', STALE))).toBeInstanceOf(RecordChangedError);
      expect(await refusal(service.startReview(superAdmin(), 'rec-p', STALE))).toBeInstanceOf(RecordChangedError);
      nothingWritten(prisma);
    });

    it('record_changed before not_record_approver: a masterkey who is not the approver, naming a submission the record no longer has', async () => {
      const { prisma, service } = arrange();
      expect(await refusal(service.approve(masterkey(), 'rec-p', STALE))).toBeInstanceOf(RecordChangedError);
      expect(await refusal(service.reject(masterkey(), 'rec-p', 'x', STALE))).toBeInstanceOf(RecordChangedError);
      expect(await refusal(service.startReview(masterkey(), 'rec-p', STALE))).toBeInstanceOf(RecordChangedError);
      nothingWritten(prisma);
    });

    it('a wrong status before the approver check too (the re-gate)', async () => {
      const { prisma, service } = arrange({ status: ActivityRecordStatus.approved });
      expect(await refusal(service.approve(masterkey(), 'rec-p', SEEN))).toBeInstanceOf(BadRequestException);
      nothingWritten(prisma);
    });

    it('self_* before not_record_approver: a super_admin\'s own record, which a masterkey decides, answers self_approval_forbidden and self_review_forbidden', async () => {
      const { prisma, service } = arrange({ createdBy: 'user-super-admin' });
      const approve = await refusal(service.approve(superAdmin(), 'rec-p', SEEN));
      expect(approve).toBeInstanceOf(SelfApprovalRefusedError);
      expect(approve).not.toBeInstanceOf(NotRecordApproverError);
      const review = await refusal(service.startReview(superAdmin(), 'rec-p', SEEN));
      expect(review).toBeInstanceOf(SelfReviewRefusedError);
      expect(review).not.toBeInstanceOf(NotRecordApproverError);
      nothingWritten(prisma);
    });
  });

  describe('A pending record states who decides it', () => {
    it.each([
      ["a standard user's record in a company with an active super_admin", {}, () => undefined, 'super_admin'],
      ["a standard user's record in a company without one (the fallback)", {}, (p: PrismaMock) => p.people.delete('user-super-admin'), 'masterkey'],
      ["a super_admin's record", { createdBy: 'user-super-admin' }, () => undefined, 'masterkey'],
      ["a masterkey's record", { createdBy: 'user-admin' }, () => undefined, 'author'],
    ] as const)('%s states %s, submitted or under review', async (_label, over, setup, approver) => {
      for (const status of [ActivityRecordStatus.submitted, ActivityRecordStatus.under_review]) {
        const { prisma, service } = arrange({ ...over, status });
        setup(prisma);
        expect((await service.get(auditor(), 'rec-p')).approver).toBe(approver);
      }
    });

    it.each([
      ActivityRecordStatus.draft,
      ActivityRecordStatus.rejected,
      ActivityRecordStatus.approved,
      ActivityRecordStatus.locked,
      ActivityRecordStatus.voided,
    ])('a %s record states none, and asks nothing about approvers', async (status) => {
      const { prisma, service } = arrange({ status });
      expect((await service.get(auditor(), 'rec-p')).approver).toBeNull();
      expect(prisma.userSubsidiaryAccess.findMany).not.toHaveBeenCalled();
    });

    it("a decision's answer states the approver of the record it left: under review keeps one, approved none", async () => {
      const reviewed = arrange();
      expect((await reviewed.service.startReview(superAdmin(), 'rec-p', SEEN)).approver).toBe('super_admin');
      const approved = arrange();
      expect((await approved.service.approve(superAdmin(), 'rec-p', SEEN)).approver).toBeNull();
    });

    it('a list page of 50 pending records asks two approver queries — the same as a page of 5', async () => {
      const authors = ['user-entry', 'user-super-admin', 'user-admin', 'user-admin-2', 'user-gone'];
      const page = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          ...makeRecord({
            id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            subsidiaryId: i % 2 ? 'sub-1' : 'sub-2',
            status: i % 3 ? ActivityRecordStatus.submitted : ActivityRecordStatus.under_review,
            createdBy: authors[i % authors.length],
          }),
          _count: { evidenceLinks: 1 },
        }));
      const approverQueries = (prisma: PrismaMock) => ({
        authors: prisma.profile.findMany.mock.calls.filter(([args]: any) => args?.select?.role).length,
        companies: prisma.userSubsidiaryAccess.findMany.mock.calls.length,
      });

      const big = build();
      big.prisma.activityRecord.findMany.mockResolvedValueOnce(page(50));
      const items = (await big.service.listPage(masterkey(), { limit: 50 })).items;
      expect(items).toHaveLength(50);
      expect(new Set(items.map((r) => r.approver))).toEqual(new Set(['super_admin', 'masterkey', 'author']));
      expect(approverQueries(big.prisma)).toEqual({ authors: 1, companies: 1 });

      const small = build();
      small.prisma.activityRecord.findMany.mockResolvedValueOnce(page(5));
      await small.service.listPage(masterkey(), { limit: 50 });
      expect(approverQueries(small.prisma)).toEqual(approverQueries(big.prisma));
    });
  });

  describe('The review queue: "awaiting my decision" is a filter the database applies', () => {
    it('a super_admin\'s page ANDs the awaiting-decision where onto its scoped where', async () => {
      const { prisma, service } = build();
      await service.listPage(superAdmin(), { awaitingMyDecision: true });
      const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
      const expected = await awaitingDecisionWhere(prisma as never, superAdmin());
      expect(where.AND).toHaveLength(2);
      expect(where.AND[0]).toMatchObject({ subsidiaryId: { in: ['sub-1', 'sub-2'] } });
      expect(where.AND[1]).toEqual(expected);
      // The default people: the masterkeys and the super_admin route elsewhere.
      expect(where.AND[1]).toEqual({
        status: { in: ['submitted', 'under_review'] },
        AND: [
          { createdBy: { notIn: ['user-admin', 'user-admin-2', 'user-super-admin'] } },
          { subsidiaryId: { in: ['sub-1', 'sub-2'] } },
        ],
      });
    });

    it('a masterkey\'s page names its own records, the active super_admins\' and the unstaffed companies\' records', async () => {
      const { prisma, service } = build();
      await service.listPage(masterkey(), { awaitingMyDecision: true });
      const mine = prisma.activityRecord.findMany.mock.calls[0][0].where.AND[1];
      expect(mine).toEqual({
        status: { in: ['submitted', 'under_review'] },
        OR: [
          { createdBy: 'user-admin' },
          { createdBy: { in: ['user-super-admin'] } },
          {
            AND: [
              { createdBy: { notIn: ['user-admin', 'user-admin-2', 'user-super-admin'] } },
              { subsidiaryId: { notIn: ['sub-1', 'sub-2'] } },
            ],
          },
        ],
      });
    });

    it('metadata counts the same filtered set', async () => {
      const { prisma, service } = build();
      prisma.activityRecord.count.mockResolvedValueOnce(3);
      prisma.activityRecord.aggregate.mockResolvedValueOnce({ _max: { reportingYear: 2026 } });
      await service.metadata(superAdmin(), { awaitingMyDecision: true });
      expect(prisma.activityRecord.count.mock.calls[0][0].where.AND[1]).toEqual(await awaitingDecisionWhere(prisma as never, superAdmin()));
    });

    it.each([
      ['a standard user', standardUser()],
      ['an auditor', auditor()],
    ] as const)('%s, who decides nothing, gets an empty page and count without a records query', async (_label, user) => {
      const { prisma, service } = build();
      expect(await service.listPage(user, { awaitingMyDecision: true })).toEqual({ items: [], limit: DEFAULT_PAGE_LIMIT, nextCursor: null });
      expect(await service.metadata(user, { awaitingMyDecision: true })).toEqual({ total: 0, latestReportingYear: null });
      expect(prisma.activityRecord.findMany).not.toHaveBeenCalled();
      expect(prisma.activityRecord.count).not.toHaveBeenCalled();
    });

    it('without the filter the page is the scoped list, with no approver where', async () => {
      const { prisma, service } = build();
      await service.listPage(superAdmin(), {});
      const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
      expect(JSON.stringify(where)).not.toContain('notIn');
    });
  });

  describe('Void stays with the masterkey', () => {
    it('a super_admin voiding an approved record of their company is refused as forbidden; the record stays approved', async () => {
      const { prisma, service } = arrange({ status: ActivityRecordStatus.approved, createdBy: 'user-entry', reviewedBy: 'user-super-admin' });
      const error = await refusal(service.void(superAdmin(), 'rec-p', 'A reason long enough to pass'));
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.message).toBe('Only a masterkey may void records');
      nothingWritten(prisma);
    });

    it('a masterkey voids a record they approved themselves, with an ordinary `void` row', async () => {
      const { prisma, service } = arrange({ status: ActivityRecordStatus.approved, createdBy: 'user-admin', reviewedBy: 'user-admin' });
      expect((await service.void(masterkey(), 'rec-p', 'Duplicate of the site invoice')).status).toBe(ActivityRecordStatus.voided);
      expect(onlyAuditRow().entry.action).toBe('void');
      expect(prisma.tx.activityRecord.update.mock.calls[0][0].data.voidedBy).toBe('user-admin');
    });
  });

  describe('Deleting a draft stays open to its author and the masterkey', () => {
    it("a super_admin deleting a standard user's draft is refused record_author_forbidden; the draft is unchanged", async () => {
      const { prisma, service } = arrange({ status: ActivityRecordStatus.draft, submittedAt: null });
      const error = await refusal(service.remove(superAdmin(), 'rec-p'));
      expect(error).toBeInstanceOf(AuthorOnlyRefusedError);
      expect(errorCodeOf(error)).toBe('record_author_forbidden');
      expect(prisma.tx.activityRecord.delete).not.toHaveBeenCalled();
      nothingWritten(prisma);
    });

    it("a masterkey deletes a standard user's draft and a returned record, each audited", async () => {
      for (const status of [ActivityRecordStatus.draft, ActivityRecordStatus.rejected]) {
        audit.record.mockClear();
        const { prisma, service } = arrange({ status });
        await service.remove(masterkey(), 'rec-p');
        expect(prisma.tx.activityRecord.delete).toHaveBeenCalledWith({ where: { id: 'rec-p' } });
        expect(onlyAuditRow().entry).toMatchObject({ action: 'delete', entityId: 'rec-p' });
      }
    });

    it('a super_admin deletes their own draft', async () => {
      const { prisma, service } = arrange({ status: ActivityRecordStatus.draft, createdBy: 'user-super-admin' });
      await service.remove(superAdmin(), 'rec-p');
      expect(prisma.tx.activityRecord.delete).toHaveBeenCalledWith({ where: { id: 'rec-p' } });
    });
  });
});

describe("ActivityRecordsService — a standard user's categories (inc26-roles-approval-chain, INC-2.6 §1, §7.3)", () => {
  /** Granted company A (`sub-1`) with Electricity, company B (`sub-2`) with Fuel. */
  const narrow = (over: Partial<RequestUser> = {}) =>
    standardUser({
      accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
      categoryGrants: { 'sub-1': ['Electricity'], 'sub-2': ['Fuel'] },
      ...over,
    });
  /** Electricity unticked on A since the record was made. */
  const withdrawn = () => narrow({ categoryGrants: { 'sub-1': ['Water'], 'sub-2': ['Fuel'] } });

  function expectCategoryRefusal(error: unknown, category: string) {
    expect(error).toBeInstanceOf(CategoryNotGrantedError);
    expect((error as CategoryNotGrantedError).getStatus()).toBe(403);
    expect(errorCodeOf(error)).toBe('category_not_granted');
    expect((error as CategoryNotGrantedError).getResponse()).toMatchObject({ params: { category } });
  }
  function arrangeCreate(prisma: PrismaMock) {
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1', geographyCode: 'TR' }));
    prisma.activityRecord.create.mockImplementation(({ data }: any) => makeRecord({ ...data, id: 'rec-new' }));
  }
  function arrangeRecord(prisma: PrismaMock, over: Partial<ActivityRecord> = {}) {
    const record = makeRecord({ id: 'rec-own', subsidiaryId: 'sub-1', category: 'Electricity', createdBy: 'user-entry', ...over });
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.activityRecord.findUnique.mockResolvedValue(record);
    prisma.activityRecord.update.mockImplementation(({ data }: any) => ({ ...record, ...data, _count: { evidenceLinks: 1 } }));
    return record;
  }
  const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  describe('A standard user authors only in granted categories', () => {
    it('creates in a granted category', async () => {
      const { prisma, service } = build();
      arrangeCreate(prisma);
      expect((await service.create(narrow(), CREATE_DTO)).status).toBe(ActivityRecordStatus.draft);
      expect(prisma.tx.activityRecord.create).toHaveBeenCalledTimes(1);
    });

    it('refuses another category with category_not_granted naming it, before any query, and creates nothing', async () => {
      const { prisma, calc, service } = build();
      arrangeCreate(prisma);
      const error = await caught(service.create(narrow(), { ...CREATE_DTO, category: 'Fuel', activityType: 'diesel' } as never));
      expectCategoryRefusal(error, 'Fuel');
      expect(prisma.periodLock.findFirst).not.toHaveBeenCalled();
      expect(calc.compute).not.toHaveBeenCalled();
      expect(prisma.activityRecord.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('a category differs by company: Fuel is granted on B, not on A', async () => {
      const { prisma, service } = build();
      arrangeCreate(prisma);
      expectCategoryRefusal(await caught(service.create(narrow(), { ...CREATE_DTO, subsidiaryId: 'sub-1', category: 'Fuel' } as never)), 'Fuel');
      // …and Electricity, ticked on A, is not ticked on B.
      expectCategoryRefusal(await caught(service.create(narrow(), { ...CREATE_DTO, subsidiaryId: 'sub-2' })), 'Electricity');
      expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    });

    it('the read-only preview is refused the same way (the bulk upload\'s dry run)', async () => {
      const { prisma, service } = build();
      expectCategoryRefusal(await caught(service.previewCreate(narrow(), { ...CREATE_DTO, category: 'Water' } as never)), 'Water');
      expect(prisma.periodLock.findFirst).not.toHaveBeenCalled();
    });

    it('re-filing a draft under an ungranted category is refused; the draft keeps its category', async () => {
      const { prisma, service } = build();
      arrangeRecord(prisma, { status: ActivityRecordStatus.draft });
      expectCategoryRefusal(await caught(service.update(narrow(), 'rec-own', { category: 'Water', activityUnit: 'cubic_metres' } as never)), 'Water');
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('an edit that keeps the granted category goes ahead', async () => {
      const { prisma, service } = build();
      arrangeRecord(prisma, { status: ActivityRecordStatus.draft });
      expect((await service.update(narrow(), 'rec-own', { activityValue: 100 })).id).toBe('rec-own');
    });

    it('an edit of a draft whose category was since withdrawn is refused: checked on the category after the edit', async () => {
      const { prisma, service } = build();
      arrangeRecord(prisma, { status: ActivityRecordStatus.draft });
      expectCategoryRefusal(await caught(service.update(withdrawn(), 'rec-own', { activityValue: 100 })), 'Electricity');
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    });

    it('submitting after the category was withdrawn is refused; the record stays a draft', async () => {
      const { prisma, service } = build();
      arrangeRecord(prisma, { status: ActivityRecordStatus.draft });
      expectCategoryRefusal(await caught(service.submit(withdrawn(), 'rec-own')), 'Electricity');
      expect(prisma.activityRecord.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('the submit gate comes after the author check: a colleague\'s draft answers record_author_forbidden-style, not the category', async () => {
      const { prisma, service } = build();
      arrangeRecord(prisma, { status: ActivityRecordStatus.draft, createdBy: 'someone-else' });
      // A colleague's Electricity draft in A is in scope (Electricity is ticked).
      expect(await caught(service.submit(narrow(), 'rec-own'))).toBeInstanceOf(SubmitAuthorRefusedError);
    });

    it.each([
      ['a super_admin', superAdmin()],
      ['a masterkey', masterkey()],
    ] as const)('%s is never refused by category: creates in a category no grant ticks', async (_label, user) => {
      const { prisma, service } = build();
      arrangeCreate(prisma);
      expect((await service.create(user, CREATE_DTO)).status).toBe(ActivityRecordStatus.draft);
      // Even holding a grant that names other categories.
      expect((await service.create({ ...user, categoryGrants: { 'sub-1': ['Water'] } }, CREATE_DTO)).status).toBe(ActivityRecordStatus.draft);
    });

    it.each([
      ['a super_admin', superAdmin()],
      ['a masterkey', masterkey()],
    ] as const)('%s edits and submits its own record whatever its grants say', async (_label, user) => {
      const { prisma, service } = build();
      arrangeRecord(prisma, { status: ActivityRecordStatus.draft, createdBy: user.id });
      const narrowed = { ...user, categoryGrants: { 'sub-1': ['Water' as const] } };
      expect((await service.update(narrowed, 'rec-own', { activityValue: 100 })).id).toBe('rec-own');
      expect((await service.submit(narrowed, 'rec-own')).status).toBe(ActivityRecordStatus.submitted);
    });

    it('a hand-built standard user with no categoryGrants authors nothing (fail closed)', async () => {
      const { prisma, service } = build();
      arrangeCreate(prisma);
      expectCategoryRefusal(await caught(service.create(standardUser({ categoryGrants: undefined }), CREATE_DTO)), 'Electricity');
    });
  });

  describe("A withdrawn category leaves the author's own records reachable", () => {
    it('the author reads and recalls its submitted record after Electricity was unticked', async () => {
      const { prisma, service } = build();
      arrangeRecord(prisma, { status: ActivityRecordStatus.submitted });
      expect((await service.get(withdrawn(), 'rec-own')).id).toBe('rec-own');
      expect((await service.recall(withdrawn(), 'rec-own')).status).toBe(ActivityRecordStatus.draft);
    });

    it('the author deletes its draft after the withdrawal', async () => {
      const { prisma, service } = build();
      arrangeRecord(prisma, { status: ActivityRecordStatus.draft });
      await service.remove(withdrawn(), 'rec-own');
      expect(prisma.tx.activityRecord.delete).toHaveBeenCalledWith({ where: { id: 'rec-own' } });
    });

    it("a colleague's record of the withdrawn category is no longer shown: a read answers not found", async () => {
      const { prisma, service } = build();
      arrangeRecord(prisma, { createdBy: 'someone-else' });
      expect((await service.get(narrow(), 'rec-own')).id).toBe('rec-own');
      expect(await caught(service.get(withdrawn(), 'rec-own'))).toBeInstanceOf(NotFoundException);
    });

    it('the records list keeps the author\'s own records of A and drops the category branch for A', async () => {
      const { prisma, service } = build();
      await service.listPage(withdrawn(), {});
      const where = prisma.activityRecord.findMany.mock.calls[0][0].where;
      expect(where.AND).toEqual([
        {
          OR: [
            { subsidiaryId: 'sub-1', category: { in: ['Water'] } },
            { subsidiaryId: 'sub-2', category: { in: ['Fuel'] } },
            { subsidiaryId: { in: ['sub-1', 'sub-2'] }, createdBy: 'user-entry' },
          ],
        },
      ]);
    });

    it('a submitted record stays in review and its approver can still decide it', async () => {
      const { prisma, service } = build();
      arrangeRecord(prisma, { status: ActivityRecordStatus.submitted });
      // The author's grants never enter the approver's decision.
      prisma.people.set('user-entry', { role: 'standard_user', grants: ['sub-1'] });
      expect((await service.approve(superAdmin(), 'rec-own')).status).toBe(ActivityRecordStatus.approved);
    });
  });
});

describe('ActivityRecordsService — a node closed to data entry (inc26-group-tree, D6)', () => {
  let prisma: PrismaMock;
  let service: ActivityRecordsService;

  beforeEach(() => {
    audit.record.mockClear();
    ({ prisma, service } = build());
  });

  it.each([
    ['an associate', { nodeType: 'company', control: 'associate' }],
    ['an associate child company', { nodeType: 'child_company', control: 'associate' }],
    ['a sector group', { nodeType: 'sector_group', control: 'controlled' }],
  ] as const)('refuses a record for %s — in the preview and the create — as a conflict, writing nothing', async (_what, node) => {
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1', ...node }));
    for (const user of [masterkey(), standardUser()]) {
      for (const call of [() => service.previewCreate(user, CREATE_DTO), () => service.create(user, CREATE_DTO)]) {
        const e = await call().catch((err: unknown) => err);
        expect(e).toBeInstanceOf(EntityClosedToDataEntryError);
        expect(e).toMatchObject({ response: { code: 'entity_closed_to_data_entry', statusCode: 409 } });
      }
    }
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(prisma.tx.activityRecord.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    // The gate reads only the company's type and control.
    expect(prisma.subsidiary.findUnique).toHaveBeenCalledWith({ where: { id: 'sub-1' }, select: { nodeType: true, control: true } });
  });

  it('lets an ordinary controlled company, and the holding, through', async () => {
    for (const nodeType of ['company', 'holding', 'child_company', 'sub_holding'] as const) {
      prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1', nodeType, control: 'controlled' }));
      await expect(service.previewCreate(masterkey(), CREATE_DTO)).resolves.toMatchObject({ subsidiaryId: 'sub-1' });
    }
  });

  it('answers a company outside the caller\'s set as unknown, before the gate reads it', async () => {
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-9', control: 'associate' }));
    await expect(service.previewCreate(standardUser(), { ...CREATE_DTO, subsidiaryId: 'sub-9' })).rejects.toMatchObject({
      response: { code: 'subsidiary_not_found' },
    });
    expect(prisma.subsidiary.findUnique).not.toHaveBeenCalled();
  });

  it('answers TA019 reached through a race (a tick between the check and the insert) with the same code', async () => {
    prisma.subsidiary.findUnique.mockResolvedValue(makeSubsidiary({ id: 'sub-1' }));
    prisma.tx.activityRecord.create.mockRejectedValue(
      new Prisma.PrismaClientUnknownRequestError(
        'Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "TA019", message: "entity_closed_to_data_entry: subsidiary sub-1 is outside the Scope 1 and 2 inventory", severity: "ERROR", detail: None, column: None, hint: None }) })',
        { clientVersion: '6' },
      ),
    );
    await expect(service.create(masterkey(), CREATE_DTO)).rejects.toBeInstanceOf(EntityClosedToDataEntryError);
  });
});

// ---------------------------------------------------------------------------
// inc26-central-reporter-onboarding (tasks 4.1, 4.3, 4.4): a record's owning
// and reporting entity, the access re-read inside the write, and the period
// half of single entry.
// ---------------------------------------------------------------------------

/** A central reporter: main company sub-2, a grant for sub-1 (Electricity). */
function centralReporter(): RequestUser {
  return standardUser({
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    categoryGrants: { 'sub-1': ['Electricity'], 'sub-2': ['Water'] },
    grantKinds: { 'sub-1': 'central_reporter', 'sub-2': 'assigned' },
  });
}

/** Routes the raw reads: the access re-read FOR SHARE, and the period rule's look. */
function routeRaw(prisma: PrismaMock, opts: { access?: { subsidiaryId: string; kind: string; categories: string[] }[]; otherParty?: boolean; duplicate?: boolean | 'slot_kind'; duplicateReads?: { exact: boolean }[][]; accessReads?: { subsidiaryId: string; kind: string; categories: string[] }[][] }) {
  let read = 0;
  const route = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const sql = strings.join('?');
    if (sql.includes('FOR KEY SHARE')) return [];
    if (sql.includes('r.activity_type IS NOT DISTINCT FROM')) return opts.duplicate ? [{ exact: opts.duplicate !== 'slot_kind' }] : opts.duplicateReads ? opts.duplicateReads.shift() ?? [] : [];
    if (sql.includes('FROM user_subsidiary_access') && opts.accessReads) return opts.accessReads[Math.min(read++, opts.accessReads.length - 1)]!;
    if (sql.includes('FROM user_subsidiary_access')) return opts.access ?? [];
    if (sql.includes('LEFT JOIN profiles p ON p.id = r.created_by')) return opts.otherParty ? [{ found: 1 }] : [];
    return [{ id: 'locked' }];
  };
  prisma.$queryRaw.mockImplementation(route as never);
}
const rawSql = (prisma: PrismaMock) => prisma.$queryRaw.mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
const REPORTER_ACCESS = [
  { subsidiaryId: 'sub-1', kind: 'central_reporter', categories: ['Electricity'] },
  { subsidiaryId: 'sub-2', kind: 'assigned', categories: ['Water'] },
];

describe('central reporting — the reporting entity on the create path (task 4.1)', () => {
  it.each([
    ['a central reporter, for a grant company: its main company', centralReporter(), 'sub-2'],
    ['the same reporter, for its main company: the company itself', centralReporter(), 'sub-1x'],
    ['a standard user for its one company', standardUser(), 'sub-1'],
    ['a super_admin', superAdmin(), 'sub-1'],
    ['a masterkey (no grants)', masterkey(), 'sub-1'],
    ['a carried-over account with two assigned companies', standardUser({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'] }), 'sub-1'],
  ] as const)('previewCreate answers %s, with no locking read and no write', async (_case, user, expected) => {
    const { prisma, service } = build();
    const dto = expected === 'sub-1x' ? { ...CREATE_DTO, subsidiaryId: 'sub-2', category: 'Water' as const, activityUnit: 'm3' } : CREATE_DTO;
    const preview = await service.previewCreate(user, dto);
    expect(preview.reportedBySubsidiaryId).toBe(expected === 'sub-1x' ? 'sub-2' : expected);
    expect(rawSql(prisma).some((q) => q.includes('FOR SHARE'))).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("create re-reads a standard user's access FOR SHARE inside its transaction, and never writes the column itself", async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { access: REPORTER_ACCESS });
    prisma.activityRecord.create.mockImplementation(({ data }: any) => makeRecord({ ...data, id: 'rec-new', reportedBySubsidiaryId: 'sub-2' }));
    prisma.subsidiary.findMany.mockResolvedValue([{ id: 'sub-2', tradingName: 'TonyAI Energy', legalName: 'TonyAI Energy A.Ş.' }]);
    const dto = await service.create(centralReporter(), CREATE_DTO);
    expect(rawSql(prisma).find((q) => q.includes('kind, categories'))).toMatch(/FOR SHARE/);
    expect(prisma.activityRecord.create.mock.calls[0][0].data).not.toHaveProperty('reportedBySubsidiaryId');
    expect(dto).toMatchObject({ subsidiaryId: 'sub-1', reportedBySubsidiaryId: 'sub-2', reportedBySubsidiaryName: 'TonyAI Energy' });
  });

  it.each([['a super_admin', superAdmin()], ['a masterkey', masterkey()]] as const)('create takes no access lock for %s', async (_role, user) => {
    const { prisma, service } = build();
    prisma.activityRecord.create.mockImplementation(({ data }: any) => makeRecord({ ...data, id: 'rec-new' }));
    await service.create(user, CREATE_DTO);
    expect(rawSql(prisma).some((q) => q.includes('FROM user_subsidiary_access'))).toBe(false);
  });

  it('a grant withdrawn before the write: refused as an unknown company, nothing written', async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { access: [REPORTER_ACCESS[1]!] });
    await expect(service.create(centralReporter(), CREATE_DTO)).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a category taken out of the grant before the write: category_not_granted, nothing written', async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { access: [{ ...REPORTER_ACCESS[0]!, categories: ['Fuel'] }, REPORTER_ACCESS[1]!] });
    await expect(service.create(centralReporter(), CREATE_DTO)).rejects.toMatchObject({ response: { code: 'category_not_granted' } });
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it('update, submit, recall and the decisions never write the column', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', status: ActivityRecordStatus.submitted, createdBy: 'user-entry', reportedBySubsidiaryId: 'sub-2' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) => makeRecord({ id: 'rec-a', status: data.status, reportedBySubsidiaryId: 'sub-2' }));
    await service.approve(superAdmin(), 'rec-a');
    for (const [arg] of prisma.activityRecord.update.mock.calls) expect((arg as { data: object }).data).not.toHaveProperty('reportedBySubsidiaryId');
  });
});

describe('central reporting — every answer states both entities (task 4.3)', () => {
  it('an older record (empty column) answers its own company, by name', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({ id: 'rec-old', subsidiaryId: 'sub-1' }));
    prisma.subsidiary.findMany.mockResolvedValue([{ id: 'sub-1', tradingName: null, legalName: 'Legal One' }]);
    expect(await service.get(standardUser(), 'rec-old')).toMatchObject({ reportedBySubsidiaryId: 'sub-1', reportedBySubsidiaryName: 'Legal One' });
  });

  it("names a reporting company the reader is not granted: looked up in the reader's organisation, not its scope", async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-r', subsidiaryId: 'sub-1', status: ActivityRecordStatus.submitted, createdBy: 'user-entry', reportedBySubsidiaryId: 'sub-9' }),
    );
    prisma.subsidiary.findMany.mockResolvedValue([{ id: 'sub-9', tradingName: 'Supply Co', legalName: 'Supply Co A.Ş.' }]);
    const dto = await service.get(superAdmin({ accessibleSubsidiaryIds: ['sub-1'] }), 'rec-r');
    expect(dto).toMatchObject({ subsidiaryId: 'sub-1', reportedBySubsidiaryId: 'sub-9', reportedBySubsidiaryName: 'Supply Co' });
    expect(prisma.subsidiary.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['sub-9'] }, organisationId: 'org-1' },
      select: { id: true, tradingName: true, legalName: true },
    });
  });

  it('a page resolves its reporting entities in one query', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findMany.mockResolvedValue([
      { ...makeRecord({ subsidiaryId: 'sub-1' }), _count: { evidenceLinks: 0 }, location: null },
      { ...makeRecord({ subsidiaryId: 'sub-1', reportedBySubsidiaryId: 'sub-9' }), _count: { evidenceLinks: 0 }, location: null },
      { ...makeRecord({ subsidiaryId: 'sub-2' }), _count: { evidenceLinks: 0 }, location: null },
    ]);
    prisma.subsidiary.findMany.mockResolvedValue([
      { id: 'sub-1', tradingName: 'One', legalName: 'One Ltd' }, { id: 'sub-2', tradingName: 'Two', legalName: 'Two Ltd' },
      { id: 'sub-9', tradingName: 'Nine', legalName: 'Nine Ltd' },
    ]);
    const page = await service.listPage(masterkey(), {});
    expect(page.items.map((r) => [r.reportedBySubsidiaryId, r.reportedBySubsidiaryName])).toEqual([['sub-1', 'One'], ['sub-9', 'Nine'], ['sub-2', 'Two']]);
    expect(prisma.subsidiary.findMany).toHaveBeenCalledTimes(1);
  });

  it.each(['approve', 'recall'] as const)('the %s answer carries the same two entities as the create did', async (step) => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(
      makeRecord({ id: 'rec-a', subsidiaryId: 'sub-1', status: ActivityRecordStatus.submitted, createdBy: 'user-entry', reportedBySubsidiaryId: 'sub-2' }),
    );
    prisma.activityRecord.update.mockImplementation(({ data }: any) =>
      makeRecord({ id: 'rec-a', subsidiaryId: 'sub-1', status: data.status, reportedBySubsidiaryId: 'sub-2' }));
    prisma.subsidiary.findMany.mockResolvedValue([{ id: 'sub-2', tradingName: 'Main', legalName: 'Main Ltd' }]);
    const dto = step === 'approve' ? await service.approve(superAdmin(), 'rec-a') : await service.recall(centralReporter(), 'rec-a');
    expect(dto).toMatchObject({ subsidiaryId: 'sub-1', reportedBySubsidiaryId: 'sub-2', reportedBySubsidiaryName: 'Main' });
  });
});

describe('central reporting — one party enters a category for a company in a period (task 4.4)', () => {
  it("previewCreate refuses a reporter where the company's own user holds the period: its side and values, no write, no audit", async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { otherParty: true });
    const refusal = await service.previewCreate(centralReporter(), CREATE_DTO).catch((e) => e);
    expect(refusal.response).toMatchObject({
      code: 'single_entry_period_conflict',
      params: { side: 'company_users', category: 'Electricity', year: 2024, period: 'Annual' },
    });
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("create refuses the company's own user where a central reporter holds the period", async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { otherParty: true, access: [{ subsidiaryId: 'sub-1', kind: 'assigned', categories: [...CATEGORIES] }] });
    await expect(service.create(standardUser(), CREATE_DTO)).rejects.toMatchObject({
      response: { code: 'single_entry_period_conflict', params: { side: 'central_reporter' } },
    });
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("a super_admin's and a masterkey's record is no party's: the rule is not asked", async () => {
    for (const user of [superAdmin(), masterkey()]) {
      const { prisma, service } = build();
      routeRaw(prisma, { otherParty: true });
      prisma.activityRecord.create.mockImplementation(({ data }: any) => makeRecord({ ...data, id: 'rec-new' }));
      await service.create(user, CREATE_DTO);
      expect(rawSql(prisma).some((q) => q.includes('LEFT JOIN profiles'))).toBe(false);
    }
  });

  it("the database refusing a raced record (TA026) answers the same code with the request's values", async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { access: REPORTER_ACCESS });
    prisma.activityRecord.create.mockRejectedValue(new Prisma.PrismaClientUnknownRequestError(
      'PostgresError { code: "TA026", message: "single_entry_period_conflict: side=company_users; subsidiary x", severity: "ERROR" }',
      { clientVersion: 'test' },
    ));
    await expect(service.create(centralReporter(), CREATE_DTO)).rejects.toMatchObject({
      response: { code: 'single_entry_period_conflict', params: { side: 'company_users', category: 'Electricity', year: 2024, period: 'Annual' } },
    });
  });

  it('an edit moving a draft into a taken period is refused, and nothing is written', async () => {
    const { prisma, service } = build();
    const draft = makeRecord({
      id: 'rec-d', subsidiaryId: 'sub-1', status: ActivityRecordStatus.draft, createdBy: 'user-entry', reportedBySubsidiaryId: 'sub-2',
      reportingYear: 2024, reportingPeriod: 'monthly', periodValue: 'April', category: 'Electricity',
    });
    prisma.activityRecord.findUnique.mockResolvedValue(draft);
    routeRaw(prisma, { otherParty: true, access: REPORTER_ACCESS });
    await expect(service.update(centralReporter(), 'rec-d', { periodValue: 'March' }))
      .rejects.toMatchObject({ response: { code: 'single_entry_period_conflict', params: { side: 'company_users', period: 'March' } } });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('central reporting — an edit raced into a taken period (qa-auditor S6)', () => {
  it("the database's TA026 refusal on an edit answers single_entry_period_conflict with the edit's values", async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(makeRecord({
      id: 'rec-d', subsidiaryId: 'sub-1', status: ActivityRecordStatus.draft, createdBy: 'user-entry', reportedBySubsidiaryId: 'sub-2',
      reportingYear: 2024, reportingPeriod: 'monthly', periodValue: 'April', category: 'Electricity',
    }));
    prisma.activityRecord.update.mockRejectedValue(new Prisma.PrismaClientUnknownRequestError(
      'PostgresError { code: "TA026", message: "single_entry_period_conflict: side=company_users; subsidiary x", severity: "ERROR" }',
      { clientVersion: 'test' },
    ));
    await expect(service.update(centralReporter(), 'rec-d', { periodValue: 'March' })).rejects.toMatchObject({
      response: { code: 'single_entry_period_conflict', params: { side: 'company_users', category: 'Electricity', year: 2024, period: 'March' } },
    });
  });
});

describe("the owner's review of WP8 (2026-11-26)", () => {
  const draft = () => makeRecord({
    id: 'rec-d', subsidiaryId: 'sub-1', status: ActivityRecordStatus.draft, createdBy: 'user-entry', reportedBySubsidiaryId: 'sub-2',
    reportingYear: 2024, reportingPeriod: 'monthly', periodValue: 'April', category: 'Electricity',
  });

  it('P1: an edit after the company was withdrawn is refused inside the write, and nothing is written', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(draft());
    routeRaw(prisma, { access: [REPORTER_ACCESS[1]!] });
    await expect(service.update(centralReporter(), 'rec-d', { activityValue: 5 })).rejects.toMatchObject({ response: { code: 'subsidiary_not_found' } });
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('P1: an edit after its category was withdrawn is refused with category_not_granted', async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(draft());
    routeRaw(prisma, { access: [{ ...REPORTER_ACCESS[0]!, categories: ['Water'] }, REPORTER_ACCESS[1]!] });
    await expect(service.update(centralReporter(), 'rec-d', { activityValue: 5 })).rejects.toBeInstanceOf(CategoryNotGrantedError);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it("P2: the companies are locked FOR KEY SHARE before the access rows — a company delete's order", async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { access: REPORTER_ACCESS });
    prisma.activityRecord.create.mockImplementation(({ data }: any) => makeRecord({ ...data, id: 'rec-new', reportedBySubsidiaryId: 'sub-2' }));
    await service.create(centralReporter(), CREATE_DTO);
    const sql = rawSql(prisma);
    const keyShare = sql.findIndex((q) => q.includes('FOR KEY SHARE'));
    expect(keyShare).toBeGreaterThanOrEqual(0);
    expect(keyShare).toBeLessThan(sql.findIndex((q) => q.includes('kind, categories')));
  });

  it('P2: a read that waited on a moved main company is taken again, and the write follows the new one', async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { accessReads: [[REPORTER_ACCESS[0]!], [REPORTER_ACCESS[0]!, { subsidiaryId: 'sub-3', kind: 'assigned', categories: ['Water'] }]] });
    prisma.activityRecord.create.mockImplementation(({ data }: any) => makeRecord({ ...data, id: 'rec-new', reportedBySubsidiaryId: 'sub-3' }));
    await expect(service.create(centralReporter(), CREATE_DTO)).resolves.toMatchObject({ reportedBySubsidiaryId: 'sub-3' });
    expect(rawSql(prisma).filter((q) => q.includes('kind, categories'))).toHaveLength(2);
    // The companies again before the second read: companies, rows, companies, rows (security review).
    const order = rawSql(prisma).filter((q) => q.includes('FOR KEY SHARE') || q.includes('kind, categories'))
      .map((q) => (q.includes('FOR KEY SHARE') ? 'companies' : 'rows'));
    expect(order).toEqual(['companies', 'rows', 'companies', 'rows']);
  });

  it('P2: a read with the company present and one main company is not taken again', async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { access: REPORTER_ACCESS });
    prisma.activityRecord.create.mockImplementation(({ data }: any) => makeRecord({ ...data, id: 'rec-new', reportedBySubsidiaryId: 'sub-2' }));
    await service.create(centralReporter(), CREATE_DTO);
    expect(rawSql(prisma).filter((q) => q.includes('kind, categories'))).toHaveLength(1);
  });

  it('P2: an exact repeat answers record_duplicate before the period rule, on a create and on an edit', async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { access: REPORTER_ACCESS, duplicate: true, otherParty: true });
    await expect(service.create(centralReporter(), CREATE_DTO)).rejects.toBeInstanceOf(DuplicateActivityRecordError);
    prisma.activityRecord.findUnique.mockResolvedValue(draft());
    await expect(service.update(centralReporter(), 'rec-d', { periodValue: 'March' })).rejects.toBeInstanceOf(DuplicateActivityRecordError);
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('the category is judged before the duplicate look: an ungranted category never learns of a record there (R5)', async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { access: REPORTER_ACCESS, duplicate: true });
    await expect(service.create(centralReporter(), { ...CREATE_DTO, category: 'Water' })).rejects.toBeInstanceOf(CategoryNotGrantedError);
    // An edit whose category was withdrawn meanwhile: refused under the lock, before the look.
    prisma.activityRecord.findUnique.mockResolvedValue(draft());
    routeRaw(prisma, { access: [{ ...REPORTER_ACCESS[0]!, categories: ['Water'] }, REPORTER_ACCESS[1]!], duplicate: true });
    await expect(service.update(centralReporter(), 'rec-d', { periodValue: 'March' })).rejects.toBeInstanceOf(CategoryNotGrantedError);
    expect(rawSql(prisma).some((q) => q.includes('r.activity_type IS NOT DISTINCT FROM'))).toBe(false);
  });

  it("an edit moving a draft into a category withdrawn meanwhile is judged on the new category (QA P3-1)", async () => {
    const { prisma, service } = build();
    prisma.activityRecord.findUnique.mockResolvedValue(draft());
    // The request's access ticks Water; the committed rows tick Electricity only.
    routeRaw(prisma, { access: REPORTER_ACCESS });
    const user = standardUser({
      accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
      categoryGrants: { 'sub-1': ['Electricity', 'Water'], 'sub-2': ['Water'] },
      grantKinds: { 'sub-1': 'central_reporter', 'sub-2': 'assigned' },
    });
    await expect(service.update(user, 'rec-d', { category: 'Water', activityUnit: 'm3' })).rejects.toBeInstanceOf(CategoryNotGrantedError);
    expect(prisma.activityRecord.update).not.toHaveBeenCalled();
  });

  it('a repeat committed between the preview and the write still answers record_duplicate (QA P3-2)', async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { access: REPORTER_ACCESS, duplicateReads: [[], [{ exact: true }]] });
    await expect(service.create(centralReporter(), CREATE_DTO)).rejects.toBeInstanceOf(DuplicateActivityRecordError);
    expect(prisma.activityRecord.create).not.toHaveBeenCalled();
  });

  it("a slot holding the other kind answers TA002's conflict before the period rule, as the bulk upload does (QA P3-3)", async () => {
    const { prisma, service } = build();
    routeRaw(prisma, { access: REPORTER_ACCESS, duplicate: 'slot_kind', otherParty: true });
    await expect(service.create(centralReporter(), CREATE_DTO)).rejects.toBeInstanceOf(ActivityTypeSlotConflictError);
  });
});
