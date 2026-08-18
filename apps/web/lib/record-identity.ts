// Which form changes mean "a different record", and which mean "move this one".
//
// Extracted from the Data Entry page because the distinction is the whole of
// WP18 PR 1 and it was a five-term boolean buried in a `useEffect`. Getting it
// wrong is not a UI glitch in either direction:
//
//   too broad  — a `locationId` change was treated as a different record, so
//                the client dropped the edit and POSTed. Since the uniqueness
//                index counts `location_id`, the write SUCCEEDED and produced a
//                second row for the same month, and both feed the emissions
//                total. Six such pairs exist in the seeded data.
//   too narrow — dropping `category` from the list is the bug this guard was
//                built for: opening a Fuel Q3 draft, switching to Electricity
//                Q1 and saving overwrote the Fuel record with the Electricity
//                numbers and reported "Draft saved".
import { isRecordableWithoutFactor } from "@tonyai/shared-types";
import { NOT_CALCULATED_LABEL } from "@/lib/calculation-display";
import type { ReportingPeriod } from "@/lib/types";

/**
 * The part of a record's identity the form can change.
 *
 * `subsidiaryId` is absent on purpose — that select calls `resetForm()`, so it
 * never reaches this comparison, and the API refuses to move a record between
 * subsidiaries in any case.
 */
export interface RecordIdentity {
  category: string;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  /** `""` means the whole subsidiary; otherwise a location id. */
  locationId: string;
}

/**
 * True when the form has moved off the record it opened, i.e. the next save
 * must create a NEW record rather than touch the one that was loaded.
 *
 * **`locationId` is deliberately not compared.** Changing the reporting entity
 * of an open record is a re-attribution: the API has supported it on update
 * since 2026-07-07 — it re-targets the row and recomputes the snapshot from the
 * new entity's geography — and it is the only way a user can fix a
 * mis-attributed record. Counting it here is what turned that fix into the
 * duplicate it was meant to resolve.
 */
export function hasMovedOffRecord(
  opened: RecordIdentity,
  form: RecordIdentity,
): boolean {
  return (
    opened.category !== form.category ||
    opened.reportingYear !== form.reportingYear ||
    opened.reportingPeriod !== form.reportingPeriod ||
    opened.periodValue !== form.periodValue
  );
}

/**
 * The sentence shown while an open record's location has been changed but not
 * yet saved, or `null` when nothing is being moved.
 *
 * Every other field in the reporting-scope card starts a fresh record; this one
 * mutates the record in place, so the difference has to be visible BEFORE the
 * save rather than discovered afterwards in the audit trail.
 *
 * Returns a finished string rather than fragments for the caller to assemble in
 * JSX — `{expr}` followed by a newline drops the separating space, which shipped
 * twice in WP17 ("12 entries arerecorded").
 */
export function describeMove(
  opened: RecordIdentity | null,
  form: Pick<RecordIdentity, "locationId">,
  /** Site names by id, for the subsidiary currently selected. */
  locationNames: ReadonlyMap<string, string>,
): string | null {
  if (!opened) return null;
  if (opened.locationId === form.locationId) return null;
  const nameOf = (id: string) =>
    id ? (locationNames.get(id) ?? "another site") : "the whole company";
  const to = nameOf(form.locationId);
  const move = `Saving moves this record from ${nameOf(opened.locationId)} to ${to}. It is not copied`;
  // The second clause is only true where a factor exists. `Water` is recordable
  // without one and stores an explicit "not calculated" snapshot, so promising
  // a recalculated emission factor would contradict the figure shown for the
  // same record two cards away.
  return isRecordableWithoutFactor(opened.category)
    ? `${move} — and it still has no emission factor, so its figure stays "${NOT_CALCULATED_LABEL}".`
    : `${move} — the emission factor is recalculated for its geography.`;
}
