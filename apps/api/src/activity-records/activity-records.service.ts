import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityRecordStatus,
  Prisma,
  type ActivityRecord,
} from '@tonyai/db';
import {
  CreateRoleRefusedError,
  DuplicateActivityRecordError,
  EvidenceRequiredError,
  PeriodLockedError,
  ResubmitAuthorRefusedError,
  SubmitRoleRefusedError,
  VarianceReasonRequiredError,
} from './errors';
import {
  canonicalPeriodValue,
  CATEGORY_SCOPE_MAP,
  anomalyNotEvaluated,
  type AnomalyVerdict,
  computeAnomalyVerdict,
  COUNTED_STATUSES,
  PERIOD_VALUES,
  SUBMITTABLE_STATUSES as SUBMITTABLE_STATUSES_CONTRACT,
  isCalculated,
  isEvidenceRequired,
  needsEvidenceBeforeSubmit,
  type ActivityCalculationSnapshot,
  type ActivityRecordDTO,
  type AuditAction,
  type Category,
  type ReportingPeriod,
  mayAuthorRecords,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { quoteCallerText } from '../common/caller-text';
import {
  actorDisplayName,
  resolveProfiles,
  type ResolvedProfile,
} from '../common/resolve-profiles';
import { CalculationsService } from '../calculations/calculations.service';
import { storedUnit } from '../calculations/storable-unit';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { EvidenceService } from '../evidence/evidence.service';
import { CreateActivityRecordDto } from './dto/create-activity-record.dto';
import { UpdateActivityRecordDto } from './dto/update-activity-record.dto';
import { ListActivityRecordsQueryDto } from './dto/list-activity-records-query.dto';

/** Inputs to the VAR §4 rolling-baseline check, minus the figure itself. */
interface AnomalyParams {
  subsidiaryId: string;
  locationId: string | null;
  category: string;
  reportingPeriod: string;
  reportingYear: number;
  periodValue: string;
  currentTCo2e: number;
  excludeId?: string;
}

/**
 * May this user author activity records at all? The rule is the contract's
 * `mayAuthorRecords`, so the screens that hide a control and the API that
 * refuses it read one definition.
 */
export function mayWriteActivityRecords(user: RequestUser): boolean {
  return mayAuthorRecords(user);
}

// The refusal classes and their sentences live in `./errors`.
// Roles allowed to take a record into review and to reject it ("flag for
// revision" in permissions_and_roles.md §3).
const REVIEW_ROLES = new Set(['consultant', 'super_admin']);
// Roles allowed to APPROVE — narrower than REVIEW_ROLES on purpose. A
// consultant reviews and can send a record back ("flag for revision"), but the
// act of accepting a figure into the inventory stays with the holding company's
// own super_admin: an external advisor should not be able to sign off the
// numbers their client will report. Matches permissions_and_roles.md §3.
const APPROVE_ROLES = new Set(['super_admin']);
// Statuses in which a record may still be edited or deleted by an author.
// Exported so the subsidiary delete guard can tell a removable draft from a
// committed record it must refuse over — if the two lists drifted, that guard
// would start offering advice ("delete the drafts first") that the record
// endpoint refuses to carry out.
export const EDITABLE_STATUSES = new Set<ActivityRecordStatus>([
  ActivityRecordStatus.draft,
  ActivityRecordStatus.rejected,
]);

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

// --- Anomaly detection (VAR §4) --------------------------------------------
// A value is anomalous when it deviates > ±50% from the rolling average of the
// previous 3 comparable periods for the same reporting entity, measured on
// calculated tCO₂e. Only committed rows feed the baseline (unreviewed drafts
// would add noise). Warning-based, never auto-rejection (VAR §8).
//
// THREE priors are REQUIRED, not "up to three" (decision 2026-08-27). Under the
// old reading the gate quietly degraded to a single-period comparison — a
// two-period average, or one month against one month — with nothing recording
// that it had, because `anomalyFlag: false` cannot distinguish "checked" from
// "not checkable". Fewer than three now means NOT EVALUATED, and the record
// says which via `baselinePriorCount`.
//
// Both numbers live in @tonyai/shared-types: a screen has to state the same
// rule now that "2 of 3" is something it must be able to say.
// The SAME list the inventory counts — a sixth hand-written copy of it lived
// here, character-identical, in the file this rule is most likely to be edited
// from. A record that counts towards the totals is exactly a record that should
// inform the baseline, so the two can never legitimately differ.
const BASELINE_STATUSES: ActivityRecordStatus[] = [...COUNTED_STATUSES];

/** Position of a period within its year, so records can be ordered despite
 * `periodValue` being a plain string column. Only compared within the same
 * granularity (monthly 0–11, quarterly 1–4, annual single).
 *
 * Reads the shared vocabulary rather than a local lower-case copy of it — that
 * copy was one of six, and it is the reason nothing in this file could say what
 * the canonical spelling of a month WAS. */
export function periodOrdinal(reportingPeriod: string, periodValue: string): number {
  const canonical = canonicalPeriodValue(reportingPeriod, periodValue);
  if (canonical === null) return 0;
  const allowed: readonly string[] =
    PERIOD_VALUES[reportingPeriod as ReportingPeriod];
  // `canonical` came out of this very list, so the index is always found — no
  // `Math.max` floor, which would only have hidden a broken canonicaliser.
  //
  // Quarters stay 1-based and months 0-based, exactly as before. An ordinal is
  // only ever compared against another of the SAME granularity, so the bases do
  // not need to agree; what the +1 buys is keeping `Q1` distinct from
  // "unrecognised value" (0), which the regex it replaced also did.
  const i = allowed.indexOf(canonical);
  return reportingPeriod === 'quarterly' ? i + 1 : i;
}

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
      `"${quoteCallerText(periodValue)}" is not a valid period for a ${reportingPeriod} record.`,
    );
  }
  return canonical;
}

