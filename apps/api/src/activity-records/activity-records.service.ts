import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { errorBody, QueryTooBroadError, ResourceNotFoundError } from '../common/api-error';
import {
  ActivityRecordStatus,
  Prisma,
  type ActivityRecord,
} from '@tonyai/db';
import {
  ApprovalEvidenceMissingError,
  CalculationStaleError,
  CreateRoleRefusedError,
  DuplicateActivityRecordError,
  EntityClosedToDataEntryError,
  EvidenceRequiredError,
  PeriodLockedError,
  RecordChangedError,
  SubmitAuthorRefusedError,
  AuthorOnlyRefusedError,
  EvidenceDetachRequiredError,
  ReviewVersionRequiredError,
  EditVersionRequiredError,
  RecordNotRecallableError,
  SubmitRoleRefusedError,
  VarianceReasonRequiredError,
  ActivityValueReentryRequiredError,
  ActivityTypeSlotConflictError,
  SnapshotImmutableError,
  recordTriggerCode,
} from './errors';
import {
  EVIDENCE_REQUIRED_CATEGORIES,
  holdsRecords,
  canonicalPeriodValue,
  CATEGORY_SCOPE_MAP,
  type AnomalyVerdict,
  varianceBasisOf,
  SUBMITTABLE_STATUSES as SUBMITTABLE_STATUSES_CONTRACT,
  isEvidenceRequired,
  needsEvidenceBeforeSubmit,
  type ActivityCalculationSnapshot,
  DEFAULT_ACTIVITY_RECORD_SORT,
  type ActivityRecordDTO,
  type GenerationFuelRecordState,
  type ActivityRecordListMetadataDTO,
  type ActivityRecordPageItemDTO,
  type AuditAction,
  type CursorPage,
  type Category,
  type RecordParameters,
  type ReportingPeriod,
  mayAuthorRecords,
  can,
  type RecordApprover,
  isRecallable,
  EDITABLE_RECORD_STATUSES,
  normalizeRecordParameters,
  electricitySupplierIssues,
  recordParameterShape,
  recordActivityTypesFor,
  REPORTING_PERIODS,
  recordParty,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { treeTriggerRefusal } from '../subsidiaries/tree-errors';
import { generationFuelRecords } from './generation-fuel-records';
import { quoteCallerText } from '../common/caller-text';
import {
  actorDisplayName,
  resolveProfiles,
  type ResolvedProfile,
} from '../common/resolve-profiles';
import { CalculationsService } from '../calculations/calculations.service';
import { storedUnit } from '../calculations/storable-unit';
import { compareSnapshots } from '../calculations/snapshot-staleness';
import { CalculationInputError } from '../calculations/errors';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { EvidenceService } from '../evidence/evidence.service';
import {
  LIFECYCLE_TX,
  asLostRace,
  changedSince,
  lockActivityRecordRow,
  lockEvidenceRows,
  lockPeriodsShared,
  periodOf,
  samePeriod,
  regate,
  type PeriodKey,
} from './lifecycle-lock';
import { CreateActivityRecordDto } from './dto/create-activity-record.dto';
import { UpdateActivityRecordDto } from './dto/update-activity-record.dto';
import { recordParametersIssues } from './dto/record-parameters.dto';
import {
  ActivityRecordFiltersQueryDto,
  ActivityRecordPageQueryDto,
} from './dto/activity-record-page-query.dto';
import { closedRecordIds } from './closed-periods';
import { normaliseRecordFilters, RECORD_SORTS, recordFilterWhere, type RecordFilters } from './record-page';
import { approversFor, awaitingDecisionWhere, deciderFor } from './record-approver';
import { assertCategoryGranted, inRecordScope } from './record-scope';
import { recordCentralReportingRefusal } from '../central-reporting/central-reporting-errors';
import {
  accessRowsOf,
  assertNotExactDuplicate,
  assertSingleEntryPeriod,
  lockAuthorAccess,
  partyOf,
  reportingEntityOf,
  reportingNamesFor,
} from '../central-reporting/record-entities';

/** A write that leaves a record in draft or returned: no record of it is pending. */
const NO_APPROVERS: ReadonlyMap<string, RecordApprover | null> = new Map();
import {
  cursorBinding,
  decodeCursor,
  keysetOrderBy,
  keysetWhere,
  pageLimit,
  toCursorPage,
} from '../common/keyset-cursor';
import { readRuntimeConfig } from '../common/runtime-config';
import { ActivityRecordCalculation, sameEngineInputs, sameParameters, type Recomputed } from './activity-record-calculation';

export { periodOrdinal } from './activity-record-calculation';

/**
 * A record in a typed category (Fuel, Mobile Combustion, Refrigerants) names
 * its fuel or gas (`activity_type_required`, LP3-03). Whether the category
 * HAS the named type is the engine's check (`activity_type_not_for_category`).
 * Asked at create, at an edit that is not a pre-LP3-03 record staying untyped
 * in its own category, and — with no exemption — at submit and approve
 * (decision C8, LP4-02 B2).
 */
function assertActivityTypeNamed(category: string, activityType: string | null): void {
  const types = recordActivityTypesFor(category);
  if (types.length > 0 && activityType === null) {
    throw new CalculationInputError(
      'activity_type_required',
      `A ${category} record must name its activity type. Accepted: ${types.map((t) => t.value).join(', ')}.`,
    );
  }
}

/**
 * A write's parameters hold to its EFFECTIVE category's rule (D3). The DTO
 * cannot ask this for an edit that does not name its category, or one that
 * moves a record with stored parameters to a category that takes none, and the
 * database CHECK would answer those with a server error.
 */
function assertRecordParameters(category: string, parameters: unknown): void {
  const issues = recordParametersIssues(category, parameters);
  if (issues.length > 0) throw new CalculationInputError('record_parameters_invalid', issues.join('; '));
}

/**
 * An Electricity record's supplier, its `utility_provider`, holds to the
 * supplier's bound (UAT round 4, BUG-16). The DTO bounds `invoice_no` and
 * `supplier` by their key; this one is a supplier only on an Electricity
 * record, and the key is older than the rule, so it is asked here, of the
 * EFFECTIVE category, with the stored `input` beside it: the value an old
 * record already holds is left alone, a new or changed one is refused.
 */
function assertElectricitySupplier(category: string, input: unknown, stored?: unknown): void {
  const issues = electricitySupplierIssues(category, input, stored);
  if (issues.length > 0) throw new BadRequestException(errorBody('validation_failed', issues));
}

// The refusal classes and their sentences live in `./errors`.

/** What a record write returns: the row as every read path includes it. */
type WrittenRecord = ActivityRecord & {
  _count: { evidenceLinks: number };
  location: { name: string } | null;
};

/**
 * A committed write and its fuel-record state, read inside the write's own
 * transaction (self-gen-form, outside review): a failure of that read rolls
 * back the write and its audit row with it, so a caller (bulk submit) never
 * counts as failed a write that committed.
 */
type FuelResolved = { fuelRecords: Map<string, GenerationFuelRecordState> };

const WRITTEN_RECORD_INCLUDE = {
  _count: { select: { evidenceLinks: true } },
  location: { select: { name: true } },
} as const;

/**
 * `needsEvidenceBeforeSubmit` (the submit gate below) as a Prisma `where`:
 * a record that is NOT waiting for an evidence file — its category needs
 * none, or one is attached. For callers that must count or select such
 * records in one query (the import batch's "Send N drafts"); the gate itself
 * still decides, per record, at submit. Kept here, beside that gate, so the
 * two cannot drift; `activity-records.service.spec.ts` pins them together.
 */
export function evidenceReadyWhere() {
  return {
    OR: [
      { category: { notIn: [...EVIDENCE_REQUIRED_CATEGORIES] as string[] } },
      { evidenceLinks: { some: {} } },
    ],
  };
}
// Who may take a record into review, return it or approve it is
// `can(role, 'record.decide')` — a masterkey or a super_admin (INC-2.6 §1.1)
// — and, of those, only the record's approver (`recordApprover`). Every other
// approval gate is role-blind.
//
// Who may VOID is `can(role, 'record.void')` — a masterkey only, and
// deliberately a capability of its own: deciding records must never widen
// void (see `void`; INC-2.6 ruling R4).
/**
 * A review decision is about the submission the reviewer saw (BUG-R2-03
 * review, P1). Since an author may recall a submitted record, edit it and
 * submit it again, a reviewer who opened the record before that would
 * otherwise approve a figure they never saw. The client names the
 * `submittedAt` it was shown; any other submission is a lost race (409).
 * Absent, nothing is compared (an older client, a script).
 */
/**
 * What the HTTP layer passes when a request names no submission at all
 * (BUG-R2-03 owner review P1): over HTTP the field is required, and its
 * absence is refused right after the role check — so a role refusal still
 * comes first. In-process callers that pass nothing are not compared.
 */
export const SUBMISSION_NOT_NAMED: unique symbol = Symbol('submission not named');
export type SeenSubmission = string | null | typeof SUBMISSION_NOT_NAMED;

function assertSubmissionNamed(seenSubmittedAt: SeenSubmission | undefined): void {
  if (seenSubmittedAt === SUBMISSION_NOT_NAMED) throw new ReviewVersionRequiredError();
}

function assertSameSubmission(record: { submittedAt: Date | null }, seenSubmittedAt: SeenSubmission | undefined): void {
  if (seenSubmittedAt === undefined || seenSubmittedAt === SUBMISSION_NOT_NAMED) return;
  const seen = seenSubmittedAt === null ? null : Date.parse(seenSubmittedAt);
  const now = record.submittedAt ? record.submittedAt.getTime() : null;
  if (seen !== now) throw new RecordChangedError();
}

/**
 * An edit names the version it was made on (`seenUpdatedAt`, self-gen-model
 * review of `1802e22e`): a record changed since the editor read it is refused
 * as a lost race. With the lock's own `changedSince` (read → locked row), this
 * covers the whole window from the page's read to the write. Absent, nothing
 * is compared (an older client, a script).
 */
function assertSameVersion(record: { updatedAt: Date }, seenUpdatedAt: string | undefined): void {
  if (seenUpdatedAt === undefined) return;
  if (Date.parse(seenUpdatedAt) !== record.updatedAt.getTime()) throw new RecordChangedError();
}

/** Whether a stored record holds a self-generation block (self-gen-model). */
function holdsSelfGeneration(record: { category: string; parameters: unknown }): boolean {
  return recordParameterShape(record.category) === 'electricity' && normalizeRecordParameters(record.parameters) !== null;
}

// Statuses in which a record may still be edited or deleted by an author.
// Exported so the subsidiary delete guard can tell a removable draft from a
// committed record it must refuse over — if the two lists drifted, that guard
// would start offering advice ("delete the drafts first") that the record
// endpoint refuses to carry out.
// Built from the contract's list (BUG-R2-03 review), so the screens'
// `mayEditRecord`, this gate and the trigger pin in record-triggers.spec.ts
// read one list.
export const EDITABLE_STATUSES = new Set<ActivityRecordStatus>(
  EDITABLE_RECORD_STATUSES.map((status) => ActivityRecordStatus[status]),
);

// A rejected record must be able to come BACK. Rejecting is the reviewer's
// routine action, editing a rejected record is already allowed, and `rejected`
// is excluded from the counted statuses — so if `submitted` were reachable only
// from `draft`, every rejection would strand a record permanently outside the
// inventory with no API path back, while pinning its report to
// `contains_incomplete_data`. Found by review before the reviewer UI made
// rejection a one-click action.
// The lifecycle rule now lives in the contract, because it was written down
// three times: here, and twice in the browser. `isSubmittable` is the answer;
// this Set is the API's index into it.
const SUBMITTABLE_STATUSES = new Set<ActivityRecordStatus>(
  SUBMITTABLE_STATUSES_CONTRACT as readonly ActivityRecordStatus[],
);

/**
 * The canonical spelling to STORE, or a 400 naming what was sent — quoted
 * through `quoteCallerText`, because a bulk import repeats the sentence in its
 * report, and a U+202E in the value reversed the rest of it on screen.
 *
 * Validating alone was never enough. The old `isValidPeriodValue` (since
 * folded into `canonicalPeriodValue`) has always been case-insensitive to
 * COMPARE, so `"january"` passed — and was then written verbatim,
 * where the uniqueness index and the period-lock lookups both compare raw
 * strings. One month could therefore exist as two rows that both counted, and a
 * lock on one spelling closed nothing for the other.
 */
function requireCanonicalPeriodValue(
  reportingPeriod: string,
  periodValue: string,
): string {
  const canonical = canonicalPeriodValue(reportingPeriod, periodValue);
  if (canonical === null) {
    throw new BadRequestException(
      errorBody(
        'record_period_invalid',
        `"${quoteCallerText(periodValue)}" is not a valid period for a ${reportingPeriod} record.`,
        // Canonical only: a bulk row's granularity is the file's text until
        // checked, and params never carry caller text — without the param the
        // screen shows its generic sentence.
        (REPORTING_PERIODS as readonly string[]).includes(reportingPeriod)
          ? { granularity: reportingPeriod }
          : undefined,
      ),
    );
  }
  return canonical;
}

/** The resolved-at-read-time fields, named once so both the DTO's audit
 *  snapshot and the guard below stay in step. */
type ResolvedRecordFields =
  | 'reportedBySubsidiaryName'
  | 'locationName'
  | 'createdByName'
  | 'reviewedByName'
  | 'voidedByName'
  | 'generationFuelRecord';

/**
 * The record's persisted columns, and a compile error for anything resolved.
 *
 * The `?: never` half is load-bearing and is not decoration: `Omit` alone is an
 * excess-property check, which a spread bypasses. Optional-`never` makes each
 * resolved key unassignable to anything but `undefined`, which a spread cannot
 * bypass — measured against `{ ...dto }`, `...{ createdByName }` and a fourth
 * novel field. Do not "simplify" this back to a plain `Omit`.
 */
type ActivityRecordAuditSnapshot = Omit<ActivityRecordDTO, ResolvedRecordFields> & {
  [K in ResolvedRecordFields]?: never;
};

/** A natural gas bill in kWh or MWh on the NET basis (ng-kwh-engine). */
function isNetEnergyBill(category: string, unit: string, parameters: unknown): boolean {
  return (
    category === 'Natural Gas' &&
    (unit === 'kWh' || unit === 'MWh') &&
    normalizeRecordParameters(parameters) !== null &&
    (normalizeRecordParameters(parameters) as { cvBasis?: unknown }).cvBasis === 'net'
  );
}

/** A natural gas bill in kWh or MWh, on either basis (ng-kwh-engine). */
function isGasEnergyBill(category: string, unit: string): boolean {
  return category === 'Natural Gas' && (unit === 'kWh' || unit === 'MWh');
}

/**
 * Whether an update would carry a stored natural gas bill's quantity (kWh or
 * MWh) somewhere it no longer means the same thing (ng-kwh-engine reviews):
 * another unit or category, on either basis (1,000 kWh read as 1,000 MWh or as
 * a volume), and, for a NET bill, another site (whose geography may price an
 * energy bill as gross) or another basis. Other records keep the API's
 * inheritance as before (Open questions).
 */
export function inheritsQuantityElsewhere(
  existing: { category: string; activityUnit: string; locationId: string | null; parameters: unknown },
  next: { category: string; activityUnit: string; locationId: string | null; parameters: unknown },
): boolean {
  // Compared by their stored spelling: a caller's `kwh` is the stored `kWh`.
  const nextUnit = typeof next.activityUnit === 'string' ? storedUnit(next.activityUnit) : next.activityUnit;
  if (!isGasEnergyBill(existing.category, storedUnit(existing.activityUnit))) return false;
  if (nextUnit !== storedUnit(existing.activityUnit) || next.category !== existing.category) return true;
  if (!isNetEnergyBill(existing.category, existing.activityUnit, existing.parameters)) return false;
  return next.locationId !== existing.locationId || !isNetEnergyBill(next.category, nextUnit, next.parameters);
}

/**
 * A record's submit audit rows, in both shapes the submission-count migration
 * counts (WP5): `submit`, and a pre-taxonomy `update` whose `diff.transition.to`
 * is `submitted`. One definition, so the column and the history agree.
 */
export function submitRowsOf(recordId: string, organisationId: string | null): Prisma.AuditLogWhereInput {
  return {
    entity: 'activity_record',
    // Any spelling of the id (rows from before ids were canonicalised), within
    // the record's organisation.
    entityId: { equals: recordId, mode: 'insensitive' },
    organisationId,
    OR: [
      { action: 'submit' },
      { action: 'update', diff: { path: ['transition', 'to'], equals: 'submitted' } },
    ],
  };
}

@Injectable()
export class ActivityRecordsService {
  private readonly logger = new Logger(ActivityRecordsService.name);

  private readonly limits = readRuntimeConfig();
  private readonly recordCalculation: ActivityRecordCalculation;

  constructor(
    private readonly prisma: PrismaService,
    calculations: CalculationsService,
    private readonly audit: AuditService,
    private readonly evidence: EvidenceService,
  ) {
    this.recordCalculation = new ActivityRecordCalculation(prisma, calculations);
  }

  /**
   * The record's own persisted columns, and nothing resolved by a join. This is
   * the audit snapshot, and `audit_log` is append-only: whatever goes in here is
   * permanent and has no correction path.
   *
   * `locationName` is carried by an `include` that only some queries ask for, so
   * feeding the read DTO straight to the audit trail wrote falsehoods — a create
   * whose `locationId` was set the whole time logged `locationName: null`, and
   * the next unrelated edit logged `null → "Site A"`, dating a geography
   * decision to a day on which nothing about the location changed.
   *
   * Resolved fields belong in `toDTO`, which builds on this — so a field added
   * to `ActivityRecordDTO` has to be placed on one side or the other instead of
   * silently reaching the audit log.
   *
   * A bare `Omit` was only half a guard, measured rather than assumed. It
   * rejects a resolved field written here as a DIRECT property (TS2561, and
   * only because those fields are required — an optional one passed silently),
   * but not one arriving through a SPREAD: excess-property checking does not
   * cross a spread, so `...{ createdByName: … }` compiled clean, and so did
   * `return { ...dto }` — which is LITERALLY the mistake described above.
   *
   * `ActivityRecordAuditSnapshot` closes that by adding `?: never` for each
   * resolved key, turning the check from excess-property into ASSIGNABILITY,
   * which a spread cannot slip past. The resulting error text is obscure
   * ("Type 'string' is not assignable to type 'undefined'"), hence this note.
   *
   * The runtime belt to that brace is the spec's `lets NOTHING but a persisted
   * column reach the append-only audit log`, which asserts this object's whole
   * key SET — it catches a key the compiler cannot see at all, such as one
   * built through `Object.fromEntries`.
   */
  private toAuditSnapshot(
    r: ActivityRecord,
    evidenceCount = 0,
  ): ActivityRecordAuditSnapshot {
    return {
      id: r.id,
      subsidiaryId: r.subsidiaryId,
      locationId: r.locationId,
      reportingYear: r.reportingYear,
      reportingPeriod: r.reportingPeriod as ReportingPeriod,
      periodValue: r.periodValue,
      category: r.category as Category,
      activityType: r.activityType,
      scope: r.scope,
      status: r.status,
      activityValue: r.activityValue,
      activityUnit: r.activityUnit,
      input: (r.input as Record<string, unknown> | null) ?? null,
      parameters: (r.parameters as RecordParameters | null) ?? null,
      calculation: r.calculation as unknown as ActivityCalculationSnapshot,
      createdBy: r.createdBy,
      anomalyFlag: r.anomalyFlag,
      anomalyBaselinePriorCount: r.anomalyBaselinePriorCount,
      anomalyBaselineTCo2e: r.anomalyBaselineTCo2e,
      varianceReason: r.varianceReason,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
      reviewNote: r.reviewNote,
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      submissionCount: r.submissionCount,
      // Persisted columns, so they belong in the audit snapshot too — a void is
      // the transition whose provenance matters most.
      voidReason: r.voidReason,
      voidedBy: r.voidedBy,
      voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
      importBatchId: r.importBatchId,
      // The reporting entity (inc26-central-reporter-onboarding D1): the stored
      // column, read as it means — empty is the record's own company.
      reportedBySubsidiaryId: r.reportedBySubsidiaryId ?? r.subsidiaryId,
      evidenceCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private toDTO(
    r: ActivityRecord & { location?: { name: string } | null },
    evidenceCount = 0,
    actors: Map<string, ResolvedProfile>,
    fuelRecords: Map<string, GenerationFuelRecordState>,
    approvers: ReadonlyMap<string, RecordApprover | null>,
    reportingNames: ReadonlyMap<string, string>,
  ): ActivityRecordDTO {
    return {
      ...this.toAuditSnapshot(r, evidenceCount),
      // Resolved within the reader's organisation, not its company scope (C4):
      // the owning company's approver reads the name of the company that
      // reported. Required like the actors' names, for the same reason.
      reportedBySubsidiaryName: reportingNames.get(r.reportedBySubsidiaryId ?? r.subsidiaryId) ?? null,
      // Who decides it now (inc26-roles-approval-chain): a pending record's
      // approver, worked out on every read; null on every other status.
      // Required like the names: a write's answer replaces the screen's row.
      approver: approvers.get(r.id) ?? null,
      // Resolved at read time, the same way the audit trail resolves an actor's
      // name: uniqueness includes `location_id`, so two pending records in the
      // same subsidiary/period/category can differ ONLY by location — and the
      // reviewer saw two identical-looking rows with no way to tell them apart.
      locationName: r.location?.name ?? null,
      // `actors` is REQUIRED, not optional. Making it optional let the write
      // paths return a DTO with these keys absent, and both screens splice a
      // write response straight into state built from a read — so the name
      // vanished from the row the instant a reviewer took the record into
      // review. Requiring the map means there is no shape to forget to pass.
      createdByName: actorDisplayName(r.createdBy, actors),
      reviewedByName: actorDisplayName(r.reviewedBy, actors),
      voidedByName: actorDisplayName(r.voidedBy, actors),
      // Required for the same reason as the names: the review sheet replaces
      // its record with a write's answer, so a field only the list filled would
      // vanish when the reviewer starts the review (self-gen-form, design 6).
      generationFuelRecord: fuelRecords.get(r.id) ?? null,
    };
  }

  /**
   * Whether each fuel-sourced Electricity record among `records` has its fuel
   * record (D5): one query for all of them, none when no record names a fuel
   * source, inside the caller's accessible set.
   */
  private fuelRecordsFor(
    user: RequestUser,
    records: readonly ActivityRecord[],
  ): Promise<Map<string, GenerationFuelRecordState>> {
    return generationFuelRecords(this.prisma, user.accessibleSubsidiaryIds, records);
  }

  /** The same, for a write's answer, read on the write's own transaction (`FuelResolved`). */
  private fuelRecordsIn(
    tx: Prisma.TransactionClient,
    user: RequestUser,
    records: readonly ActivityRecord[],
  ): Promise<Map<string, GenerationFuelRecordState>> {
    return generationFuelRecords(tx, user.accessibleSubsidiaryIds, records);
  }

  /**
   * The actor map for one or more records, without a query when the caller is
   * the only actor involved.
   *
   * On a create that is always the case — `created_by` is the caller, and
   * `reviewed_by` and `voided_by` are both null — so a create costs ZERO extra
   * queries. The guard has
   * already loaded the caller's whole profile to build `RequestUser`, so the
   * name is in hand before the request reaches this service.
   */
  private async actorsFor(
    user: RequestUser,
    records: readonly Pick<ActivityRecord, 'createdBy' | 'reviewedBy' | 'voidedBy'>[],
  ): Promise<Map<string, ResolvedProfile>> {
    const known = new Map<string, ResolvedProfile>([
      [user.id, { email: user.email, fullName: user.fullName }],
    ]);
    const unknown = records
      .flatMap((r) => [r.createdBy, r.reviewedBy, r.voidedBy])
      .filter((id): id is string => !!id && !known.has(id));
    if (unknown.length === 0) return known;
    for (const [id, profile] of await resolveProfiles(this.prisma, unknown)) {
      known.set(id, profile);
    }
    return known;
  }

  /**
   * Load a record and enforce tenant isolation: ids whose subsidiary is outside
   * the caller's accessible set are treated as not found (never leak existence).
   *
   * The location include is not optional: every read path has to agree on
   * `locationName`, and the contract documents `null` as "subsidiary-level, or
   * the location has since been removed" — the second half being exactly the
   * state this work package made impossible. A `GET /:id` that answered `null`
   * for a located record would therefore read as "orphaned, investigate".
   */
  private async loadScoped(
    user: RequestUser,
    id: string,
  ): Promise<ActivityRecord & { location: { name: string } | null }> {
    // The caller's record scope (company, and a standard user's categories or
    // own records): a record outside it answers as one that does not exist.
    const record = await this.prisma.activityRecord.findUnique({
      where: { id },
      include: { location: { select: { name: true } } },
    });
    if (!record || !inRecordScope(user, record)) {
      throw new ResourceNotFoundError('record_not_found');
    }
    return record;
  }

  /**
   * Steps 2-4 of the lifecycle protocol (`lifecycle-lock.ts`) for one record
   * the caller has already read as `seen`: share its period — and `alsoPeriods`,
   * the period an edit moves it into — lock its row, re-read it, and hand the
   * locked row to `fn`, which re-runs its gates and writes with its audit row
   * through `tx`. One transaction; nothing in `fn` may use `this.prisma`.
   *
   * The period locks are taken for the period the record was in when READ,
   * before its row lock (the protocol's order). An edit committed in between
   * may have moved it; then those locks guard the wrong period, and the honest
   * answer is a lost race rather than a write the period's lock never saw.
   */
  private async withLockedRecord<T>(
    seen: ActivityRecord,
    fn: (
      tx: Prisma.TransactionClient,
      current: ActivityRecord & { location: { name: string } | null },
    ) => Promise<T>,
    alsoPeriods: PeriodKey[] = [],
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockPeriodsShared(tx, [periodOf(seen), ...alsoPeriods]);
        // Deleted meanwhile by a concurrent request, which audited it.
        if (!(await lockActivityRecordRow(tx, seen.id))) {
          throw new ResourceNotFoundError('record_not_found');
        }
        const current = await tx.activityRecord.findUnique({
          where: { id: seen.id },
          include: { location: { select: { name: true } } },
        });
        if (!current) throw new ResourceNotFoundError('record_not_found');
        if (!samePeriod(periodOf(seen), periodOf(current))) {
          throw new RecordChangedError();
        }
        return fn(tx, current);
      }, LIFECYCLE_TX);
    } catch (e) {
      throw asLostRace(e);
    }
  }

  /**
   * The edit gate: an author role, the record's own author — `masterkey`
   * included, never exempt (BUG-R2-03, decision 2026-11-10 (fourth), 5) — and
   * an editable status. Before, a masterkey could edit a colleague's draft
   * and approve it once submitted, which D01 (creator ≠ approver) could not
   * see. `mayEditRecord` in the contract is the same rule for the screens.
   */
  private assertCanEdit(user: RequestUser, record: ActivityRecord): void {
    if (!mayAuthorRecords(user)) {
      throw new ForbiddenException(
        'Your role may not modify activity records',
      );
    }
    if (record.createdBy !== user.id) {
      throw new AuthorOnlyRefusedError('edit');
    }
    this.assertEditableStatus(record);
  }

  /**
   * The delete gate: the author, or a masterkey (`record.delete_any_draft`,
   * INC-2.6 ruling R4) — never a super_admin for a colleague's. A draft
   * counts towards nothing, so the organisation's administrator removing a
   * colleague's abandoned draft changes no figure anyone will approve.
   */
  private assertCanDelete(user: RequestUser, record: ActivityRecord): void {
    if (!mayAuthorRecords(user)) {
      throw new ForbiddenException(
        'Your role may not modify activity records',
      );
    }
    if (!can(user.role, 'record.delete_any_draft') && record.createdBy !== user.id) {
      throw new AuthorOnlyRefusedError('delete');
    }
    this.assertEditableStatus(record);
  }

  private assertEditableStatus(record: ActivityRecord): void {
    if (!EDITABLE_STATUSES.has(record.status)) {
      throw new BadRequestException(
        errorBody('record_not_editable', `Cannot modify a record in status "${record.status}"`, {
          status: record.status,
        }),
      );
    }
  }

  /**
   * K11, second half, under the record's lock: the recompute taken from `read`
   * must still describe `locked` — the same engine inputs, else a writer got
   * in between and the answer is the lost race, `record_changed` (C2-A) — and
   * the stored snapshot must be the recomputed one (`compareSnapshots`, P6).
   * Otherwise nothing commits: `calculation_stale`, 409, no params. The log
   * line names the part that differs, so a library change is told from a
   * direct writer's rewrite ("LP4-02 follow-ups" (6)) — never a value.
   *
   * The record's own `scope` and period columns are inputs too: the snapshot
   * carries neither and the engine reads neither, but every total groups by
   * them — so a scope that is not its category's (`security-rls` P2-1, B2
   * review), or a period value not in its canonical spelling, which the
   * period lock's exact lookup would miss while the totals still count it
   * (re-review P2-B), is a mismatch of inputs.
   *
   * What it does not see: the site's or subsidiary's geography, or the
   * library, changing in the milliseconds between the recompute and the
   * commit — the same as a change landing just after it (accepted, C1-a).
   */
  private assertFresh(
    operation: 'submit' | 'approve',
    read: ActivityRecord,
    locked: ActivityRecord,
    recomputed: Recomputed,
  ): void {
    if (!sameEngineInputs(read, locked)) throw new RecordChangedError();
    let why: string | null = null;
    if (!recomputed.ok) {
      why = `recompute refused (${recomputed.refusal})`;
    } else {
      const comparison = compareSnapshots(locked.calculation, recomputed.calculation);
      const columnsAgree =
        locked.scope === CATEGORY_SCOPE_MAP[locked.category as Category] &&
        canonicalPeriodValue(locked.reportingPeriod, locked.periodValue) === locked.periodValue;
      if (comparison.stale || !columnsAgree) {
        // `input` leads the classes' fixed order, so it is prepended.
        const classes = columnsAgree
          ? comparison.classes
          : ['input', ...comparison.classes.filter((c) => c !== 'input')];
        why = [
          comparison.legacy ? 'legacy snapshot' : null,
          classes.length > 0 ? `${classes.join(', ')} differ` : null,
        ]
          .filter((part) => part !== null)
          .join('; ');
      }
    }
    if (why === null) return;
    this.logger.warn(`calculation_stale: ${operation} of record ${locked.id} refused — ${why}`);
    throw new CalculationStaleError();
  }

  /**
   * Period-lock gate (FR §4.2): while a `period_locks` row exists for the
   * record's (subsidiary, year, period, periodValue), NO create/update/delete/
   * submit is allowed — the period is closed. masterkey must unlock first.
   */
  private async assertPeriodNotLocked(
    period: PeriodKey,
    client: Pick<Prisma.TransactionClient, 'periodLock'> = this.prisma,
  ): Promise<void> {
    const { reportingYear, periodValue } = period;
    const lock = await client.periodLock.findFirst({ where: periodOf(period) });
    if (lock) {
      throw new PeriodLockedError(
        `Reporting period ${periodValue} ${reportingYear} is locked — a masterkey must unlock it before records can change.`,
        { periodValue, reportingYear },
      );
    }
  }

  /**
   * One page of the caller's records (LP4-05 PR C, `CursorPage`): the filters
   * AND-combined inside the caller's CURRENT access, which every page
   * re-applies — the cursor carries only the last row's sort key and a digest
   * of the request it belongs to, so it never authorises a read.
   */
  async listPage(
    user: RequestUser,
    query: ActivityRecordPageQueryDto,
  ): Promise<CursorPage<ActivityRecordPageItemDTO>> {
    const limit = pageLimit(query.limit);
    const sort = RECORD_SORTS[query.sort ?? DEFAULT_ACTIVITY_RECORD_SORT];
    const filters = normaliseRecordFilters(query);
    const binding = cursorBinding(sort, filters);
    // Decoded before the scope is known, so a cursor's acceptance depends only
    // on the cursor and the request — never on what the caller may see.
    const after = query.cursor !== undefined ? decodeCursor(sort, binding, query.cursor) : null;
    const scoped = recordFilterWhere(user, filters);
    if (!scoped) return { items: [], limit, nextCursor: null };
    const where = await this.withAwaitingDecision(user, filters, scoped);
    if (!where) return { items: [], limit, nextCursor: null };

    const rows = await this.prisma.activityRecord.findMany({
      where: after ? { AND: [where, keysetWhere(sort, after) as Prisma.ActivityRecordWhereInput] } : where,
      orderBy: keysetOrderBy(sort) as Prisma.ActivityRecordOrderByWithRelationInput[],
      take: limit + 1,
      include: {
        _count: { select: { evidenceLinks: true } },
        location: { select: { name: true } },
      },
    });
    const page = rows.slice(0, limit);
    // One query each for the page's lock flags and its actors, never one per row.
    const locked = await closedRecordIds(this.prisma, page);
    const actors = await this.actorsFor(user, page);
    const fuelRecords = await this.fuelRecordsFor(user, page);
    // Two queries for the whole page (its authors, its companies), never one per row.
    const approvers = await approversFor(this.prisma, page);
    // One query for the page's reporting entities, never one per row.
    const reportingNames = await reportingNamesFor(this.prisma, user.organisationId, page);
    return toCursorPage(
      rows,
      limit,
      sort,
      binding,
      (r) => sort.keys.map((k) => r[k.field as 'createdAt' | 'submittedAt' | 'id']),
      (r) => ({ ...this.toDTO(r, r._count.evidenceLinks, actors, fuelRecords, approvers, reportingNames), periodLocked: locked.has(r.id) }),
    );
  }

  /**
   * The size and newest year of the whole filtered set, never of one page.
   * Counting stops at the work budget: a set larger than it is 422
   * `query_too_broad` with no partial count — computed only inside the
   * caller's access, where an inaccessible filter is an empty set.
   */
  async metadata(
    user: RequestUser,
    query: ActivityRecordFiltersQueryDto,
  ): Promise<ActivityRecordListMetadataDTO> {
    const filters = normaliseRecordFilters(query);
    const scoped = recordFilterWhere(user, filters);
    const where = scoped && (await this.withAwaitingDecision(user, filters, scoped));
    if (!where) return { total: 0, latestReportingYear: null };
    const budget = this.limits.ACTIVITY_RECORD_METADATA_MAX_ROWS;
    const total = await this.prisma.activityRecord.count({ where, take: budget + 1 });
    if (total > budget) throw new QueryTooBroadError();
    if (total === 0) return { total: 0, latestReportingYear: null };
    const latest = await this.prisma.activityRecord.aggregate({ where, _max: { reportingYear: true } });
    return { total, latestReportingYear: latest._max.reportingYear };
  }

  async get(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    const [evidenceCount, actors, fuelRecords, approvers, reportingNames] = await Promise.all([
      this.prisma.activityRecordEvidence.count({ where: { activityRecordId: id } }),
      this.actorsFor(user, [record]),
      this.fuelRecordsFor(user, [record]),
      approversFor(this.prisma, [record]),
      reportingNamesFor(this.prisma, user.organisationId, [record]),
    ]);
    return this.toDTO(record, evidenceCount, actors, fuelRecords, approvers, reportingNames);
  }

  /** `scoped` narrowed to the pending records the caller decides, when the
   *  filter asks for it; null when that leaves nothing. */
  private async withAwaitingDecision(
    user: RequestUser,
    filters: RecordFilters,
    scoped: Prisma.ActivityRecordWhereInput,
  ): Promise<Prisma.ActivityRecordWhereInput | null> {
    if (!filters.awaitingMyDecision) return scoped;
    const mine = await awaitingDecisionWhere(this.prisma, user);
    return mine ? { AND: [scoped, mine] } : null;
  }

  /**
   * Everything `create` decides BEFORE it writes anything — the role gate, the
   * tenant gate, the canonical period spelling, the period-lock gate, the
   * calculation snapshot and the anomaly verdict — with no write and no audit
   * row of its own.
   *
   * Extracted so the bulk importer (WP8) can offer a dry-run that PROVABLY
   * persists nothing. The obvious alternative, running the batch inside a
   * rolled-back transaction, is not available here: each `create` is its own
   * short transaction (the lifecycle protocol, `lifecycle-lock.ts`), and
   * Prisma's interactive-transaction timeout would not survive a thousand-row
   * loop in one. A read-only seam is the mechanism the code actually
   * supports, and "no write happened" is then a claim a spec can assert
   * against the write spies rather than a claim about a rollback.
   *
   * It runs OUTSIDE `create`'s transaction, on purpose: the snapshot reads
   * factors and the anomaly baseline, none of which the period lock guards,
   * and a transaction that asked a second pooled connection for them could
   * starve the pool under load.
   *
   * It keeps the role gate deliberately, even though a bulk caller checks the
   * role once per batch: a security control that only runs on the path someone
   * remembered to guard is not a control.
   *
   * **It decides uniqueness only against what is stored now.** An exact repeat
   * of a live record answers `record_duplicate` (owner review of WP8), but a
   * concurrent insert and the slot-kind rule (`TA002`) are raised by Postgres on
   * the insert: a caller previewing a batch must still detect duplicates itself —
   * against the rows already stored AND against the rest of the file.
   *
   * **It costs four to five queries per call** (period lock, subsidiary,
   * optional location, emission factor, anomaly baseline), none of them cached.
   * At one call per row that is the constraint a bulk row cap is chosen
   * against, and the reason a batch caller should hoist what it can.
   *
   * Public rather than private because that IS the point of the extraction —
   * `create` is the only caller today, and the next one is outside this class.
   */
  async previewCreate(
    user: RequestUser,
    dto: CreateActivityRecordDto,
  ): Promise<{
    /**
     * The identities this method VALIDATED, returned rather than left for the
     * caller to re-read off its own input. `create` could re-read `dto` safely
     * because it holds the same object; a bulk importer assembling a write from
     * a row template could not, and an unvalidated `subsidiaryId` carrying a
     * snapshot that WAS validated is a cross-tenant write nothing downstream
     * re-checks. This class already warns about that shape 130 lines above:
     * upstream ordering is a convention, and a convention is not a mechanism.
     */
    subsidiaryId: string;
    locationId: string | null;
    periodValue: string;
    activityType: string | null;
    calculation: ActivityCalculationSnapshot;
    scope: number;
    verdict: AnomalyVerdict;
    /** The reporting entity the record would be stored with (D2): the
     *  caller's main company for a company of its central reporter grant,
     *  the company itself otherwise — the answer TA025 stores. */
    reportedBySubsidiaryId: string;
  }> {
    if (!mayAuthorRecords(user)) {
      throw new CreateRoleRefusedError();
    }
    // Tenant gate FIRST, before any query — `computeSnapshot` keeps its own
    // copy as the mechanism, but by the time it runs the period-lock lookup
    // has already asked the database about a subsidiary this caller may not be
    // able to see. That cost two things: a 409-vs-404 split that answers
    // "does this subsidiary exist and is that period closed" for another
    // tenant, and a malformed id reaching Prisma as a P2023, which the
    // exception filter turns into a 500. (The DTO now refuses a malformed id
    // and lowercases a well-formed one, so this compare is between two
    // lowercase spellings; the ordering still matters for a caller that
    // bypasses the pipe.) Every other service that takes a body
    // `subsidiaryId` already checks the set as its first statement.
    if (!user.accessibleSubsidiaryIds.includes(dto.subsidiaryId)) {
      throw new ResourceNotFoundError('subsidiary_not_found');
    }
    // A node closed to data entry — an associate or a sector group — takes no
    // record, whoever asks (inc26-group-tree, D6); after the tenant gate, so a
    // foreign id still answers as unknown. The database's TA019 holds the same
    // for every writer, under a row lock that closes the race with a tick.
    await this.assertEntityOpen(dto.subsidiaryId);
    // A standard user enters only in the categories ticked on its grant for
    // the company (INC-2.6 §1, §7.3) — after the role and scope checks.
    assertCategoryGranted(user, dto.subsidiaryId, dto.category);
    // Canonicalised, not merely validated. Everything downstream compares RAW
    // strings — the uniqueness index, both period-lock lookups, the seed's own
    // de-duplication key — so the spelling that gets stored IS the identity of
    // the month. Use it from here on; `dto.periodValue` is the user's spelling
    // and belongs only in the error message above.
    const periodValue = requireCanonicalPeriodValue(
      dto.reportingPeriod,
      dto.periodValue,
    );
    // A NEW record in a typed category names its fuel or gas (LP3-03). Records
    // written before LP3-03 stay untyped; no new one joins them.
    const activityType = dto.activityType ?? null;
    assertActivityTypeNamed(dto.category, activityType);
    assertRecordParameters(dto.category, dto.parameters);
    assertElectricitySupplier(dto.category, dto.input);
    // Period-lock gate (FR §4.2): no new records in a closed period. An early
    // answer only — `create` asks again once it holds the period.
    await this.assertPeriodNotLocked({
      subsidiaryId: dto.subsidiaryId,
      reportingYear: dto.reportingYear,
      reportingPeriod: dto.reportingPeriod,
      periodValue,
    });
    // The reporting entity and the period half of single entry (D2, D5), from
    // the access the guard read — no lock and no write: an early answer,
    // asked again inside `create` on the access as it is committed then.
    const reportedBySubsidiaryId = reportingEntityOf(accessRowsOf(user), dto.subsidiaryId);
    // An exact repeat answers as a duplicate first, as the bulk upload does.
    await assertNotExactDuplicate(this.prisma, {
      subsidiaryId: dto.subsidiaryId,
      locationId: dto.locationId ?? null,
      category: dto.category,
      reportingYear: dto.reportingYear,
      reportingPeriod: dto.reportingPeriod,
      periodValue,
      activityType,
    });
    await assertSingleEntryPeriod(this.prisma, partyOf(user.role, dto.subsidiaryId, reportedBySubsidiaryId), {
      subsidiaryId: dto.subsidiaryId,
      category: dto.category,
      reportingYear: dto.reportingYear,
      reportingPeriod: dto.reportingPeriod,
      periodValue,
    });

    const { calculation, scope } = await this.recordCalculation.computeSnapshot(
      dto.subsidiaryId,
      user.accessibleSubsidiaryIds,
      dto.category,
      dto.reportingYear,
      dto.activityValue,
      dto.activityUnit,
      dto.locationId,
      activityType,
      { reportingPeriod: dto.reportingPeriod, parameters: dto.parameters ?? null },
    );

    const verdict = await this.recordCalculation.detectAnomalyFor(calculation, {
      subsidiaryId: dto.subsidiaryId,
      locationId: dto.locationId ?? null,
      category: dto.category,
      activityType,
      reportingPeriod: dto.reportingPeriod,
      reportingYear: dto.reportingYear,
      periodValue,
    }, {
      activityValue: dto.activityValue,
      activityUnit: dto.activityUnit,
      parameters: dto.parameters ?? null,
    });

    return {
      subsidiaryId: dto.subsidiaryId,
      locationId: dto.locationId ?? null,
      periodValue,
      activityType,
      calculation,
      scope,
      verdict,
      reportedBySubsidiaryId,
    };
  }

  /**
   * `provenance` is a server-side argument only: the bulk importer passes the
   * batch a record came from. It is NOT on `CreateActivityRecordDto`, so no
   * request body can set it — `forbidNonWhitelisted` refuses an
   * `importBatchId` key with a 400 — and no update path ever writes it.
   */
  async create(
    user: RequestUser,
    dto: CreateActivityRecordDto,
    provenance?: { importBatchId: string },
  ): Promise<ActivityRecordDTO> {
    const { subsidiaryId, locationId, periodValue, activityType, calculation, scope, verdict } =
      await this.previewCreate(user, dto);
    const period: PeriodKey = {
      subsidiaryId,
      reportingYear: dto.reportingYear,
      reportingPeriod: dto.reportingPeriod,
      periodValue,
    };

    let created: ActivityRecord & { location: { name: string } | null } & FuelResolved;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        // A create has no row to lock, so the period lock is the whole of its
        // serialisation: a `lock` of this period either committed before this
        // point (and the check below sees it) or waits for this commit (and
        // then counts the new draft like any other record).
        await lockPeriodsShared(tx, [period]);
        await this.assertPeriodNotLocked(period, tx);
        // The author's standing as it is committed now (C10), locked until this
        // record commits: role, company and category judged again, and the
        // party worked out from the same rows TA025 will read.
        const access = await lockAuthorAccess(tx, user, subsidiaryId, dto.category, 'create');
        const reportingEntity = access ? reportingEntityOf(access, subsidiaryId) : subsidiaryId;
        await assertNotExactDuplicate(tx, {
          subsidiaryId, locationId, category: dto.category, reportingYear: dto.reportingYear,
          reportingPeriod: dto.reportingPeriod, periodValue, activityType,
        });
        await assertSingleEntryPeriod(tx, partyOf(user.role, subsidiaryId, reportingEntity), {
          subsidiaryId,
          category: dto.category,
          reportingYear: dto.reportingYear,
          reportingPeriod: dto.reportingPeriod,
          periodValue,
        });
        // The reporting entity is never written here: TA025 works it out.
        const row = await tx.activityRecord.create({
          // Same include as every other read path — the create response is what
          // the subsidiary create flow renders, and it must not claim the record
          // has no location seconds after being handed one.
          include: { location: { select: { name: true } } },
          data: {
            subsidiaryId,
            locationId,
            reportingYear: dto.reportingYear,
            reportingPeriod: dto.reportingPeriod,
            periodValue,
            category: dto.category,
            activityType,
            scope,
            status: ActivityRecordStatus.draft,
            anomalyFlag: verdict.anomalous,
            anomalyBaselinePriorCount: verdict.priorCount,
            anomalyBaselineTCo2e: verdict.baseline,
            activityValue: dto.activityValue,
            // The vocabulary's canonical spelling; the snapshot keeps the entered
            // one as `inputUnit` until the record is next edited. See `storedUnit`.
            activityUnit: storedUnit(dto.activityUnit),
            input: (dto.input ?? undefined) as Prisma.InputJsonValue | undefined,
            parameters: (dto.parameters ?? undefined) as Prisma.InputJsonValue | undefined,
            calculation: calculation as unknown as Prisma.InputJsonValue,
            createdBy: user.id,
            varianceReason: dto.varianceReason ?? null,
            importBatchId: provenance?.importBatchId ?? null,
          },
        });
        await this.auditCreateUpdateDelete(
          user,
          'create',
          row.id,
          { after: this.toAuditSnapshot(row) },
          tx,
        );
        return Object.assign(row, { fuelRecords: await this.fuelRecordsIn(tx, user, [row]) });
      }, LIFECYCLE_TX);
    } catch (e) {
      // Unique constraint (subsidiary, location, year, period, periodValue,
      // category) is a user-actionable conflict, not a server error.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new DuplicateActivityRecordError();
      }
      // The slot already holds the other kind (typed vs untyped) — LP3-03's
      // trigger, under its own advisory lock, so a concurrent pair cannot
      // both pass.
      if (recordTriggerCode(e) === 'TA002') {
        throw new ActivityTypeSlotConflictError(activityType !== null);
      }
      // TA019: the company was ticked associate after the early check.
      const closed = treeTriggerRefusal(e);
      if (closed) throw closed;
      // TA026: the other party's record committed meanwhile; TA025: the main
      // company was withdrawn meanwhile.
      const raced = recordCentralReportingRefusal(e, { category: dto.category, reportingYear: dto.reportingYear, periodValue });
      if (raced) throw raced;
      throw asLostRace(e);
    }
    return this.toDTO(
      created, 0, await this.actorsFor(user, [created]), created.fuelRecords, NO_APPROVERS,
      await reportingNamesFor(this.prisma, user.organisationId, [created]),
    );
  }

  /** The record gate of design D6: `holdsRecords` on the company named. */
  private async assertEntityOpen(subsidiaryId: string): Promise<void> {
    const node = await this.prisma.subsidiary.findUnique({
      where: { id: subsidiaryId },
      select: { nodeType: true, control: true },
    });
    if (node && !holdsRecords(node)) throw new EntityClosedToDataEntryError();
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateActivityRecordDto,
  ): Promise<ActivityRecordDTO> {
    const existing = await this.loadScoped(user, id);
    this.assertCanEdit(user, existing);
    assertSameVersion(existing, dto.seenUpdatedAt);

    // Resolve the effective values (dto overrides existing) so we can recompute.
    const category = (dto.category ?? existing.category) as Category;
    // Checked on the category the record would hold after the edit: a draft
    // cannot be re-filed under a category the author is not granted.
    assertCategoryGranted(user, existing.subsidiaryId, category);
    const reportingYear = dto.reportingYear ?? existing.reportingYear;
    const activityValue = dto.activityValue ?? existing.activityValue;
    const activityUnit = dto.activityUnit ?? existing.activityUnit;
    // `locationId` may be re-targeted (string), detached (null), or left as-is
    // (undefined) — distinguish "not provided" from an explicit null.
    const locationId =
      dto.locationId !== undefined ? dto.locationId : existing.locationId;
    // Likewise the activity type: set (string), cleared (null) or kept. Checked
    // against the EFFECTIVE category by the engine, so a diesel Fuel draft
    // re-filed as Electricity without clearing it is refused. A typed category
    // requires one unless this is a pre-LP3-03 untyped record staying in its
    // own category — the only untyped record a typed category may hold.
    const storedType = existing.activityType ?? null;
    const activityType = dto.activityType !== undefined ? dto.activityType : storedType;
    if (!(storedType === null && activityType === null && category === existing.category)) {
      assertActivityTypeNamed(category, activityType);
    }
    // Refused rather than cleared when a record moves category: the user clears
    // them by sending null, as with the activity type above.
    const parameters = ((dto.parameters !== undefined ? dto.parameters : existing.parameters) ?? null) as RecordParameters | null;
    // An edit that would change or remove a stored self-generation block must
    // name the version it was made on: a client that names none, such as a tab
    // from before the self-gen-model deploy or a script, cannot be shown to
    // have read the block, and must not erase it (self-gen-model review).
    if (dto.seenUpdatedAt === undefined && holdsSelfGeneration(existing) && !sameParameters(existing.parameters, parameters)) {
      throw new EditVersionRequiredError();
    }
    assertRecordParameters(category, parameters);
    // Only an edit that sends `input` can change the supplier.
    if (dto.input !== undefined) assertElectricitySupplier(category, dto.input, existing.input);

    const reportingPeriod = dto.reportingPeriod ?? existing.reportingPeriod;
    const periodValue = requireCanonicalPeriodValue(
      reportingPeriod,
      dto.periodValue ?? existing.periodValue,
    );
    const target: PeriodKey = {
      subsidiaryId: existing.subsidiaryId,
      reportingYear,
      reportingPeriod,
      periodValue,
    };
    const moves = !samePeriod(periodOf(existing), target);
    // Period-lock gate (FR §4.2): the record's current period must be open, and
    // it cannot be re-targeted INTO a locked period either. Early answers —
    // both are asked again under the lock below.
    await this.assertPeriodNotLocked(periodOf(existing));
    if (moves) await this.assertPeriodNotLocked(target);

    const { calculation, scope } = await this.recordCalculation.computeSnapshot(
      existing.subsidiaryId,
      user.accessibleSubsidiaryIds,
      category,
      reportingYear,
      activityValue,
      activityUnit,
      locationId,
      activityType,
      { reportingPeriod, parameters },
      // Enforce the category/unit map when the unit was chosen NOW **or when
      // the category changed**. The second half was missing and it was a live
      // path to a fabricated figure: a PATCH that sends only `{category}` left
      // the stored unit unchecked against the new category, so a 250 m³ WATER
      // reading re-filed as Electricity was normalised at the natural-gas
      // calorific value (×11.36) and multiplied by the grid factor — a fully
      // provenanced 2,840 kWh of electricity that no one ever measured. The
      // leniency exists for records predating the map being edited without
      // touching the unit; re-interpreting a stored unit under a different
      // category is the opposite of that case.
      dto.activityUnit !== undefined || category !== existing.category,
    );
    // A natural gas bill's inherited figure is kept only where it still means
    // the same thing (ng-kwh-engine reviews): a new unit or category reads it
    // at another scale or meaning (1,000 kWh as 1,000 MWh or as a volume), and
    // a stored NET bill moved to another site or basis could be priced as gross.
    // Asked after the scope, lock and calculation checks, so their answers keep
    // their order; before any write. `== null`: the DTO lets an explicit null
    // through, and it inherits the stored figure too.
    if (dto.activityValue == null && inheritsQuantityElsewhere(existing, { category, activityUnit, locationId, parameters })) {
      throw new ActivityValueReentryRequiredError();
    }

    const verdict = await this.recordCalculation.detectAnomalyFor(calculation, {
      subsidiaryId: existing.subsidiaryId,
      locationId,
      category,
      activityType,
      reportingPeriod,
      reportingYear,
      periodValue,
      excludeId: id, // the record's own row must not seed its baseline
    }, { activityValue, activityUnit, parameters });

    const data: Prisma.ActivityRecordUncheckedUpdateInput = {
      reportingYear,
      category,
      scope,
      activityValue,
      // Canonical spelling, as on create — but only when THIS edit named the
      // unit. An unrelated edit never rewrites a field nobody touched (the
      // `periodValue` rule below); rows stored before the rule are the
      // migration's job, not this write's.
      activityUnit:
        dto.activityUnit !== undefined
          ? storedUnit(dto.activityUnit)
          : existing.activityUnit,
      anomalyFlag: verdict.anomalous,
      anomalyBaselinePriorCount: verdict.priorCount,
      anomalyBaselineTCo2e: verdict.baseline,
      calculation: calculation as unknown as Prisma.InputJsonValue,
    };
    // The site as its own column, never the relation's connect/disconnect:
    // the site key is (location_id, subsidiary_id) since LP4-01, and Prisma's
    // relation writes set both columns — `disconnect` would NULL the
    // subsidiary too (P2011), `connect` would copy the site's subsidiary onto
    // the record. Written alone, the key holds the site to the record's own
    // subsidiary (P2003 below) even if the site moved after the check above.
    if (dto.locationId !== undefined) data.locationId = dto.locationId;
    if (dto.reportingPeriod !== undefined) data.reportingPeriod = dto.reportingPeriod;
    if (dto.activityType !== undefined) data.activityType = dto.activityType;
    // The canonical spelling, not the caller's. Gated on the caller having
    // SENT one, so an unrelated edit never rewrites a field nobody touched —
    // that would put a change into the audit diff that the user did not make.
    if (dto.periodValue !== undefined) data.periodValue = periodValue;
    if (dto.input !== undefined) {
      data.input = (dto.input ?? Prisma.JsonNull) as Prisma.InputJsonValue;
    }
    // SQL NULL, not JSON null: the shape CHECK and every reader mean "no
    // parameters" by the column being NULL.
    if (dto.parameters !== undefined) {
      data.parameters = dto.parameters === null
        ? Prisma.DbNull
        : (dto.parameters as unknown as Prisma.InputJsonValue);
    }
    if (dto.varianceReason !== undefined) data.varianceReason = dto.varianceReason;

    // BUG-R2-03 (owner decision D1): the files this edit takes off the record.
    const detachIds = [...new Set(dto.detachEvidenceIds ?? [])];
    const changesCategory = category !== existing.category;

    let updated: WrittenRecord & FuelResolved;
    let evidenceCount: number;
    let removedFiles: { id: string; storagePath: string }[];
    try {
      ({ row: updated, evidenceCount, removedFiles } = await this.withLockedRecord(
        existing,
        async (tx, current) => {
          // Everything above was computed from `existing` — the snapshot, the
          // verdict, the audit "before". If the row changed since, writing it
          // would overwrite a change this edit's author never saw (F03: a
          // stale edit landing on a record someone else had already
          // submitted). No partial re-check can save it; the caller reloads.
          if (changedSince(existing, current)) throw new RecordChangedError();
          await this.assertPeriodNotLocked(periodOf(current), tx);
          if (moves) await this.assertPeriodNotLocked(target, tx);
          // An edit that moves a draft to another category or period meets
          // the period half of single entry (D5): the record's own party — by
          // its stored reporting entity and its author, who is the editor.
          // The author's standing as it is committed now (C10; owner's reviews
          // of WP8, P1): a role, company or category changed after the request
          // was authorised is not written to — the same judgement a create makes.
          // Only the author edits (assertCanEdit).
          await lockAuthorAccess(tx, user, current.subsidiaryId, category, 'edit');
          if (moves || changesCategory) {
            await assertNotExactDuplicate(tx, {
              subsidiaryId: current.subsidiaryId, locationId, category, reportingYear, reportingPeriod, periodValue, activityType,
            }, current.id);
            await assertSingleEntryPeriod(tx, recordParty(current, user.role), {
              subsidiaryId: current.subsidiaryId, category, reportingYear, reportingPeriod, periodValue,
            }, current.id);
          }
          // The record's files, read under its row lock: an upload linking a
          // file checks the link's key with FOR KEY SHARE on this row, which
          // the lock blocks, so the set cannot grow before this commits.
          const linked = await this.evidence.fileIdsFor(current.id, tx);
          const linkedSet = new Set(linked);
          if (detachIds.some((fileId) => !linkedSet.has(fileId))) {
            throw new ResourceNotFoundError('evidence_not_found');
          }
          // A file filed under the old category cannot evidence the new one,
          // and only the user may decide to delete it: the request must name
          // them all. Refused before anything is written.
          if (changesCategory && linked.some((fileId) => !detachIds.includes(fileId))) {
            throw new EvidenceDetachRequiredError(linked.length);
          }
          const row = await tx.activityRecord.update({
            where: { id, status: current.status },
            data,
            include: WRITTEN_RECORD_INCLUDE,
          });
          // Records before files, the protocol's order: the row is locked
          // above, the files are locked inside the helper.
          const gone = await this.evidence.detachLinksInTx(tx, user, id, detachIds);
          const count = linked.length - detachIds.length;
          await this.auditCreateUpdateDelete(
            user,
            'update',
            id,
            {
              before: this.toAuditSnapshot(current),
              after: this.toAuditSnapshot(row, count),
              ...(detachIds.length > 0
                ? { evidence: { detachedFileIds: detachIds, deletedFileIds: gone.map((f) => f.id) } }
                : {}),
            },
            tx,
          );
          return {
            row: Object.assign(row, { fuelRecords: await this.fuelRecordsIn(tx, user, [row]) }),
            evidenceCount: count,
            removedFiles: gone,
          };
        },
        moves ? [target] : [],
      ));
    } catch (e) {
      // Re-targeting can collide with an existing record for the new entity.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new DuplicateActivityRecordError();
      }
      // The only key this update can break: the site no longer belongs to the
      // record's subsidiary — the answer the check above gives.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new ResourceNotFoundError('location_not_found');
      }
      const trigger = recordTriggerCode(e);
      if (trigger === 'TA002') throw new ActivityTypeSlotConflictError(activityType !== null);
      if (trigger === 'TA001') throw new SnapshotImmutableError();
      // TA026: the other party's record for the target period committed meanwhile.
      const raced = recordCentralReportingRefusal(e, { category, reportingYear, periodValue });
      if (raced) throw raced;
      throw e;
    }
    // Only the files that went with the commit; their rows are already gone.
    await this.evidence.removeBlobs(removedFiles.map((f) => f.storagePath));
    return this.toDTO(
      updated, evidenceCount, await this.actorsFor(user, [updated]), updated.fuelRecords, NO_APPROVERS,
      await reportingNamesFor(this.prisma, user.organisationId, [updated]),
    );
  }

  async remove(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const existing = await this.loadScoped(user, id);
    this.assertCanDelete(user, existing);
    // Period-lock gate (FR §4.2): no deletions in a closed period. An early
    // answer; asked again under the lock.
    await this.assertPeriodNotLocked(periodOf(existing));
    // The record's evidence LINKS go by themselves — ON DELETE CASCADE — but a
    // file can back other records too (WP8 PR7), so only the files this record
    // was the last to hold are deleted, rows and blobs, once the links are
    // gone. Skip that and the invoices outlive every pointer to them, which is
    // a retention problem, not wasted disk.
    //
    // The file ids are read under the record's row lock. An upload linking a
    // file to it checks the link's foreign key with FOR KEY SHARE on this row,
    // which FOR UPDATE blocks: the link either committed first and is read
    // here, or fails after the delete. Without the lock an upload landing
    // between the read and the delete left a file no record held — measured,
    // 7 of 24 racing pairs. The files are then locked too (records before
    // files, the protocol's order), so a concurrent detach of the same file
    // from another record cannot leave it with no link and no owner to delete
    // it; and the file rows go in this transaction, so the one audit row that
    // names them commits with them. Only their blobs wait for the commit.
    const deleted = await this.withLockedRecord(existing, async (tx, current) => {
      regate(existing, current, () => this.assertCanDelete(user, current));
      await this.assertPeriodNotLocked(periodOf(current), tx);
      const fileIds = await this.evidence.fileIdsFor(current.id, tx);
      await lockEvidenceRows(tx, fileIds);
      await tx.activityRecord.delete({ where: { id: current.id } });
      const gone = await this.evidence.deleteUnlinkedRows(fileIds, tx);
      await this.auditCreateUpdateDelete(
        user,
        'delete',
        current.id,
        {
          before: this.toAuditSnapshot(current, fileIds.length),
          evidence: { fileIds, deletedFileIds: gone.map((f) => f.id) },
        },
        tx,
      );
      return gone;
    });
    await this.evidence.removeBlobs(deleted.map((f) => f.storagePath));
    return { id: existing.id, deleted: true };
  }

  // --- Workflow transitions --------------------------------------------------
  //
  // Each one reads the record (404 / tenant), checks the caller's role, then
  // runs its state gates and its write inside `withLockedRecord`: against the
  // row as locked, never as first read. A status gate that fails only because
  // someone else moved the record first answers `RecordChangedError` (409).
  //
  // Submit and approve also hold K11 (LP4-02 B2): nothing commits a figure the
  // engine would not compute now from the record's stored inputs. The
  // recompute runs between the role check and the lock; its verdict is read
  // inside the lock after the record's own gates — tenant, role, status,
  // author, period, evidence — so a stale figure never answers for any of
  // them (a foreign id stays a 404, "LP4-02 follow-ups" (1)), and before the
  // anomaly gate, which reads the figure. Just before it, C8: a typed
  // category's record names its activity type before it is committed.

  async submit(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const seen = await this.loadScoped(user, id);
    if (!mayAuthorRecords(user)) {
      throw new SubmitRoleRefusedError();
    }
    const recomputed = await this.recordCalculation.recompute(user.accessibleSubsidiaryIds, seen);
    const updated = await this.withLockedRecord(seen, async (tx, record) => {
      regate(seen, record, () => {
        if (!SUBMITTABLE_STATUSES.has(record.status)) {
          throw new BadRequestException(
            errorBody(
              'record_not_submittable',
              `Only a draft or returned record can be submitted (current status "${record.status}")`,
              { status: record.status },
            ),
          );
        }
        // Only the author submits (decision D02, 2026-09-29) — a draft as much
        // as a rejected record, and `masterkey` is not exempt. Resubmitting
        // REVERSES a reviewer's decision, and submitting at all moves a
        // colleague's half-finished figure out of their hands into review. It
        // is also what makes the submitter always the creator, which the
        // approval gate (D01) relies on.
        if (record.createdBy !== user.id) {
          throw new SubmitAuthorRefusedError(
            record.status === ActivityRecordStatus.rejected,
          );
        }
      });
      // A category withdrawn since the draft was made stops its submit (the
      // author can still recall or delete it): on the row as locked.
      assertCategoryGranted(user, record.subsidiaryId, record.category);
      // Period-lock gate (FR §4.2): no submissions into a closed period.
      await this.assertPeriodNotLocked(periodOf(record), tx);
      // Evidence gate (FR §4.1 / §5.4): categories configured as evidence-required
      // cannot be submitted without at least one supporting file.
      // The count is only worth a query when the category could need one, so the
      // short-circuit stays here; the RULE over the two values is the contract's,
      // shared with the checkbox the client offers, because it has already been
      // copied wrongly once. Counted under the row lock: a detach must take the
      // same lock to remove a link, so the file counted here is still attached
      // when the status changes.
      const evidenceCount = isEvidenceRequired(record.category)
        ? await tx.activityRecordEvidence.count({ where: { activityRecordId: id } })
        : 0;
      if (needsEvidenceBeforeSubmit({ category: record.category, evidenceCount })) {
        throw new EvidenceRequiredError(record.category);
      }
      // C8: a typed category's record is committed only once it names its
      // fuel or gas. A pre-LP3-03 record may be edited untyped, and a direct
      // writer may insert one; neither is submitted so. Before K11, so the
      // answer names the remedy — choose the type — not "save again".
      assertActivityTypeNamed(record.category, record.activityType ?? null);
      // K11: the figure the anomaly gate reads, and the one this submit hands
      // to review, is the one the engine gives now — or nothing moves.
      this.assertFresh('submit', seen, record, recomputed);
      // Anomaly gate (VAR §2.2 / §4.3 / §8): re-evaluate against the baseline as of
      // submit time — a comparable period may have been committed since the draft
      // was saved. The API is the final enforcement layer, so it recomputes rather
      // than trusting the write-time flag, and persists the fresh value.
      // A record with no calculated figure is not comparable to anything, so it
      // is not evaluated at all. Passing 0 instead — which is what a naive
      // `?? 0` does — reads as a 100% drop against any real baseline and would
      // block the submit demanding a variance comment for a value that was never
      // computed. Harmless while a category is uniformly factor-less, and a live
      // bug the day a factor lands mid-year and the priors become calculable.
      const calc = record.calculation as unknown as ActivityCalculationSnapshot;
      const verdict = await this.recordCalculation.detectAnomalyFor(
        calc,
        {
          subsidiaryId: record.subsidiaryId,
          locationId: record.locationId,
          activityType: record.activityType,
          category: record.category,
          reportingPeriod: record.reportingPeriod,
          reportingYear: record.reportingYear,
          periodValue: record.periodValue,
          excludeId: record.id,
        },
        {
          activityValue: record.activityValue,
          activityUnit: record.activityUnit,
          parameters: record.parameters ?? null,
        },
        tx,
      );
      if (verdict.anomalous && !record.varianceReason?.trim()) {
        throw new VarianceReasonRequiredError(varianceBasisOf(verdict));
      }
      // The note is deliberately KEPT. Clearing it on resubmit was the first cut,
      // and it was wrong twice over: `reviewedBy`/`reviewedAt` survived anyway, so
      // the review stamp was only half-cleared, and it dead-coded the reviewer
      // sheet's "Previous review note" — a consultant re-reviewing a bounced-back
      // record would see something indistinguishable from a first submission. The
      // stale-note problem it was meant to solve is a RENDERING one, fixed where
      // it belongs: `/emissions` shows the note only on a `rejected` record.
      // The verdict travels whole: the flag and the window it was taken against
      // are one fact, and `transition` takes them as one argument so that
      // persisting a flag beside a window nobody can name is not expressible.
      return this.transition(tx, user, record, ActivityRecordStatus.submitted, { verdict });
    });
    return this.writtenDTO(user, updated);
  }

  /**
   * Recall a submitted record to `draft` (BUG-R2-03, decision 2026-11-10
   * (fourth), 1): its author takes it back before review starts, edits it and
   * submits it again. Only from `submitted` — once a reviewer has taken it into
   * review, the reviewer returns it (reject), so nobody approves a figure that
   * changed while they were looking at it. Only the author, `masterkey`
   * included, as with submit (D02).
   *
   * The inputs and the figure do not change: the database freezes them on
   * this step too (`activity_records_snapshot_immutable` tests OLD.status).
   * `submittedAt` is cleared (a draft has not been submitted); the review
   * note and the anomaly verdict are kept, as a resubmit keeps them. Races
   * with `startReview`, `approve` and `reject` are settled by the row lock:
   * whichever locks first wins, and the other sees a status it cannot act on.
   */
  async recall(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const seen = await this.loadScoped(user, id);
    if (!mayAuthorRecords(user)) {
      throw new ForbiddenException(
        'Your role may not modify activity records',
      );
    }
    const updated = await this.withLockedRecord(seen, async (tx, record) => {
      regate(seen, record, () => {
        if (!isRecallable(record.status)) {
          throw new RecordNotRecallableError(record.status);
        }
        if (record.createdBy !== user.id) {
          throw new AuthorOnlyRefusedError('recall');
        }
      });
      await this.assertPeriodNotLocked(periodOf(record), tx);
      return this.transition(tx, user, record, ActivityRecordStatus.draft);
    });
    return this.writtenDTO(user, updated);
  }

  /**
   * Take a submitted record into review (FR §6.3): submitted → under_review.
   * Marks that a reviewer is actively looking at it; approve/reject remain the
   * only exits. Same reviewer RBAC + period-lock gate as approve/reject.
   */
  /**
   * `seenSubmittedAt`, when named, is the submission the reviewer is looking
   * at: one recalled and resubmitted since is refused as `record_changed`, so
   * a reason typed for it never reaches the newer one (self-gen-form, outside
   * review of `b8b0d78b`). Optional, unlike a decision's: a client that names
   * none still takes the record into review, which decides nothing.
   */
  async startReview(user: RequestUser, id: string, seenSubmittedAt?: string | null): Promise<ActivityRecordDTO> {
    // The role refusal comes before every other answer (record-lifecycle spec):
    // a role that decides nothing is refused even for a record it cannot read.
    if (!can(user.role, 'record.decide')) {
      throw new ForbiddenException(
        'Only a masterkey or a super_admin may review records',
      );
    }
    const seen = await this.loadScoped(user, id);
    const updated = await this.withLockedRecord(seen, async (tx, record) => {
      regate(seen, record, () => {
        if (record.status !== ActivityRecordStatus.submitted) {
          throw new BadRequestException(
            errorBody(
              'record_not_reviewable',
              `Only a submitted record can be taken into review (current status "${record.status}")`,
              { status: record.status },
            ),
          );
        }
        assertSameSubmission(record, seenSubmittedAt);
      });
      // The approver check (INC-2.6 §1.1), on the row as locked, after the role
      // gate and the re-gate, before anything is written: a non-masterkey
      // author is refused `self_review_forbidden` (WP5), anyone but the
      // record's approver `not_record_approver`.
      const decider = await deciderFor(tx, user, record, 'review');
      await this.assertPeriodNotLocked(periodOf(record), tx);
      return this.transition(tx, decider, record, ActivityRecordStatus.under_review);
    });
    return this.writtenDTO(user, updated);
  }

  async approve(user: RequestUser, id: string, seenSubmittedAt?: SeenSubmission): Promise<ActivityRecordDTO> {
    // The role refusal comes before every other answer (record-lifecycle spec):
    // a role that decides nothing is refused even for a record it cannot read.
    if (!can(user.role, 'record.decide')) {
      throw new ForbiddenException('Only a masterkey or a super_admin may approve records');
    }
    const seen = await this.loadScoped(user, id);
    assertSubmissionNamed(seenSubmittedAt);
    const recomputed = await this.recordCalculation.recompute(user.accessibleSubsidiaryIds, seen);
    const updated = await this.withLockedRecord(seen, async (tx, record) => {
      regate(seen, record, () => {
        if (
          record.status !== ActivityRecordStatus.submitted &&
          record.status !== ActivityRecordStatus.under_review
        ) {
          throw new BadRequestException(
            errorBody(
              'record_not_approvable',
              `Only a submitted or under_review record can be approved (current status "${record.status}")`,
              { status: record.status },
            ),
          );
        }
        assertSameSubmission(record, seenSubmittedAt);
      });
      // Who approves (INC-2.6 §1.1): segregation of duties (D01) for every
      // author but a masterkey — `self_approval_forbidden`, whatever role the
      // author held when creating it — and then only the record's approver
      // (`not_record_approver`). A masterkey approving their own record is a
      // self-approval, logged as such by `transition`. Only the author may
      // submit, so the submitter IS the creator and one comparison covers both.
      const decider = await deciderFor(tx, user, record, 'approve');
      // Period-lock gate (defense-in-depth): no review transitions in a closed
      // period.
      await this.assertPeriodNotLocked(periodOf(record), tx);
      // K3, as at submit and in the same place in the order: a record of an
      // evidence-required category submitted before its category needed a file
      // (Mobile Combustion, Refrigerants, Fugitive Gas until 2026-11-10) is not
      // approved without one. No exemption by date or audit row — both are
      // forgeable (C8's decision). Counted under the row lock; a detach is
      // refused once the record is submitted, so the count holds.
      const evidenceCount = isEvidenceRequired(record.category)
        ? await tx.activityRecordEvidence.count({ where: { activityRecordId: record.id } })
        : 0;
      if (needsEvidenceBeforeSubmit({ category: record.category, evidenceCount })) {
        throw new ApprovalEvidenceMissingError(record.category);
      }
      // C8, as at submit: an untyped record of a typed category — one
      // submitted before the rule — is returned to its author to name its type.
      assertActivityTypeNamed(record.category, record.activityType ?? null);
      // K11: a factor release published or withdrawn since the submit, or a
      // figure rewritten outside the API, is refused here — the reviewer
      // returns the record and its author saves it again (L4).
      this.assertFresh('approve', seen, record, recomputed);
      // Clear any earlier rejection note: an approved record showing last
      // round's rejection reason would misread as "approved, but rejected".
      return this.transition(tx, decider, record, ActivityRecordStatus.approved, {
        reviewNote: null,
      });
    });
    return this.writtenDTO(user, updated);
  }

  /**
   * Withdraw an APPROVED figure from the inventory — the revision elements FR §4.3 requires.
   *
   * `approved` and `locked` are immutable, and that is correct: a figure a
   * reviewer accepted must not be quietly edited away. But it left a record
   * entered in error with no exit at all — update, remove, submit, review,
   * approve and reject all refuse both statuses, and `masterkey` does not
   * override it, because `assertCanEdit` checks role and status
   * independently. Deleting was the only remedy and the API refuses that too.
   *
   * So this does not delete. The row stays, keeps its immutable calculation
   * snapshot, and simply stops counting — `voided` is absent from
   * `COUNTED_STATUSES`, so every total, export, matrix cell and anomaly
   * baseline excludes it by construction rather than by a filter each call site
   * has to remember.
   *
   * A masterkey only (`record.void`), narrower than `record.decide` on
   * purpose: a super_admin may return or approve a record of their company,
   * but removing an accepted figure from the reported inventory is the
   * organisation-wide administrator's decision (INC-2.6 ruling R4).
   *
   * The pilot's correction procedure (decision D04, 2026-09-29) is an audited
   * unlock → void → re-entry: the voided row leaves the uniqueness index, so
   * the corrected figure is a new record in the same slot.
   */
  async void(
    user: RequestUser,
    id: string,
    reason: string,
  ): Promise<ActivityRecordDTO> {
    const seen = await this.loadScoped(user, id);
    if (!can(user.role, 'record.void')) {
      throw new ForbiddenException('Only a masterkey may void records');
    }
    const updated = await this.withLockedRecord(seen, async (tx, record) => {
      regate(seen, record, () => {
        if (record.status !== ActivityRecordStatus.approved) {
          // Deliberately `approved` alone. A `locked` record sits in a closed
          // period, and reopening one already has its own audited path (unlock);
          // letting a void bypass that would make the lock a suggestion. Draft and
          // rejected records can simply be deleted, and submitted/under_review ones
          // rejected — none of them needs this.
          throw new BadRequestException(
            errorBody(
              'record_not_voidable',
              `Only an approved record can be voided (current status "${record.status}"). ` +
                'A locked period must be unlocked first.',
              { status: record.status },
            ),
          );
        }
      });
      // Defense-in-depth, and not redundant with the status check: a lock is
      // precisely the statement that this period's figures are closed.
      await this.assertPeriodNotLocked(periodOf(record), tx);
      return this.transition(tx, user, record, ActivityRecordStatus.voided, {
        voidReason: reason,
      });
    });
    return this.writtenDTO(user, updated);
  }

  async reject(
    user: RequestUser,
    id: string,
    varianceReason: string,
    seenSubmittedAt?: SeenSubmission,
  ): Promise<ActivityRecordDTO> {
    // The role refusal comes before every other answer (record-lifecycle spec):
    // a role that decides nothing is refused even for a record it cannot read.
    if (!can(user.role, 'record.decide')) {
      throw new ForbiddenException(
        'Only a masterkey or a super_admin may return records',
      );
    }
    const seen = await this.loadScoped(user, id);
    assertSubmissionNamed(seenSubmittedAt);
    const updated = await this.withLockedRecord(seen, async (tx, record) => {
      regate(seen, record, () => {
        if (
          record.status !== ActivityRecordStatus.submitted &&
          record.status !== ActivityRecordStatus.under_review
        ) {
          throw new BadRequestException(
            errorBody(
              'record_not_rejectable',
              `Only a submitted or under_review record can be returned (current status "${record.status}")`,
              { status: record.status },
            ),
          );
        }
        assertSameSubmission(record, seenSubmittedAt);
      });
      // Returning belongs to the record's approver too (INC-2.6 §1.1, §1.2).
      const decider = await deciderFor(tx, user, record, 'reject');
      // Period-lock gate (defense-in-depth): symmetric with approve.
      await this.assertPeriodNotLocked(periodOf(record), tx);
      // The reviewer's reason goes in reviewNote — overwriting varianceReason
      // would destroy the author's own anomaly justification (VAR §4).
      return this.transition(tx, decider, record, ActivityRecordStatus.rejected, {
        reviewNote: varianceReason,
      });
    });
    return this.writtenDTO(user, updated);
  }

  /**
   * Which status a transition lands on decides the audit action. Before WP7
   * every transition logged `update` with the real move buried in the diff,
   * which made the audit trail unreadable and unfilterable.
   */
  private static readonly TRANSITION_ACTIONS: Record<string, AuditAction> = {
    [ActivityRecordStatus.submitted]: 'submit',
    // The only transition INTO draft: the author's recall (BUG-R2-03).
    [ActivityRecordStatus.draft]: 'recall',
    [ActivityRecordStatus.under_review]: 'review',
    [ActivityRecordStatus.approved]: 'approve',
    [ActivityRecordStatus.rejected]: 'reject',
    [ActivityRecordStatus.voided]: 'void',
  };

  /**
   * Every record write's audit row, through the write's own transaction
   * client: the row and the change commit together or not at all (F02).
   */
  private async auditCreateUpdateDelete(
    user: RequestUser,
    action: 'create' | 'update' | 'delete',
    entityId: string,
    // NOT `Record<string, unknown>`. That bag let a resolved name be added at a
    // CALL SITE rather than inside the mapper — `before: { ...this.toAuditSnapshot(x),
    // createdByName: 'Eda Entry' }` compiled clean and passed the whole suite,
    // and `audit_log` has no correction path. Typed, the same line is TS2561.
    diff: {
      before?: ActivityRecordAuditSnapshot;
      after?: ActivityRecordAuditSnapshot;
      /** A delete's evidence: every file the record held, and those it was the
       *  last to hold, deleted with it. The record's row is the only audit row
       *  a record delete writes, so this is the only trace of those files.
       *  An edit's (BUG-R2-03): the files it took off the record and those it
       *  deleted — each also has its own `detach` or `delete` row. */
      evidence?:
        | { fileIds: string[]; deletedFileIds: string[] }
        | { detachedFileIds: string[]; deletedFileIds: string[] };
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await this.audit.record(user, { action, entity: 'activity_record', entityId, diff }, tx);
  }

  /** The response for a committed write: resolved actor names, after the transaction. */
  private async writtenDTO(user: RequestUser, row: WrittenRecord & FuelResolved): Promise<ActivityRecordDTO> {
    const [actors, approvers, reportingNames] = await Promise.all([
      this.actorsFor(user, [row]),
      approversFor(this.prisma, [row]),
      reportingNamesFor(this.prisma, user.organisationId, [row]),
    ]);
    return this.toDTO(row, row._count.evidenceLinks, actors, row.fuelRecords, approvers, reportingNames);
  }

  /**
   * Apply a status change + optional field patch to the LOCKED row, and audit
   * it, through the caller's transaction.
   */
  private async transition(
    tx: Prisma.TransactionClient,
    user: RequestUser,
    record: ActivityRecord,
    status: ActivityRecordStatus,
    extra: {
      varianceReason?: string;
      /** The whole verdict or none of it. Three independent optionals let a
       *  caller persist a flag beside a window nobody can name — which the
       *  submit path's own comment forbids, and which a type can enforce. */
      verdict?: AnomalyVerdict;
      reviewNote?: string | null;
      voidReason?: string;
    } = {},
  ): Promise<WrittenRecord & FuelResolved> {
    // A review outcome records WHO decided and WHEN, so the reviewer screen
    // does not have to reconstruct it from the audit log.
    const isReviewOutcome =
      status === ActivityRecordStatus.approved ||
      status === ActivityRecordStatus.rejected ||
      status === ActivityRecordStatus.under_review;
    // a revision entry needs three things recorded for a withdrawal — reason, actor,
    // timestamp — and they are stamped here for the same reason a review
    // outcome is: so the screen does not have to reconstruct them from the
    // audit log, and so a row carries its own provenance.
    const isVoid = status === ActivityRecordStatus.voided;

    // `record` is the row as LOCKED, so its status is the one this write moves
    // from — the audit row's `from` cannot name a state the record had already
    // left (F03: a late startReview once wrote `submitted → under_review` over
    // an approval). The expected status stays in the WHERE as well, as a
    // compare-and-set behind the lock: it cannot miss under the protocol, and
    // if a writer ever bypasses the protocol it turns that writer's damage
    // into this request's 409 (P2025, mapped by `withLockedRecord`).
    //
    // WP5: which submission this is. The column, or the record's own submit
    // audit rows when they say more: a submit made by an image from before the
    // column (the deploy window) wrote a row but raised nothing, and the next
    // submit must not name itself as a submission already in the trail. The
    // rows counted are the two shapes the migration's backfill counts: `submit`,
    // and a pre-taxonomy `update` moving to `submitted`. Read under the record
    // lock, in the write's transaction.
    const submission =
      status === ActivityRecordStatus.submitted
        ? Math.max(
            record.submissionCount,
            await tx.auditLog.count({ where: submitRowsOf(record.id, user.organisationId) }),
          ) + 1
        : null;
    const updated = await tx.activityRecord.update({
      where: { id: record.id, status: record.status },
      data: {
        status,
        ...(extra.varianceReason !== undefined
          ? { varianceReason: extra.varianceReason }
          : {}),
        ...(extra.verdict !== undefined
          ? {
              anomalyFlag: extra.verdict.anomalous,
              anomalyBaselinePriorCount: extra.verdict.priorCount,
              anomalyBaselineTCo2e: extra.verdict.baseline,
            }
          : {}),
        ...(extra.reviewNote !== undefined ? { reviewNote: extra.reviewNote } : {}),
        ...(isReviewOutcome ? { reviewedBy: user.id, reviewedAt: new Date() } : {}),
        // EVERY submit, not just the first. A resubmit after a rejection starts
        // the reviewer's clock again, which is what the queue measures; the
        // per-attempt history stays in `audit_log`. Same shape as `reviewedAt`
        // directly above, deliberately — two fields answering "most recently,
        // when" should not disagree about what "most recently" means.
        // WP5: the count of submissions, set in this same compare-and-set
        // update, so a lost race writes nothing and a bulk submit counts each
        // record through the submit it calls per id. Nothing else changes it.
        ...(submission !== null ? { submittedAt: new Date(), submissionCount: submission } : {}),
        // A recalled record is a draft again: it is not in the review queue,
        // and the queue's clock starts afresh at its next submit (BUG-R2-03).
        ...(status === ActivityRecordStatus.draft ? { submittedAt: null } : {}),
        ...(isVoid
          ? {
              voidReason: extra.voidReason,
              voidedBy: user.id,
              voidedAt: new Date(),
            }
          : {}),
      },
      include: WRITTEN_RECORD_INCLUDE,
    });
    await this.audit.record(
      user,
      {
        // A masterkey approving their own record (the only author who reaches
        // that line) is a self-approval, its own action (INC-2.6 §1.1).
        action:
          status === ActivityRecordStatus.approved && record.createdBy === user.id
            ? 'self_approve'
            : (ActivityRecordsService.TRANSITION_ACTIONS[status] ?? 'update'),
        entity: 'activity_record',
        entityId: record.id,
        diff: {
          transition: { from: record.status, to: status },
          // Which submission this is (WP5): the count after this write, and
          // the author's variance reason as it went for review — the record's
          // own, which the anomaly gate required before the submit; written
          // here so the record's history shows it on the submit itself.
          ...(submission !== null
            ? {
                submission: updated.submissionCount,
                ...(extra.varianceReason === undefined && updated.varianceReason
                  ? { varianceReason: updated.varianceReason }
                  : {}),
              }
            : {}),
          ...(extra.reviewNote !== undefined ? { reviewNote: extra.reviewNote } : {}),
          ...(extra.varianceReason !== undefined
            ? { varianceReason: extra.varianceReason }
            : {}),
          // A void takes a figure OUT of the inventory, so the trail has to hold
          // what the figure was — FR §4.3's "original value visibility".
          // Every other transition leaves the number where anyone can still read
          // it; this one is the only case where the audit row is the last place
          // the withdrawn value is reported alongside the reason.
          ...(isVoid
            ? { voidReason: extra.voidReason, before: this.toAuditSnapshot(record) }
            : {}),
        },
      },
      tx,
    );
    return Object.assign(updated, { fuelRecords: await this.fuelRecordsIn(tx, user, [updated]) });
  }
}
