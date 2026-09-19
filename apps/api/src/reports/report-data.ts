import type {
  ActivityRecordStatus,
  EmissionsSummary,
  ReportStatus,
  ReportTemplate,
} from '@tonyai/shared-types';

/**
 * The shapes a generated report is assembled INTO, before any writer sees them.
 *
 * Split out of `reports.service.ts` so the layering is acyclic by construction:
 * `report-data` → `report-columns` → `report-html` → `reports.service`. Until
 * WP22 F1 the HTML writer imported these straight from the service, which was
 * harmless only because it was an `import type` and therefore erased. The
 * column descriptors are VALUES, and one value import along that edge would
 * have closed a real CommonJS cycle — the loser of which gets a
 * partially-initialised module, so `NOT_CALCULATED` reads `undefined` and every
 * factor-less cell prints "undefined" into a filed report.
 *
 * `reports.service.ts` re-exports all of these, so no caller had to change.
 */

/**
 * The fields both row kinds share, with `status` left as the FULL union.
 *
 * Exists so one column vocabulary can read either kind. It does NOT weaken the
 * guarantee that a withdrawn row cannot reach the ledger writers: that lives at
 * the writers' own concrete signatures (`csvLedgerRow(r: ReportLedgerRow)`),
 * which is where a caller meets it, and `ReportLedgerRow.status` is still
 * `Exclude<ActivityRecordStatus, 'voided'>`.
 */
export type ReportRowBase = Omit<ReportLedgerRow, 'status'> & {
  status: ActivityRecordStatus;
};

export interface ReportLedgerRow {
  subsidiaryName: string;
  /** The location id, carried beside the name because `entityLabel` keys on the
   *  PAIR: the id is the fact, the name is a decoration the query may or may not
   *  have loaded. Free — it is on the record row already. */
  locationId: string | null;
  /** The site this figure is attributed to, or `null` for a whole-company row.
   *  Kept null-able rather than pre-labelled so the three writers all put the
   *  same phrase on it (`entityLabel`) instead of three near-synonyms. Without
   *  it a re-attribution from the company to a site changes nothing visible in
   *  any export, and the two halves of a double-counted month are
   *  indistinguishable in the ledger an auditor keeps. */
  locationName: string | null;
  category: string;
  periodValue: string;
  reportingPeriod: string;
  activityValue: number;
  activityUnit: string;
  /** What the activity value became after unit conversion, and by what factor.
   *  Without these the ledger prints "5,000 cubic_metres → 10.4 tCO₂e" beside a
   *  factor quoted per kWh, and the ×11.36 between them appears nowhere — the
   *  figure cannot be recomputed from the report, which is what ISO 14064-1
   *  §9.3.1 and GHG Protocol Ch.7 ask a report to make possible. */
  normalizedValue?: number;
  normalizedUnit?: string;
  conversionFactor?: number;
  /** `null` when the record's category has no emission factor and therefore
   *  produced no figure (WP17 — Water). Deliberately not `0`: an audit-ready
   *  ledger that prints a measured zero where nothing was measured cannot be
   *  told apart from a genuine zero afterwards, and the report is the artifact
   *  an auditor keeps. Every writer renders it as "Not calculated". */
  tCo2e: number | null;
  /** Narrowed so "the ledger holds no withdrawn figure" is a compile error
   *  rather than only a test: `ReportWithdrawnRow` extends this type, so a
   *  withdrawn row is otherwise assignable straight into `records` and into the
   *  ledger writers. Same allow-list instinct as `COUNTED_STATUSES`. */
  status: Exclude<ActivityRecordStatus, 'voided'>;
  evidenceCount: number;
  anomalyFlag: boolean;
  /** Whether the VAR §4 rule actually RAN on this record — `anomalyFlag: false`
   *  covers both "checked, clean" and "never checked", and only one of those is
   *  a statement a filed report may make. Derived once here through the shared
   *  `isAnomalyEvaluated` predicate so no writer re-derives it. */
  anomalyEvaluated: boolean;
  /** The window it was judged against: null (no figure of its own), 0–2 (short)
   *  or 3 (evaluated). Printed inside the anomaly column rather than as a new
   *  column — the ledger already carries ten hand-maintained column literals
   *  across three writers, and this adds no eleventh. */
  anomalyBaselinePriorCount: number | null;
}

