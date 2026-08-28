import { entityLabel } from '@tonyai/shared-types';
import { ANOMALY_BASELINE_PERIODS } from '@tonyai/shared-types';
import type {
  ReportLedgerRow,
  ReportRowBase,
  ReportWithdrawnRow,
} from './report-data';

/**
 * The report exports' column vocabulary, declared once.
 *
 * Before this file the writers held THIRTEEN hand-maintained literals — the
 * PDF's `<th>`s and its `<td>`s, the Excel header and its rows, the CSV header
 * and its rows, once for the ledger and again for withdrawn records, plus two
 * positionally-coupled total rows. Adding a column was six to ten edits, and
 * the recipe for keeping them in step was "check every one", which is a
 * reminder rather than a mechanism.
 *
 * WP22 F1 moves the CSV to these descriptors. The Excel and PDF writers still
 * hold their own literals and move in F2 and F3; until then the two coexist,
 * which is safe because #72's column-order goldens and #76's cell bindings pin
 * both — a descriptor that drifted from a literal fails.
 *
 * The formats deliberately DISAGREE (ledger: PDF 9 / Excel 11 / CSV 15), and
 * every divergence is load-bearing, so a flat `{ key, label, get }[]` cannot
 * express them. The shape here is per-format participation with per-format
 * renderers; `pdf` and `excel` slots arrive with the writers that read them.
 */

/**
 * What every export writes where a tCO₂e figure would go when the record's
 * category has no emission factor. One constant so the PDF, the Excel sheet and
 * the CSV cannot say three different things about the same row.
 */
export const NOT_CALCULATED = 'Not calculated';

/**
 * What the anomaly column says for a record the VAR §4 rule never ran on.
 *
 * A blank in that column has always meant "checked, nothing unusual". Since
 * 2026-08-27 the rule needs three priors, so a blank would also cover "never
 * checked" — and on the dev database that is 30 of 96 committed records, in the
 * artifact an auditor keeps. Same instinct as NOT_CALCULATED above: say the
 * absence rather than print something indistinguishable from a measurement.
 */
export const NOT_EVALUATED = 'Not evaluated';

/**
 * ONE renderer for every format, because the writers each held their own column
 * literals and this is exactly the kind of difference that survives review —
 * WP20 shipped a CSV and an Excel from one request that disagreed about
 * withdrawn rows for precisely this reason.
 */
export function anomalyCell(r: {
  anomalyFlag: boolean;
  anomalyEvaluated: boolean;
  anomalyBaselinePriorCount: number | null;
}): string {
  if (r.anomalyFlag) return 'yes';
  if (r.anomalyEvaluated) return '';
  const priors = r.anomalyBaselinePriorCount;
  // Each absence names itself: the reader of a filed report cannot ask which
  // one it was, and the three have different remedies — a factor, more months,
  // or nothing at all.
  if (priors === null) return `${NOT_EVALUATED} (no figure)`;
  if (priors >= ANOMALY_BASELINE_PERIODS) return `${NOT_EVALUATED} (baseline is zero)`;
  return `${NOT_EVALUATED} (${priors} of ${ANOMALY_BASELINE_PERIODS} priors)`;
}

/**
 * What the CSV — and ONLY the CSV — writes in every aggregatable column of a
 * withdrawn row.
 *
 * The marker is not a property of the column. It is a property of SHARING ONE
 * TABLE with the counted ledger, and the CSV is the only format that does:
 * anything numeric there would be summed straight back into a total the record
 * was deliberately taken out of. The Excel puts withdrawn rows on their own
 * sheet and the PDF in its own table, so both correctly print the real values
 * unmarked — summing those answers a different question, on purpose.
 *
 * Whoever writes the `excel` or `pdf` slot in F2/F3 should read that twice:
 * inheriting this rule into either would destroy that format's disclosure.
 */
export const WITHDRAWN = 'Withdrawn';

/** What a flat-export cell may hold before quoting. */
export type CellValue = string | number;

interface CsvSlot<R> {
  /** The machine-readable header. Snake case, and spelled with the STATUS word
   *  (`voided`) rather than the human one (`withdrawn`), matching the `status`
   *  column that discriminates the two row kinds. */
  readonly label: string;
  readonly cell: (r: R) => CellValue;
}