/** The resolved-at-read-time fields, named once so both the DTO's audit
 *  snapshot and the guard below stay in step. */
type ResolvedRecordFields =
  | 'locationName'
  | 'createdByName'
  | 'reviewedByName'
  | 'voidedByName';

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

@Injectable()
export class ActivityRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculations: CalculationsService,
    private readonly audit: AuditService,
    private readonly evidence: EvidenceService,
  ) {}

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
      scope: r.scope,
      status: r.status,
      activityValue: r.activityValue,
      activityUnit: r.activityUnit,
      input: (r.input as Record<string, unknown> | null) ?? null,
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
      // Persisted columns, so they belong in the audit snapshot too — a void is
      // the transition whose provenance matters most.
      voidReason: r.voidReason,
      voidedBy: r.voidedBy,
      voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
      evidenceCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private toDTO(
    r: ActivityRecord & { location?: { name: string } | null },
    evidenceCount = 0,
    actors: Map<string, ResolvedProfile>,
  ): ActivityRecordDTO {
    return {
      ...this.toAuditSnapshot(r, evidenceCount),
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
    };
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
    const record = await this.prisma.activityRecord.findUnique({
      where: { id },
      include: { location: { select: { name: true } } },
    });
    if (!record || !user.accessibleSubsidiaryIds.includes(record.subsidiaryId)) {
      throw new NotFoundException('Activity record not found');
    }
    return record;
  }

  /** Author-or-super_admin gate for edit/delete on a mutable record. */
  private assertCanMutate(user: RequestUser, record: ActivityRecord): void {
    if (!mayAuthorRecords(user)) {
      throw new ForbiddenException(
        'Your role may not modify activity records',
      );
    }
    if (user.role !== 'super_admin' && record.createdBy !== user.id) {
      throw new ForbiddenException(
        'You may only modify activity records you created',
      );
    }
    if (!EDITABLE_STATUSES.has(record.status)) {
      throw new BadRequestException(
        `Cannot modify a record in status "${record.status}"`,
      );
    }
  }

  /**
   * Produce the immutable calculation snapshot for a record by resolving the
   * subsidiary's geography and the category's scope, then calling the calc
   * engine. Returns both the snapshot and the derived scope.
   */
  private async computeSnapshot(
    subsidiaryId: string,
    accessibleSubsidiaryIds: string[],
    category: Category,
    reportingYear: number,
    activityValue: number,
    activityUnit: string,
    locationId?: string | null,
    /** False when `activityUnit` came from the stored record, not this request. */
    unitChosenNow = true,
  ): Promise<{ calculation: ActivityCalculationSnapshot; scope: number }> {
    if (!accessibleSubsidiaryIds.includes(subsidiaryId)) {
      // Tenant isolation: cannot attach a record to an inaccessible subsidiary.
      throw new NotFoundException('Subsidiary not found');
    }
    const subsidiary = await this.prisma.subsidiary.findUnique({
      where: { id: subsidiaryId },
    });
    if (!subsidiary) throw new NotFoundException('Subsidiary not found');

    // Reporting entity (data_entry_page.md §5.2): when a location is targeted, it drives the
    // factor geography; otherwise the subsidiary does. A location must belong to
    // the same (accessible) subsidiary, else it is treated as not found.
    let geographyCode = subsidiary.geographyCode;
    if (locationId) {
      const location = await this.prisma.location.findUnique({
        where: { id: locationId },
      });
      if (!location || location.subsidiaryId !== subsidiaryId) {
        throw new NotFoundException('Location not found');
      }
      geographyCode = location.geographyCode;
    }

    const scope = CATEGORY_SCOPE_MAP[category];
    const calculation = await this.calculations.compute(
      {
        category,
        geographyCode,
        reportingYear,
        value: activityValue,
        unit: activityUnit,
      },
      { enforceCategoryUnit: unitChosenNow },
    );
    return { calculation, scope };
  }

  /**
   * Period-lock gate (FR §4.2): while a `period_locks` row exists for the
   * record's (subsidiary, year, period, periodValue), NO create/update/delete/
   * submit is allowed — the period is closed. super_admin must unlock first.
   */
  private async assertPeriodNotLocked(
    subsidiaryId: string,
    reportingYear: number,
    reportingPeriod: string,
    periodValue: string,
  ): Promise<void> {
    const lock = await this.prisma.periodLock.findFirst({
      where: { subsidiaryId, reportingYear, reportingPeriod, periodValue },
    });
    if (lock) {
      throw new PeriodLockedError(
        `Reporting period ${periodValue} ${reportingYear} is locked — a super_admin must unlock it before records can change.`,
      );
    }
  }

  /**
   * Anomaly check for a record whose figure comes from a snapshot.
   *
   * VAR §4 defines the deviation on the **calculated tCO₂e**, so a record that
   * produced no figure has nothing to deviate from and is never anomalous.
   * Substituting 0 — which is what a plain `?? 0` does — reads as a 100% drop
   * against any real baseline and would demand a variance comment for a value
   * that was never computed. Every write path goes through here so the three
   * of them cannot drift on that rule.
   */
  private async detectAnomalyFor(
    calculation: ActivityCalculationSnapshot,
    params: Omit<AnomalyParams, 'currentTCo2e'>,
  ): Promise<AnomalyVerdict> {
    // Reports 0 priors because none were ever queried, not because none exist.
    // "Has no figure of its own" and "has no comparable periods" are different
    // facts; a reader separates them with isCalculated() on the snapshot, which
    // travels on the same DTO.
    if (!isCalculated(calculation)) return anomalyNotEvaluated();
    return this.detectAnomaly({ ...params, currentTCo2e: calculation.tCo2e });
  }

  /**
   * Anomaly check (VAR §4): anomalous when `currentTCo2e` deviates > ±50% from
   * the rolling average of the previous 3 committed periods for the same
   * reporting entity (subsidiary + location + category) at the same granularity.
   * Fewer than three priors → the rule does not run. Warning-only.
   *
   * The key includes `locationId` and the granularity, which VAR §4.1 does not
   * name — a deliberate deviation, now written into the spec: comparing a site
   * meter against a whole-company roll-up flags a change of SCOPE as a change of
   * consumption, and it is what stops a re-attribution raising a false anomaly.
   */
  private async detectAnomaly(params: AnomalyParams): Promise<AnomalyVerdict> {
    // Prisma DROPS a `where` entry whose value is `undefined`, so an unset
    // subsidiary here would widen the pool to every tenant in the database and
    // persist a cross-tenant average onto the record. Unreachable today — all
    // three callers pass a value whose accessibility was established upstream —
    // but upstream is an ORDERING convention (`computeSnapshot` validates and
    // does not return what it validated), and a convention is not a mechanism.
    if (!params.subsidiaryId) {
      throw new Error('anomaly baseline requires a subsidiary scope');
    }
    const rows = await this.prisma.activityRecord.findMany({
      where: {
        subsidiaryId: params.subsidiaryId,
        locationId: params.locationId,
        category: params.category,
        reportingPeriod: params.reportingPeriod,
        status: { in: BASELINE_STATUSES },
        ...(params.excludeId ? { id: { not: params.excludeId } } : {}),
      },
    });

    const currentKey =
      params.reportingYear * 100 +
      periodOrdinal(params.reportingPeriod, params.periodValue);
    // SELECTING the pool needs a database and therefore lives here; JUDGING it
    // is `computeAnomalyVerdict` in the contract package, so the API and
    // `pnpm anomaly:recompute` cannot disagree about the same record — not even
    // in the last ULP, which is exactly how far Postgres's `avg()` differs from
    // this fold.
    const orderedPriors = rows
      .map((r) => ({
        key: r.reportingYear * 100 + periodOrdinal(r.reportingPeriod, r.periodValue),
        calc: r.calculation as unknown as ActivityCalculationSnapshot | null,
      }))
      .filter((x) => x.key < currentKey) // strictly earlier periods only
      .sort((a, b) => b.key - a.key)
      // A prior with no figure stays in the list as `null` rather than being
      // filtered out here: it must still CONSUME one of the three slots, and
      // dropping it before the window is applied would let the rule reach
      // further back to refill it.
      .map((x) => (isCalculated(x.calc) ? x.calc.tCo2e : null));

    return computeAnomalyVerdict(params.currentTCo2e, orderedPriors);
  }

  async list(
    user: RequestUser,
    query: ListActivityRecordsQueryDto,
  ): Promise<ActivityRecordDTO[]> {
    // Tenant scope: intersect any requested subsidiaryId with the accessible set.
    let subsidiaryFilter: Prisma.StringFilter | string;
    if (query.subsidiaryId) {
      if (!user.accessibleSubsidiaryIds.includes(query.subsidiaryId)) {
        return []; // requested a subsidiary the caller cannot see -> empty
      }
      subsidiaryFilter = query.subsidiaryId;
    } else {
      subsidiaryFilter = { in: user.accessibleSubsidiaryIds };
    }

    const rows = await this.prisma.activityRecord.findMany({
      where: {
        subsidiaryId: subsidiaryFilter,
        reportingYear: query.year,
        reportingPeriod: query.period,
        category: query.category,
        status: query.status ? { in: query.status } : undefined,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { evidence: true } },
        location: { select: { name: true } },
      },
    });
    // One query for the whole page over all THREE actor columns at once, never
    // one per row: `created_by`, `reviewed_by` and `voided_by` have no FK to
    // `profiles`, so there is no `include` that could do this.
    const actors = await this.actorsFor(user, rows);
    return rows.map((r) => this.toDTO(r, r._count.evidence, actors));
  }

  async get(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    const [evidenceCount, actors] = await Promise.all([
      this.prisma.evidence.count({ where: { activityRecordId: id } }),
      this.actorsFor(user, [record]),
    ]);
    return this.toDTO(record, evidenceCount, actors);
  }

  /**
   * Everything `create` decides BEFORE it writes anything — the role gate, the
   * tenant gate, the canonical period spelling, the period-lock gate, the
   * calculation snapshot and the anomaly verdict — with no write and no audit
   * row of its own.
   *
   * Extracted so the bulk importer (WP8) can offer a dry-run that PROVABLY
   * persists nothing. The obvious alternative, running the batch inside a
   * rolled-back transaction, is not available here: this service opens no
   * transaction at all (`create` writes through the default client and audits
   * afterwards), and Prisma's interactive-transaction timeout would not survive
   * a thousand-row loop even if it did. A read-only seam is the mechanism the
   * code actually supports, and "no write happened" is then a claim a spec can
   * assert against the write spies rather than a claim about a rollback.
   *
   * It keeps the role gate deliberately, even though a bulk caller checks the
   * role once per batch: a security control that only runs on the path someone
   * remembered to guard is not a control.
   *
   * **It does NOT decide uniqueness.** The `NULLS NOT DISTINCT` conflict is
   * raised by Postgres on the insert and reaches `create` as a `P2002`, so a
   * preview cannot see it: a caller previewing a batch must detect duplicates
   * itself — against the rows already stored AND against the rest of the file.
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
    calculation: ActivityCalculationSnapshot;
    scope: number;
    verdict: AnomalyVerdict;
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
      throw new NotFoundException('Subsidiary not found');
    }
    // Canonicalised, not merely validated. Everything downstream compares RAW
    // strings — the uniqueness index, both period-lock lookups, the seed's own
    // de-duplication key — so the spelling that gets stored IS the identity of
    // the month. Use it from here on; `dto.periodValue` is the user's spelling
    // and belongs only in the error message above.
    const periodValue = requireCanonicalPeriodValue(
      dto.reportingPeriod,
      dto.periodValue,
    );
    // Period-lock gate (FR §4.2): no new records in a closed period.
    await this.assertPeriodNotLocked(
      dto.subsidiaryId,
      dto.reportingYear,
      dto.reportingPeriod,
      periodValue,
    );

    const { calculation, scope } = await this.computeSnapshot(
      dto.subsidiaryId,
      user.accessibleSubsidiaryIds,
      dto.category,
      dto.reportingYear,
      dto.activityValue,
      dto.activityUnit,
      dto.locationId,
    );

    const verdict = await this.detectAnomalyFor(calculation, {
      subsidiaryId: dto.subsidiaryId,
      locationId: dto.locationId ?? null,
      category: dto.category,
      reportingPeriod: dto.reportingPeriod,
      reportingYear: dto.reportingYear,
      periodValue,
    });

    return {
      subsidiaryId: dto.subsidiaryId,
      locationId: dto.locationId ?? null,
      periodValue,
      calculation,
      scope,
      verdict,
    };
  }

  async create(
    user: RequestUser,
    dto: CreateActivityRecordDto,
  ): Promise<ActivityRecordDTO> {
    const { subsidiaryId, locationId, periodValue, calculation, scope, verdict } =
      await this.previewCreate(user, dto);

    let created: ActivityRecord & { location: { name: string } | null };
    try {
      created = await this.prisma.activityRecord.create({
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
          calculation: calculation as unknown as Prisma.InputJsonValue,
          createdBy: user.id,
          varianceReason: dto.varianceReason ?? null,
        },
      });
    } catch (e) {
      // Unique constraint (subsidiary, location, year, period, periodValue,
      // category) is a user-actionable conflict, not a server error.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new DuplicateActivityRecordError();
      }
      throw e;
    }
    await this.auditCreateUpdateDelete(user, 'create', created.id, {
      after: this.toAuditSnapshot(created),
    });
    return this.toDTO(created, 0, await this.actorsFor(user, [created]));
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateActivityRecordDto,
  ): Promise<ActivityRecordDTO> {
    const existing = await this.loadScoped(user, id);
    this.assertCanMutate(user, existing);

    // Resolve the effective values (dto overrides existing) so we can recompute.
    const category = (dto.category ?? existing.category) as Category;
    const reportingYear = dto.reportingYear ?? existing.reportingYear;
    const activityValue = dto.activityValue ?? existing.activityValue;
    const activityUnit = dto.activityUnit ?? existing.activityUnit;
    // `locationId` may be re-targeted (string), detached (null), or left as-is
    // (undefined) — distinguish "not provided" from an explicit null.
    const locationId =
      dto.locationId !== undefined ? dto.locationId : existing.locationId;

    const reportingPeriod = dto.reportingPeriod ?? existing.reportingPeriod;
    const periodValue = requireCanonicalPeriodValue(
      reportingPeriod,
      dto.periodValue ?? existing.periodValue,
    );
    // Period-lock gate (FR §4.2): the record's current period must be open, and
    // it cannot be re-targeted INTO a locked period either.
    await this.assertPeriodNotLocked(
      existing.subsidiaryId,
      existing.reportingYear,
      existing.reportingPeriod,
      existing.periodValue,
    );
    if (
      reportingYear !== existing.reportingYear ||
      reportingPeriod !== existing.reportingPeriod ||
      periodValue !== existing.periodValue
    ) {
      await this.assertPeriodNotLocked(
        existing.subsidiaryId,
        reportingYear,
        reportingPeriod,
        periodValue,
      );
    }

    const { calculation, scope } = await this.computeSnapshot(
      existing.subsidiaryId,
      user.accessibleSubsidiaryIds,
      category,
      reportingYear,
      activityValue,
      activityUnit,
      locationId,
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

    const verdict = await this.detectAnomalyFor(calculation, {
      subsidiaryId: existing.subsidiaryId,
      locationId,
      category,
      reportingPeriod,
      reportingYear,
      periodValue,
      excludeId: id, // the record's own row must not seed its baseline
    });

    const data: Prisma.ActivityRecordUpdateInput = {
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
    if (dto.locationId !== undefined) {
      data.location = dto.locationId
        ? { connect: { id: dto.locationId } }
        : { disconnect: true };
    }
    if (dto.reportingPeriod !== undefined) data.reportingPeriod = dto.reportingPeriod;
    // The canonical spelling, not the caller's. Gated on the caller having
    // SENT one, so an unrelated edit never rewrites a field nobody touched —
    // that would put a change into the audit diff that the user did not make.
    if (dto.periodValue !== undefined) data.periodValue = periodValue;
    if (dto.input !== undefined) {
      data.input = (dto.input ?? Prisma.JsonNull) as Prisma.InputJsonValue;
    }
    if (dto.varianceReason !== undefined) data.varianceReason = dto.varianceReason;

    let updated: ActivityRecord & {
      _count: { evidence: number };
      location: { name: string } | null;
    };
    try {
      updated = await this.prisma.activityRecord.update({
        where: { id },
        data,
        include: {
          _count: { select: { evidence: true } },
          location: { select: { name: true } },
        },
      });
    } catch (e) {
      // Re-targeting can collide with an existing record for the new entity.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new DuplicateActivityRecordError();
      }
      throw e;
    }
    await this.auditCreateUpdateDelete(user, 'update', id, {
      before: this.toAuditSnapshot(existing),
      after: this.toAuditSnapshot(updated, updated._count.evidence),
    });
    return this.toDTO(
      updated,
      updated._count.evidence,
      await this.actorsFor(user, [updated]),
    );
  }

  async remove(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const existing = await this.loadScoped(user, id);
    this.assertCanMutate(user, existing);
    // Period-lock gate (FR §4.2): no deletions in a closed period.
    await this.assertPeriodNotLocked(
      existing.subsidiaryId,
      existing.reportingYear,
      existing.reportingPeriod,
      existing.periodValue,
    );
    // Reclaim the evidence FILES first. The rows go by themselves — the FK is
    // ON DELETE CASCADE — but that happens inside Postgres, so this is the last
    // moment any code can still see what the blobs are. Skip it and the
    // invoices outlive every pointer to them, which is a retention problem, not
    // wasted disk. Before the row delete on purpose: if storage fails, nothing
    // has been destroyed yet.
    await this.evidence.removeAllForRecord(id);
    await this.prisma.activityRecord.delete({ where: { id } });
    await this.auditCreateUpdateDelete(user, 'delete', id, {
      before: this.toAuditSnapshot(existing),
    });
    return { id, deleted: true };
  }

  // --- Workflow transitions --------------------------------------------------

  async submit(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!mayAuthorRecords(user)) {
      throw new SubmitRoleRefusedError();
    }
    if (!SUBMITTABLE_STATUSES.has(record.status)) {
      throw new BadRequestException(
        `Only a draft or rejected record can be submitted (current status "${record.status}")`,
      );
    }
    const isResubmission = record.status === ActivityRecordStatus.rejected;
    // Resubmitting REVERSES a reviewer's decision, so it needs the author gate
    // that `update`/`remove` already apply. Without it, any data_entry user who
    // can merely SEE the subsidiary could overturn a rejection — while still
    // being forbidden from editing the number, so the only thing the capability
    // could be used for is making the rejection go away.
    if (
      isResubmission &&
      user.role !== 'super_admin' &&
      record.createdBy !== user.id
    ) {
      throw new ResubmitAuthorRefusedError();
    }
    // Period-lock gate (FR §4.2): no submissions into a closed period.
    await this.assertPeriodNotLocked(
      record.subsidiaryId,
      record.reportingYear,
      record.reportingPeriod,
      record.periodValue,
    );
    // Evidence gate (FR §4.1 / §5.4): categories configured as evidence-required
    // cannot be submitted without at least one supporting file.
    // The count is only worth a query when the category could need one, so the
    // short-circuit stays here; the RULE over the two values is the contract's,
    // shared with the checkbox the client offers, because it has already been
    // copied wrongly once.
    const evidenceCount = isEvidenceRequired(record.category)
      ? await this.prisma.evidence.count({ where: { activityRecordId: id } })
      : 0;
    if (needsEvidenceBeforeSubmit({ category: record.category, evidenceCount })) {
      throw new EvidenceRequiredError(record.category);
    }
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
    const verdict = await this.detectAnomalyFor(calc, {
      subsidiaryId: record.subsidiaryId,
      locationId: record.locationId,
      category: record.category,
      reportingPeriod: record.reportingPeriod,
      reportingYear: record.reportingYear,
      periodValue: record.periodValue,
      excludeId: record.id,
    });
    if (verdict.anomalous && !record.varianceReason?.trim()) {
      throw new VarianceReasonRequiredError();
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
    return this.transition(user, record, ActivityRecordStatus.submitted, { verdict });
  }

  /**
   * Take a submitted record into review (FR §6.3): submitted → under_review.
   * Marks that a reviewer is actively looking at it; approve/reject remain the
   * only exits. Same reviewer RBAC + period-lock gate as approve/reject.
   */
  async startReview(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!REVIEW_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only a consultant or super_admin may review records',
      );
    }
    if (record.status !== ActivityRecordStatus.submitted) {
      throw new BadRequestException(
        `Only a submitted record can be taken into review (current status "${record.status}")`,
      );
    }
    await this.assertPeriodNotLocked(
      record.subsidiaryId,
      record.reportingYear,
      record.reportingPeriod,
      record.periodValue,
    );
    return this.transition(user, record, ActivityRecordStatus.under_review);
  }

  async approve(user: RequestUser, id: string): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!APPROVE_ROLES.has(user.role)) {
      throw new ForbiddenException('Only a super_admin may approve records');
    }
    if (
      record.status !== ActivityRecordStatus.submitted &&
      record.status !== ActivityRecordStatus.under_review
    ) {
      throw new BadRequestException(
        `Only a submitted or under_review record can be approved (current status "${record.status}")`,
      );
    }
    // Period-lock gate (defense-in-depth): no review transitions in a closed
    // period, even for a record that slipped in around the lock (race).
    await this.assertPeriodNotLocked(
      record.subsidiaryId,
      record.reportingYear,
      record.reportingPeriod,
      record.periodValue,
    );
    // Clear any earlier rejection note: an approved record showing last
    // round's rejection reason would misread as "approved, but rejected".
    return this.transition(user, record, ActivityRecordStatus.approved, {
      reviewNote: null,
    });
  }

  /**
   * Withdraw an APPROVED figure from the inventory — the revision elements FR §4.3 requires.
   *
   * `approved` and `locked` are immutable, and that is correct: a figure a
   * reviewer accepted must not be quietly edited away. But it left a record
   * entered in error with no exit at all — update, remove, submit, review,
   * approve and reject all refuse both statuses, and `super_admin` does not
   * override it, because `assertCanMutate` checks role and status
   * independently. Deleting was the only remedy and the API refuses that too.
   *
   * So this does not delete. The row stays, keeps its immutable calculation
   * snapshot, and simply stops counting — `voided` is absent from
   * `COUNTED_STATUSES`, so every total, export, matrix cell and anomaly
   * baseline excludes it by construction rather than by a filter each call site
   * has to remember.
   *
   * `super_admin` only, narrower than `REVIEW_ROLES` on purpose: a consultant
   * may send a record back for revision (`reject`), but removing an accepted
   * figure from the client's reported inventory is the holding company's own
   * decision. Same reasoning as `APPROVE_ROLES`.
   */
  async void(
    user: RequestUser,
    id: string,
    reason: string,
  ): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!APPROVE_ROLES.has(user.role)) {
      throw new ForbiddenException('Only a super_admin may void records');
    }
    if (record.status !== ActivityRecordStatus.approved) {
      // Deliberately `approved` alone. A `locked` record sits in a closed
      // period, and reopening one already has its own audited path (unlock);
      // letting a void bypass that would make the lock a suggestion. Draft and
      // rejected records can simply be deleted, and submitted/under_review ones
      // rejected — none of them needs this.
      throw new BadRequestException(
        `Only an approved record can be voided (current status "${record.status}"). ` +
          'A locked period must be unlocked first.',
      );
    }
    // Defense-in-depth, and not redundant with the status check: a period can
    // be locked while this request is in flight, and a lock is precisely the
    // statement that this period's figures are closed.
    await this.assertPeriodNotLocked(
      record.subsidiaryId,
      record.reportingYear,
      record.reportingPeriod,
      record.periodValue,
    );
    try {
      return await this.transition(user, record, ActivityRecordStatus.voided, {
        voidReason: reason,
      });
    } catch (e) {
      // P2025 = the row stopped being `approved` between the check above and
      // the write. In practice that means a period lock committed in the
      // window, so the honest answer is the lock's own refusal rather than a
      // 500 about a record that plainly exists.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new ConflictException(
          'This record changed while it was being voided — it is most likely inside a period that has just been locked. Reload and try again.',
        );
      }
      throw e;
    }
  }

  async reject(
    user: RequestUser,
    id: string,
    varianceReason: string,
  ): Promise<ActivityRecordDTO> {
    const record = await this.loadScoped(user, id);
    if (!REVIEW_ROLES.has(user.role)) {
      throw new ForbiddenException(
        'Only a consultant or super_admin may reject records',
      );
    }
    if (
      record.status !== ActivityRecordStatus.submitted &&
      record.status !== ActivityRecordStatus.under_review
    ) {
      throw new BadRequestException(
        `Only a submitted or under_review record can be rejected (current status "${record.status}")`,
      );
    }
    // Period-lock gate (defense-in-depth): symmetric with approve.
    await this.assertPeriodNotLocked(
      record.subsidiaryId,
      record.reportingYear,
      record.reportingPeriod,
      record.periodValue,
    );
    // The reviewer's reason goes in reviewNote — overwriting varianceReason
    // would destroy the author's own anomaly justification (VAR §4).
    return this.transition(user, record, ActivityRecordStatus.rejected, {
      reviewNote: varianceReason,
    });
  }

  /**
   * Which status a transition lands on decides the audit action. Before WP7
   * every transition logged `update` with the real move buried in the diff,
   * which made the audit trail unreadable and unfilterable.
   */
  private static readonly TRANSITION_ACTIONS: Record<string, AuditAction> = {
    [ActivityRecordStatus.submitted]: 'submit',
    [ActivityRecordStatus.under_review]: 'review',
    [ActivityRecordStatus.approved]: 'approve',
    [ActivityRecordStatus.rejected]: 'reject',
    [ActivityRecordStatus.voided]: 'void',
  };

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
    },
  ): Promise<void> {
    await this.audit.record(user, { action, entity: 'activity_record', entityId, diff });
  }

  /** Apply a status change + optional field patch, and audit it. */
  private async transition(
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
  ): Promise<ActivityRecordDTO> {
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

    // The status is part of the WHERE for a void, not just the guard above it.
    // Every other transition reads its pre-state, checks it, then writes on the
    // id alone — and for them the window is harmless, because `lock` refuses to
    // run while a pending-review record exists, so their pre-state cannot be
    // flipped concurrently. `approved` is the one status `lock` DOES mutate: a
    // lock committing between the check and this write would be silently
    // overwritten, leaving the record `voided` inside a closed period with no
    // unlock to reopen it. Prisma raises P2025 when the row no longer matches,
    // which the caller maps to the same 409 the lock itself would have given.
    const updated = await this.prisma.activityRecord.update({
      where: isVoid
        ? { id: record.id, status: ActivityRecordStatus.approved }
        : { id: record.id },
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
        ...(status === ActivityRecordStatus.submitted
          ? { submittedAt: new Date() }
          : {}),
        ...(isVoid
          ? {
              voidReason: extra.voidReason,
              voidedBy: user.id,
              voidedAt: new Date(),
            }
          : {}),
      },
      include: {
        _count: { select: { evidence: true } },
        location: { select: { name: true } },
      },
    });
    await this.audit.record(user, {
      action: ActivityRecordsService.TRANSITION_ACTIONS[status] ?? 'update',
      entity: 'activity_record',
      entityId: record.id,
      diff: {
        transition: { from: record.status, to: status },
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
    });
    return this.toDTO(
      updated,
      updated._count.evidence,
      await this.actorsFor(user, [updated]),
    );
  }
}