/**
 * One figure withdrawn from this reporting year — a ledger row plus why it left.
 *
 * It extends `ReportLedgerRow` rather than restating it because a withdrawal
 * disclosure is only meaningful beside the same identifying columns the ledger
 * uses: the reader has to be able to tell which of two entries for one month
 * was removed, and before WP18's Reporting Entity row the two were
 * distinguishable only by activity value.
 */
export interface ReportWithdrawnRow extends Omit<ReportLedgerRow, 'status'> {
  status: 'voided';
  /** Why the figure was withdrawn — required at the API (min 10 chars) and
   *  uncorrectable afterwards, so it is quoted verbatim, never summarised. */
  voidReason: string | null;
  voidedAt: string | null;
  /**
   * WHO withdrew the figure, as the opaque `voided_by` UUID — never a resolved
   * name (user decision, 2026-09-01).
   *
   * A report is a filed artifact that cannot be recalled, so writing a natural
   * person's name into one is a KVKK/GDPR commitment the erasure and
   * report-redaction questions have not yet answered; the id satisfies
   * ISO 14064-1 §9.3.1 for a verifier with system access without making that
   * commitment. It is also why reports still resolve no profiles: the id is
   * already on the row, so this disclosure costs no query.
   *
   * Nullable because the column is (`voided_by` carries no FK by design — a
   * deleted profile takes the name, never the id), and because every COUNTED
   * ledger row has it null.
   */
  voidedBy: string | null;
}

/** One deduplicated factor snapshot (audit traceability core, FR §3.5/§5). */
export interface ReportFactorRow {
  category: string;
  geographyCode: string;
  factorValue: number;
  factorUnit: string;
  methodology: string;
  source: string;
  version: string;
  /** Set when records under this factor went through a unit conversion. The
   *  basis is disclosed here because for natural gas it is an ASSUMPTION, not a
   *  definition, and a factor appendix that hides it is not audit-traceable. */
  conversionBasis?: string;
}

export interface ReportEvidenceRow {
  subsidiaryName: string;
  category: string;
  periodValue: string;
  fileCount: number;
  fileNames: string[];
  /** Index-aligned with `fileNames`: how many OTHER records the same file
   *  backs in all (0 = this record alone) — including records outside this
   *  report's year or scope. */
  alsoBacks: number[];
  /** Index-aligned with `fileNames`: how many of those are in this report. */
  alsoBacksHere: number[];
}

/**
 * How much left the inventory, alongside how many rows did.
 *
 * An assurer's first question about a restatement is its magnitude, and
 * materiality is measured in tonnes, not in rows. Computed once in `assemble`
 * so the banner, the Excel line and the table footer cannot state three
 * different numbers — the `recordCount` lesson, applied before it happens.
 */
export interface ReportWithdrawnTotals {
  count: number;
  /** Sum over the withdrawn rows that HAD a figure. */
  tCo2e: number;
  /** Withdrawn rows whose category has no emission factor, so nothing was
   *  removed from the totals by withdrawing them (WP17 — Water). Disclosed
   *  rather than folded in, because "269.9 tCO2e withdrawn" beside 6 rows must
   *  not imply all six carried tonnage. */
  uncalculatedCount: number;
}

/** Everything a report renders — assembled once, shared by PDF/Excel/CSV. */
export interface ReportData {
  template: ReportTemplate;
  templateName: string;
  organisationName: string;
  subsidiaryName: string | null;
  year: number;
  generatedAt: string;
  generatedBy: string;
  status: ReportStatus;
  incompleteRatio: number;
  includeMethodologyNotes: boolean;
  includeEvidenceSummary: boolean;
  summary: EmissionsSummary;
  records: ReportLedgerRow[];
  /** Records withdrawn from this year — disclosed by every format, counted by
   *  none of them. Empty is the normal case and every writer says nothing then.
   *
   *  This is the artifact's disclosure set BY CONSTRUCTION: every writer counts
   *  `withdrawn.length`, never `meta.voidedCount`. The two are computed by
   *  different queries with identical predicates and agree today; if this list
   *  ever gains a cap or a filter, a banner reading the meta would under-report
   *  the very table printed beneath it. `meta.voidedCount` is the SCREEN's
   *  number (it has no list to count). */
  withdrawn: ReportWithdrawnRow[];
  withdrawnTotals: ReportWithdrawnTotals;
  factors: ReportFactorRow[];
  evidenceSummary: ReportEvidenceRow[];
  /** Distinct evidence files behind the ledger's records — a file shared by
   *  several records counts once here, and once per record in `evidenceCount`. */
  evidenceFileTotal: number;
}