export interface ColumnSpec<R> {
  /** Machine identity, never printed. */
  readonly key: string;
  /**
   * Could a reader SUM or COUNT this column?
   *
   * DECLARED, never inferred from the value's type, and this is the whole point
   * of the file. `anomaly_flag` holds a word and IS aggregatable — "how many
   * anomalies are in this file" is a question a reader asks. `activity_unit`
   * holds a word and is NOT. Classifying by "is it a number?" gets both wrong.
   *
   * This property is what puts the `WITHDRAWN` marker on a row in a SHARED
   * table — the CSV, and nothing else. Excel and PDF give withdrawn records
   * their own sheet and table and print real values there.
   * Before it, the four markers were placed by hand-counted LIST POSITION with
   * nothing tying a marker to its column, and the first cut of that protected
   * `tco2e` alone: exported activity was overstated by 429,815 units — 394 MWh
   * of electricity and 35,984 L of fuel — in an artifact a reader trusts.
   * Energy consumption is a reported figure in its own right (GRI 302-1,
   * CSRD E1-5), so that was a misstatement, not a cosmetic slip.
   */
  readonly aggregatable: true | false;
  /** Explicit `null` for a format this column does not appear in — never
   *  omission. A column absent from a format is a decision someone made, and an
   *  absent key is invisible in review. */
  readonly csv: CsvSlot<R> | null;
}

/**
 * The body columns, read by BOTH row kinds — one list, not two. A duplicated
 * list is the divergence this file exists to prevent.
 *
 * Typed over `ReportRowBase` (status widened to the full union) so a single
 * vocabulary can serve both. The guarantee that a withdrawn row cannot be
 * written into the ledger is not weakened by that: it lives at the writers'
 * concrete signatures below, which is where a caller meets it.
 */
export const BODY_COLUMNS = [
  { key: 'subsidiary', aggregatable: false,
    csv: { label: 'subsidiary', cell: (r) => r.subsidiaryName } },
  { key: 'reporting_entity', aggregatable: false,
    // `entityLabel` and not an inlined `?? 'Whole company'`: one phrase across
    // all three formats AND the web, which is the door WP20 closed.
    csv: { label: 'reporting_entity', cell: (r) => entityLabel(r) } },
  { key: 'category', aggregatable: false,
    csv: { label: 'category', cell: (r) => r.category } },
  { key: 'reporting_period', aggregatable: false,
    csv: { label: 'reporting_period', cell: (r) => r.reportingPeriod } },
  { key: 'period_value', aggregatable: false,
    csv: { label: 'period_value', cell: (r) => r.periodValue } },
  { key: 'activity_value', aggregatable: true,
    csv: { label: 'activity_value', cell: (r) => r.activityValue } },
  // A unit is a word, and words are not summable — but this one sits next to a
  // marked value on a withdrawn row, which is what proves "aggregatable" and
  // not "on a withdrawn row" is the right discriminator.
  { key: 'activity_unit', aggregatable: false,
    csv: { label: 'activity_unit', cell: (r) => r.activityUnit } },
  { key: 'tco2e', aggregatable: true,
    // `??` on an explicit null, never `||` and never `?? 0`: a category with no
    // factor has no figure, and a zero there is a measured quantity of zero.
    csv: { label: 'tco2e', cell: (r) => r.tCo2e ?? NOT_CALCULATED } },
  // The authoritative discriminator between the two row kinds. Never marked —
  // a withdrawn row must keep saying `voided`.
  { key: 'status', aggregatable: false,
    csv: { label: 'status', cell: (r) => r.status } },
  { key: 'evidence_files', aggregatable: true,
    csv: { label: 'evidence_files', cell: (r) => r.evidenceCount } },
  { key: 'anomaly_flag', aggregatable: true,
    csv: { label: 'anomaly_flag', cell: (r) => anomalyCell(r) } },
  // `as const satisfies`, not a plain annotation: the annotation widens every
  // `key` to `string`, and the parity check below has to read the literals.
  // `satisfies` still checks the shape, so the row type stays pinned.
] as const satisfies readonly ColumnSpec<ReportRowBase>[];

