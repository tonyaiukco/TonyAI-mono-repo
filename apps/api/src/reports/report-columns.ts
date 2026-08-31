import { entityLabel } from '@tonyai/shared-types';
import { ANOMALY_BASELINE_PERIODS } from '@tonyai/shared-types';
import { csvField, type CellValue } from '../common/csv-cell';
import type {
  ReportLedgerRow,
  ReportRowBase,
  ReportWithdrawnRow,
  ReportWithdrawnTotals,
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

/**
 * What a flat-export cell may hold before quoting.
 *
 * Re-exported, not redeclared: the type and the transform that consumes it
 * (`../common/csv-cell`) travel together, and every column below is typed
 * against this name.
 */
export type { CellValue };

/**
 * What a PDF cell may hold.
 *
 * A plain string is USER DATA and the writer escapes it. `{ html }` is trusted
 * markup and the trust is spelled out where it is granted, which is the whole
 * point: before F3 the PDF's escaping lived inside two template literals a
 * reviewer read whole, and afterwards it is sixteen renderers, each of which
 * can forget `esc`. A forgotten one puts a user's withdrawal reason into a
 * filed PDF unescaped — a `<` there truncates a cell in the artifact an auditor
 * keeps. Returning a bare string cannot skip escaping, and granting trust is a
 * greppable decision.
 *
 * Same instinct as `csv: null` never being an omission: the unsafe case has to
 * be spelled out.
 *
 * What this does NOT do, stated because the docblock used to imply otherwise:
 * granting trust does not force escaping INSIDE the grant. `rawHtml(userText)`
 * still compiles. The surface went from every cell position to the two grants
 * that interpolate data, and both now defend themselves — but a tagged template
 * that escapes interpolations by default is the shape that makes forgetting
 * inexpressible, and that is filed rather than done here.
 */
export type PdfCell = string | { readonly html: string };

/** Trusted markup, and a place to explain why each time. */
export function rawHtml(html: string): PdfCell {
  return { html };
}

/**
 * Escapes what the PDF interpolates. Quote-unaware on purpose — nothing
 * interpolates into an attribute, and the day something does this must grow
 * `"` and `'` with it.
 */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The PDF's number format — ONE decimal, where the CSV emits full precision.
 * A real cross-format divergence: this is a printed A4 page, and changing the
 * rounding changes an artifact an auditor keeps.
 */
export const pdfNumber = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });

interface PdfSlot<R> {
  readonly label: string;
  /**
   * Right-aligned, i.e. `class="num"`. It has to appear on BOTH the `<th>` and
   * the `<td>` and they must agree; sourcing them from one descriptor is what
   * makes that true. The cell-binding tests check index, not class, so a
   * mismatch between the two literals was invisible.
   */
  readonly num?: boolean;
  readonly cell: (r: R) => PdfCell;
}

interface ExcelSlot<R> {
  readonly label: string;
  /**
   * Returns `CellValue`, and the `number` half is load-bearing: exceljs writes
   * a JS number as a numeric cell and a string as text, so stringifying a
   * tCO₂e stops it summing in the workbook an auditor opens. A shared
   * `format()` helper across the three formats would do exactly that, which is
   * why each format declares its own renderer rather than sharing one.
   */
  readonly cell: (r: R) => CellValue;
  /**
   * This column's cell in the *Withdrawn Records* total row — not "this
   * column's total". On `subsidiary` it is a row LABEL, not an aggregate, and
   * the atom is one the ledger sheet also reads, so the narrower name keeps the
   * door open for a ledger total row later without a collision.
   *
   * Present on exactly two atoms; absent everywhere else, and the writer emits
   * `''` for those.
   *
   * Derived rather than hand-padded: the old total row was ten slots with seven
   * empty strings counted by hand, so its alignment with the header was a
   * property of nobody re-counting.
   */
  readonly withdrawnTotal?: (t: ReportWithdrawnTotals) => CellValue;
}

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
  readonly excel: ExcelSlot<R> | null;
  readonly pdf: PdfSlot<R> | null;
}

/**
 * The body columns, read by BOTH row kinds — one list, not two.
 *
 * THE ORDER OF THIS LIST IS A FILED-ARTIFACT CONTRACT IN THREE FORMATS. CSV
 * column order is parsed by downstream consumers, and since F3 the printed A4
 * page reads it too — so reordering to please one format silently reorders the
 * other two. New columns are APPENDED, never inserted. Four full-array goldens
 * will fail if you do; they ask you to update a literal, which is not the same
 * as asking you to reconsider. A duplicated
 * list is the divergence this file exists to prevent.
 *
 * Typed over `ReportRowBase` (status widened to the full union) so a single
 * vocabulary can serve both. The guarantee that a withdrawn row cannot be
 * written into the ledger is not weakened by that: it lives at the writers'
 * concrete signatures below, which is where a caller meets it.
 */
export const BODY_COLUMNS = [
  { key: 'subsidiary', aggregatable: false,
    csv: { label: 'subsidiary', cell: (r) => r.subsidiaryName },
    excel: { label: 'Subsidiary', cell: (r) => r.subsidiaryName,
             withdrawnTotal: () => 'Total withdrawn' },
    pdf: { label: 'Subsidiary', cell: (r) => r.subsidiaryName } },
  { key: 'reporting_entity', aggregatable: false,
    // `entityLabel` and not an inlined `?? 'Whole company'`: one phrase across
    // all three formats AND the web, which is the door WP20 closed.
    csv: { label: 'reporting_entity', cell: (r) => entityLabel(r) },
    excel: { label: 'Reporting entity', cell: (r) => entityLabel(r) },
    pdf: { label: 'Reporting entity', cell: (r) => entityLabel(r) } },
  { key: 'category', aggregatable: false,
    csv: { label: 'category', cell: (r) => r.category },
    excel: { label: 'Category', cell: (r) => r.category },
    pdf: { label: 'Category', cell: (r) => r.category } },
  { key: 'reporting_period', aggregatable: false,
    csv: { label: 'reporting_period', cell: (r) => r.reportingPeriod },
    excel: { label: 'Reporting period', cell: (r) => r.reportingPeriod },
    // Dropped from the PDF: it is a printed A4 page, and the period VALUE
    // already reads unambiguously.
    pdf: null },
  { key: 'period_value', aggregatable: false,
    csv: { label: 'period_value', cell: (r) => r.periodValue },
    excel: { label: 'Period', cell: (r) => r.periodValue },
    pdf: { label: 'Period', cell: (r) => r.periodValue } },
  { key: 'activity_value', aggregatable: true,
    csv: { label: 'activity_value', cell: (r) => r.activityValue },
    excel: { label: 'Activity value', cell: (r) => r.activityValue },
    // MERGED with the unit, which is why the PDF has no standalone Unit column
    // and is 9 wide where Excel is 11. The unit is escaped; the number is not
    // user data.
    // A BARE STRING, not `rawHtml`: the cell emits no markup, so the writer
    // escapes the whole thing and the hand-written `esc` that used to live
    // inside the template — which nothing tested, and whose deletion left the
    // suite green — is gone by construction.
    pdf: { label: 'Activity', num: true,
           cell: (r) => `${pdfNumber.format(r.activityValue)} ${r.activityUnit}` } },
  // A unit is a word, and words are not summable — but this one sits next to a
  // marked value on a withdrawn row, which is what proves "aggregatable" and
  // not "on a withdrawn row" is the right discriminator.
  { key: 'activity_unit', aggregatable: false,
    csv: { label: 'activity_unit', cell: (r) => r.activityUnit },
    excel: { label: 'Unit', cell: (r) => r.activityUnit },
    pdf: null },
  /**
   * PDF ONLY, and it is there for a named reason: ISO 14064-1 §9.3.1 and GHG
   * Protocol Ch.7 ask a reader to be able to RECOMPUTE the figure, so the
   * printed report carries the normalised quantity and the multiplier that
   * produced it. The flat exports carry the factor appendix instead.
   *
   * This column is why `body()` had to be narrowed in F2: declaring it with two
   * null slots produced nine errors in a list that has nothing to do with it.
   */
  { key: 'normalised', aggregatable: false, csv: null, excel: null,
    pdf: { label: 'Normalised', num: true,
           cell: (r) =>
             r.conversionFactor &&
             Number.isFinite(r.conversionFactor) &&
             r.normalizedValue !== undefined
               ? // The one remaining grant that interpolates data, so both
                 // interpolations defend themselves: the unit through `esc`,
                 // the factor through `Number.isFinite`. `tCo2e` is guarded the
                 // same way where the snapshot is read; `conversionFactor` came
                 // off the same unchecked `as` cast and was not.
                 rawHtml(
                   `${pdfNumber.format(r.normalizedValue)} ${esc(r.normalizedUnit ?? '')} <span class="note">(&times;${r.conversionFactor})</span>`,
                 )
               // An em dash, not a zero: nothing was converted, and a 0 there
               // is a measured quantity of zero.
               : rawHtml('&mdash;') } },
  { key: 'tco2e', aggregatable: true,
    // `??` on an explicit null, never `||` and never `?? 0`: a category with no
    // factor has no figure, and a zero there is a measured quantity of zero.
    csv: { label: 'tco2e', cell: (r) => r.tCo2e ?? NOT_CALCULATED },
    // A text cell, not an empty numeric one: a blank in a tCO₂e column sums as
    // zero the moment someone drags a SUM over it — the same misstatement as
    // writing 0, only harder to notice.
    excel: { label: 'tCO₂e', cell: (r) => r.tCo2e ?? NOT_CALCULATED,
             withdrawnTotal: (t) => t.tCo2e },
    pdf: { label: 'tCO₂e', num: true,
           cell: (r) =>
             r.tCo2e === null
               ? rawHtml(`<span class="note">${NOT_CALCULATED}</span>`)
               : pdfNumber.format(r.tCo2e) } },
  // The authoritative discriminator between the two row kinds. Never marked —
  // a withdrawn row must keep saying `voided`.
  { key: 'status', aggregatable: false,
    csv: { label: 'status', cell: (r) => r.status },
    excel: { label: 'Status', cell: (r) => r.status },
    pdf: { label: 'Status', cell: (r) => r.status } },
  { key: 'evidence_files', aggregatable: true,
    csv: { label: 'evidence_files', cell: (r) => r.evidenceCount },
    excel: { label: 'Evidence files', cell: (r) => r.evidenceCount },
    pdf: { label: 'Evidence', num: true,
           cell: (r) => String(r.evidenceCount) } },
  { key: 'anomaly_flag', aggregatable: true,
    csv: { label: 'anomaly_flag', cell: (r) => anomalyCell(r) },
    excel: { label: 'Anomaly flag', cell: (r) => anomalyCell(r) },
    // Dropped from the PDF, like the reporting period: A4 width.
    pdf: null },
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
  /** The same slot shape the body columns use, so per-format participation has
   *  ONE encoding in this file rather than a bare label plus a nullable second
   *  one. `null` where the Excel withdrawn sheet does not carry the column: it
   *  restates by column rather than by suffix, so `voided_activity_value` and
   *  `voided_tco2e` are that sheet's own `Activity value` and `tCO₂e removed`.
   *  F3 did NOT add a `pdf` slot here: the printed table free-stands both
   *  renderers, because its empty is an em dash where Excel's is a blank. A
   *  fourth partially-populated axis for two of four disclosures costs more
   *  than it buys. */
  readonly excel: { readonly label: string } | null;
  /** The body column whose real value moves here on a withdrawn row, or `null`
   *  for a disclosure with no counterpart. This link is what the parity check
   *  below reads. */
  readonly restates: string | null;
  readonly cell: (r: ReportWithdrawnRow) => CellValue;
}