/**
 * The restatement block: what a withdrawn row carries INSTEAD of the values its
 * body columns had.
 *
 * A separate list, not ordinary atoms with `aggregatable: true`, and the
 * separation is the safety property. Fold these in and the marker rule blanks
 * them — which destroys the disclosure itself, leaving a file that says a
 * figure was withdrawn and refuses to say what.
 */
export interface DisclosureColumn {
  readonly key: string;
  readonly label: string;
  /** The body column whose real value moves here on a withdrawn row, or `null`
   *  for a disclosure with no counterpart. This link is what the parity check
   *  below reads. */
  readonly restates: string | null;
  readonly cell: (r: ReportWithdrawnRow) => CellValue;
}

export const DISCLOSURE_COLUMNS = [
  { key: 'voided_activity_value', label: 'voided_activity_value',
    restates: 'activity_value', cell: (r) => r.activityValue },
  { key: 'voided_tco2e', label: 'voided_tco2e',
    restates: 'tco2e', cell: (r) => r.tCo2e ?? NOT_CALCULATED },
  { key: 'voided_at_utc', label: 'voided_at_utc',
    restates: null, cell: (r) => r.voidedAt ?? '' },
  { key: 'void_reason', label: 'void_reason',
    restates: null, cell: (r) => r.voidReason ?? '' },
] as const satisfies readonly DisclosureColumn[];

/**
 * Aggregatable body columns that are MARKED on a withdrawn row but not restated
 * anywhere.
 *
 * `evidence_files` and `anomaly_flag` are summable — "how many invoices back
 * this inventory", "how many anomalies are in this file" — so leaving their
 * real values in place would inflate both answers, and they carry the marker.
 * But no `voided_*` column receives them, so the values are simply not
 * disclosed. That asymmetry is the CONTRACT AS SHIPPED, not an oversight of
 * this refactor: adding the two missing disclosures would change a filed
 * artifact from 15 columns to 17, and the CSV's own rule is that new columns
 * are appended and never inserted. Recorded here, and raised as a product
 * question rather than settled by a refactor.
 *
 * Listed explicitly so the parity check below can be TOTAL in the direction
 * that matters — every marker is accounted for, either by a disclosure or by
 * this list — instead of merely one-directional.
 */
export const MARKED_WITHOUT_DISCLOSURE = ['evidence_files', 'anomaly_flag'] as const;

/**
 * Fails to compile if a marker has nowhere to go.
 *
 * Every aggregatable body column must be either restated by a disclosure column
 * or named in `MARKED_WITHOUT_DISCLOSURE`. Add an aggregatable column and
 * forget both, and this stops being `true`.
 *
 * This is the check that would have caught the 429,815-unit misstatement at
 * compile time. It follows the `Exact<A, B>` idiom already used in
 * `activity-records/status-parity.ts`, and like that file it has no runtime job.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** DERIVED from the lists, never hand-written — a hand-written union would not
 *  change when someone adds an aggregatable column, which is the exact moment
 *  this check exists to fire. */
type Aggregatable = Extract<
  (typeof BODY_COLUMNS)[number],
  { aggregatable: true }
>['key'];
type Restated = Extract<
  (typeof DISCLOSURE_COLUMNS)[number],
  { restates: string }
>['restates'];
type Accounted = Restated | (typeof MARKED_WITHOUT_DISCLOSURE)[number];

export const _markerParity: Exact<Aggregatable, Accounted> = true;

/**
 * Fails to compile if a column whose cell can return a NUMBER is declared
 * non-aggregatable.
 *
 * The check above verifies ACCOUNTING — every declared marker has somewhere to
 * go. It cannot verify CLASSIFICATION, because `aggregatable` is a human
 * judgement with no oracle, and that leaves the 429,815-unit  class reachable from
 * the other direction: add a column with `aggregatable: false` whose cell
 * returns a number, and every withdrawn row prints its real value into a column
 * a reader sums. Measured before this existed — it compiled clean, and the only
 * thing that fired was the header golden, whose message asks you to update a
 * literal rather than to reconsider aggregability.
 *
 * ONE-WAY on purpose. A numeric cell must be declared aggregatable; the reverse
 * is NOT required, because `anomaly_flag` returns a string and is summable all
 * the same ("how many anomalies are in this file"). Words that count still need
 * a human to say so.
 */