export const DISCLOSURE_COLUMNS = [
  { key: 'voided_activity_value', label: 'voided_activity_value', excel: null,
    restates: 'activity_value', cell: (r) => r.activityValue },
  { key: 'voided_tco2e', label: 'voided_tco2e', excel: null,
    restates: 'tco2e', cell: (r) => r.tCo2e ?? NOT_CALCULATED },
  { key: 'voided_at_utc', label: 'voided_at_utc', excel: { label: 'Withdrawn (UTC)' },
    restates: null, cell: (r) => r.voidedAt ?? '' },
  { key: 'void_reason', label: 'void_reason', excel: { label: 'Reason' },
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
 *
 * Scoped to the CSV renderer, which is the right scope rather than an oversight:
 * the `WITHDRAWN` marker is CSV-only, so a column absent from the CSV cannot be
 * mis-marked. If that rule ever reaches a second format, this must widen too.
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
 * The header, and the only one: withdrawn records share this table rather than
 * getting a second file, because one header row keeps the export parseable.
 */
export function csvHeader(): string {
  return [
    ...BODY_COLUMNS.filter((c) => c.csv).map((c) => c.csv!.label),
    ...DISCLOSURE_COLUMNS.map((d) => d.label),
  ]
    // Identity for all fifteen labels, which is the point: they are module
    // literals today, and the golden that pins them fails with a message
    // asking you to update a literal — so a sixteenth column with a hostile
    // label could be waved through by editing both sides. The header is a row.
    .map(csvField)
    .join(',');
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
    .map(csvField)
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
    .map(csvField)
    .join(',');
}

// --- Excel -------------------------------------------------------------------

/**
 * A body column by key, narrowed to THAT column's type rather than the union of
 * all of them.
 *
 * The narrowing is not tidiness. Without it `body('tco2e').excel` is the union
 * of every excel slot, so two things break the moment a column declares a slot
 * as `null` — which F3 must do, since `Normalised` is PDF-only. Measured: adding
 * that column produced NINE errors in `WITHDRAWN_SHEET`, a list that has nothing
 * to do with it, one of them a spread of a possibly-null slot. `{ ...null, label }`
 * is a valid object with no `cell`, i.e. `c.cell is not a function` thrown in the
 * middle of generating a workbook. Whoever hit that wall would have widened the
 * annotation to silence it and re-admitted the crash.
 *
 * The second payoff: `total` becomes a REQUIRED property of the atom that has
 * one, so deleting it is a compile error. Before this it typechecked clean, and
 * the withdrawn sheet's total row printed `''` under `tCO₂e removed` — an
 * artifact naming N withdrawn records and refusing to say how much tonnage left.
 */
type BodyColumn<K extends (typeof BODY_COLUMNS)[number]['key']> = Extract<
  (typeof BODY_COLUMNS)[number],
  { key: K }
>;

function body<K extends (typeof BODY_COLUMNS)[number]['key']>(key: K): BodyColumn<K> {
  return BODY_COLUMNS.find((c) => (c.key as string) === key)! as BodyColumn<K>;
}

type DisclosureCol<K extends (typeof DISCLOSURE_COLUMNS)[number]['key']> = Extract<
  (typeof DISCLOSURE_COLUMNS)[number],
  { key: K }
>;

function disclosure<K extends (typeof DISCLOSURE_COLUMNS)[number]['key']>(
  key: K,
): DisclosureCol<K> {
  return DISCLOSURE_COLUMNS.find((d) => (d.key as string) === key)! as DisclosureCol<K>;
}

/**
 * The `Raw Activity Data` sheet: every body column, in order.
 *
 * The Excel ledger is exactly the CSV's body set — same columns, same order,
 * different labels — so it needs no list of its own.
 *
 * Membership can already diverge without one: `excel` is a REQUIRED key on
 * `ColumnSpec`, so a CSV-only column has to spell `excel: null` and cannot
 * silently appear here. What this filter DOES couple is ORDER — both sheets
 * read one ordered list, so reordering `BODY_COLUMNS` to please Excel silently
 * reorders a filed CSV. That, and only that, would force an explicit list.
 */
export function excelLedgerHeader(): string[] {
  return BODY_COLUMNS.filter((c) => c.excel).map((c) => c.excel!.label);
}

export function excelLedgerRow(r: ReportLedgerRow): CellValue[] {
  return BODY_COLUMNS.filter((c) => c.excel).map((c) => c.excel!.cell(r));
}

/**
 * The `Withdrawn Records` sheet — a DIFFERENT table, not a variant of the
 * ledger, which is why it gets its own list.
 *
 * It drops Status, Evidence files and Anomaly flag, adds the withdrawal's date
 * and reason, and renames tCO₂e to make the direction explicit. And note what
 * it does NOT do: the values are REAL and unmarked. The `WITHDRAWN` marker
 * belongs to the CSV alone, because only the CSV shares one table with the
 * counted ledger. Summing this sheet answers "how much was withdrawn", which is
 * a question worth being able to ask.
 */
const WITHDRAWN_SHEET: readonly ExcelSlot<ReportWithdrawnRow>[] = [
  body('subsidiary').excel,
  body('reporting_entity').excel,
  body('category').excel,
  body('reporting_period').excel,
  body('period_value').excel,
  body('activity_value').excel,
  body('activity_unit').excel,
  // Same cell, different label: "removed" states the direction on a sheet whose
  // whole subject is subtraction. One renderer, so the number cannot disagree
  // with the ledger's.
  { ...body('tco2e').excel, label: 'tCO₂e removed' },
  { ...disclosure('voided_at_utc').excel!, cell: disclosure('voided_at_utc').cell },
  {
    ...disclosure('void_reason').excel!,
    cell: disclosure('void_reason').cell,
    withdrawnTotal: (t) =>
      t.uncalculatedCount > 0
        ? `${t.uncalculatedCount} of these carry no emissions figure`
        : '',
  },
];

/**
 * Fails to compile if the withdrawn sheet's tonnage total is removed.
 *
 * Optional on `ExcelSlot`, because most columns have none — so deleting it from
 * the `tco2e` atom is otherwise silent, and the sheet's total row then prints
 * `''` under `tCO₂e removed`: an artifact naming N withdrawn records and
 * refusing to say how much tonnage left. Only one runtime assertion caught that.
 *
 * Writable at all only because `body()` narrows to the specific atom; against
 * the union of every excel slot this line is `TS2339`.
 */
const _withdrawnTonnageTotal: (t: ReportWithdrawnTotals) => CellValue =
  body('tco2e').excel.withdrawnTotal;
void _withdrawnTonnageTotal;

export function excelWithdrawnHeader(): string[] {
  return WITHDRAWN_SHEET.map((c) => c.label);
}

export function excelWithdrawnRow(r: ReportWithdrawnRow): CellValue[] {
  return WITHDRAWN_SHEET.map((c) => c.cell(r));
}

/**
 * The sheet's total row, derived from the same list that built its header.
 *
 * It used to be ten literal slots with seven empty strings, so the tonnage
 * landing under `tCO₂e removed` was a property of nobody re-counting. Deriving
 * it from the same list removes that class — but ONLY while this maps
 * `WITHDRAWN_SHEET`, and nothing in the type system says it must. Deriving from
 * `BODY_COLUMNS` instead — the plausible copy-paste from `excelLedgerRow` above
 * — passed the entire suite: the tonnage is at index 7 in both lists by
 * coincidence, so every name lookup agreed while the row ran a cell past the
 * last column and silently dropped the uncalculated-count disclosure. The
 * spec's arity assertion is what actually holds this; the derivation does not.
 */
export function excelWithdrawnTotalRow(t: ReportWithdrawnTotals): CellValue[] {
  return WITHDRAWN_SHEET.map((c) => c.withdrawnTotal?.(t) ?? '');
}

// --- PDF ---------------------------------------------------------------------

/** Render one cell's inner HTML: a plain string is user data and is escaped. */
function pdfInner(v: PdfCell): string {
  return typeof v === 'string' ? esc(v) : v.html;
}

function pdfCells<R>(slots: readonly PdfSlot<R>[], r: R): string {
  return slots
    .map((c) => `<td${c.num ? ' class="num"' : ''}>${pdfInner(c.cell(r))}</td>`)
    .join('');
}

function pdfHead<R>(slots: readonly PdfSlot<R>[]): string {
  return slots
    // Escaped even though every label is a module literal today: `label` is
    // typed `string`, and a per-report dynamic one would otherwise be raw.
    .map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`)
    .join('');
}

/** The printed ledger: nine columns, narrower than the other two on purpose. */
const PDF_LEDGER: readonly PdfSlot<ReportRowBase>[] = BODY_COLUMNS.filter(
  (c) => c.pdf,
).map((c) => c.pdf!);

export function pdfLedgerHeadRow(): string {
  return `<tr>${pdfHead(PDF_LEDGER)}</tr>`;
}

export function pdfLedgerRow(r: ReportLedgerRow): string {
  return `<tr>${pdfCells(PDF_LEDGER, r)}</tr>`;
}

/**
 * The printed restatement table: seven columns, and it carries NO activity
 * quantity at all — an A4-width decision, and why it is 7 where Excel is 10.
 * Its own list, like the Excel sheet's, because it is a different table.
 */
const PDF_WITHDRAWN: readonly PdfSlot<ReportWithdrawnRow>[] = [
  body('subsidiary').pdf,
  body('reporting_entity').pdf,
  body('category').pdf,
  body('period_value').pdf,
  { ...body('tco2e').pdf, label: 'tCO₂e removed' },
  // The literal glyph, not `&mdash;`: these are plain strings, so the writer
  // escapes them, and an entity here would print as visible `&mdash;` text in a
  // filed PDF. Its sibling eight lines up uses the entity because that one is a
  // `rawHtml` grant. One plausible "unify these" edit breaks exactly this way.
  { label: 'Withdrawn (UTC)', cell: (r) => r.voidedAt ?? '—' },
  { label: 'Reason', cell: (r) => r.voidReason ?? '—' },
];

export function pdfWithdrawnHeadRow(): string {
  return `<tr>${pdfHead(PDF_WITHDRAWN)}</tr>`;
}

export function pdfWithdrawnRow(r: ReportWithdrawnRow): string {
  return `<tr>${pdfCells(PDF_WITHDRAWN, r)}</tr>`;
}

/**
 * The printed total row, declared as explicit spans rather than derived.
 *
 * Deliberately NOT the Excel total row's shape, and not derivable from a
 * per-column `total?` either — the two diverge in three independent ways, one
 * of them content. Here the tonnage is FORMATTED and bolded rather than a raw
 * number; the label occupies one wide cell rather than column 1 alone; and the
 * uncalculated-record note is ABSENT, because on the PDF it lives in the banner
 * above the table.
 *
 * And spans must not be run-length-encoded from "columns without a total": that
 * yields `<td>Total withdrawn</td><td colspan="3">`, where this produces
 * `<td colspan="4">Total withdrawn</td>` — the label lands in a narrow first
 * column and wraps, changing the printed page.
 *
 * TWO invariants matter and only one was asserted. The spans summing to the
 * table's width was; where the tonnage LANDS was not, so `3/1/2`... `3/1/3`
 * still sums to seven and puts the figure under "Period". Nor was the figure
 * itself: printing `t.count` here made the footer contradict the banner three
 * lines above it, with the whole suite green. Both are asserted now.
 */
export function pdfWithdrawnTotalRow(t: ReportWithdrawnTotals): string {
  const cells: readonly { html: string; span: number; num?: boolean }[] = [
    { html: '<strong>Total withdrawn</strong>', span: 4 },
    { html: `<strong>${pdfNumber.format(t.tCo2e)}</strong>`, span: 1, num: true },
    // Derived, so a new withdrawn column self-aligns instead of relying on the
    // spec to notice. The FOUR above stays a literal — deriving it by
    // run-length-encoding "columns without a total" would split the label into
    // its own narrow cell and change the printed page.
    { html: '', span: PDF_WITHDRAWN.length - 5 },
  ];
  return `<tr>${cells
    .map(
      (c) =>
        `<td${c.num ? ' class="num"' : ''}${c.span > 1 ? ` colspan="${c.span}"` : ''}>${c.html}</td>`,
    )
    .join('')}</tr>`;
}