type UndeclaredNumeric = (typeof BODY_COLUMNS)[number] extends infer C
  ? C extends {
      key: infer K;
      aggregatable: false;
      csv: { cell: (r: ReportRowBase) => infer V };
    }
    ? number extends V
      ? K
      : never
    : never
  : never;

export const _numericParity: [UndeclaredNumeric] extends [never]
  ? true
  : UndeclaredNumeric = true;

/**
 * RFC-4180 quoting plus spreadsheet-formula neutralisation, applied by the row
 * writers below to EVERY cell as the last transform.
 *
 * Two properties are load-bearing and neither is obvious:
 *
 * ORDER. The formula prefix runs BEFORE the quote test, so a `'`-prefixed
 * string is then quoted only if it also contains a separator. Reversing them
 * yields `'"…"`.
 *
 * THE BARE `\r`. Most parsers end a record on it, so a withdrawal reason
 * containing one would split into a second row — a fabricated ledger line, in
 * the artifact a reader trusts, behind no database row and no audit entry. A
 * browser sends `\r\n`, so reaching this needs a deliberate API call; it is
 * still a forgery.
 *
 * It must never move into a per-column renderer: one column could then opt out,
 * and the opt-out is a forged row.
 */
function quote(v: CellValue): string {
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The header, and the only one: withdrawn records share this table rather than
 * getting a second file, because one header row keeps the export parseable.
 */
export function csvHeader(): string {
  return [
    ...BODY_COLUMNS.filter((c) => c.csv).map((c) => c.csv!.label),
    ...DISCLOSURE_COLUMNS.map((d) => d.label),
  ].join(',');
}

/**
 * A counted ledger row.
 *
 * NON-GENERIC, and so is its withdrawn sibling, rather than one
 * `csvRow<R>(columns, row)`. `apps/api/tsconfig.json` does not extend the root
 * config and does not set `strict`, so `strictFunctionTypes` is OFF and
 * parameters are checked bivariantly in this package — the usual "contravariance
 * rejects the wrong row type" protection does not exist here. Two concrete
 * entry points make passing a withdrawn row a plain object-assignability error
 * (`'voided'` is not in `Exclude<ActivityRecordStatus, 'voided'>`), which fires
 * regardless of that flag. The spec pins it with `@ts-expect-error`.
 *
 * TWO LIMITS on that claim, both measured rather than assumed.
 *
 * It protects every NEW call site. The one existing production caller is not
 * protected by the type at all: `reports.service.ts` narrows with an `as
 * Exclude<…>` when it builds the ledger, so widening the query to include
 * `voided` compiles clean. That cast predates this work; a runtime narrowing in
 * `assemble` is the real fix and does not belong in a byte-identical refactor.
 *
 * And a column whose renderer is typed over the WRONG row kind is rejected by
 * `as const` — which preserves each lambda's declared parameter type into the
 * union, so the call site is checked — not by these signatures. Dropping
 * `as const` would remove that, and the `@ts-expect-error` probe would not
 * notice; it breaks `_markerParity` first, which is what makes the chain
 * self-reinforcing rather than merely lucky.
 */
export function csvLedgerRow(r: ReportLedgerRow): string {
  return [
    ...BODY_COLUMNS.filter((c) => c.csv).map((c) => c.csv!.cell(r)),
    // Empty for a counted row, and empty is the right word: this row was never
    // withdrawn.
    ...DISCLOSURE_COLUMNS.map(() => ''),
  ]
    .map(quote)
    .join(',');
}

/**
 * A withdrawn row, in the same table.
 *
 * The marker lands on every aggregatable column BY DECLARED PROPERTY. It used
 * to land by hand-counted list position, which is how the first cut protected
 * `tco2e` alone and left the real `activity_value` in place.
 */
export function csvWithdrawnRow(r: ReportWithdrawnRow): string {
  return [
    ...BODY_COLUMNS.filter((c) => c.csv).map((c) =>
      c.aggregatable ? WITHDRAWN : c.csv!.cell(r),
    ),
    ...DISCLOSURE_COLUMNS.map((d) => d.cell(r)),
  ]
    .map(quote)
    .join(',');
}
