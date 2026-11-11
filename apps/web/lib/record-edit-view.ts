// Data Entry's explicit Edit mode, Recall and "Copy to new draft" (UAT round 2,
// BUG-R2-03; OpenSpec `uat2-record-edit`, design D5). Pure, so the band, the
// evidence plan and the row actions are pinned by specs rather than by a page.
//
// The page has two ways to hold a record:
//   - OPENED (a list row, a dashboard link, the record just saved): moving its
//     category, year or period starts a NEW record — `hasMovedOffRecord`, the
//     guard against the implicit overwrite that once turned a Fuel Q3 draft
//     into Q4.
//   - EDIT MODE (the Edit action, asked for): every identity field changes the
//     SAME record, and the band below says so before the save.
import {
  mayCopyVoidedRecord,
  mayEditRecord,
  mayRecallRecord,
  type ActivityRecordDTO,
  type ReportingPeriod,
} from "@/lib/types";
import type { ViewCopy } from "@/lib/i18n/view-translator";

/** The fields Edit mode can change that make a record a different record. */
export interface EditIdentity {
  category: string;
  /** `""` or null means none. */
  activityType: string | null;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  /** `""` means the whole subsidiary. */
  locationId: string;
}

/** How each identity value is shown, in the user's language. */
export interface EditLabels {
  category: (category: string) => string;
  activityType: (category: string, activityType: string) => string;
  period: (periodValue: string) => string;
  /** `""` is the whole company. */
  location: (locationId: string) => string;
}

export type EditBandKey =
  | "edit.category"
  | "edit.activityType"
  | "edit.year"
  | "edit.period"
  | "edit.location"
  | "edit.none";

const typeOf = (value: string | null) => value ?? "";

/**
 * One finished sentence per identity field the save will change, from the
 * record's stored value to the form's, in a fixed order. Empty when nothing
 * that makes the record a different record changes (a value-only edit). A
 * type line is not shown beside a category line: the category's own fields are
 * cleared, so its type is new rather than changed.
 */
export function describeEdit(
  original: EditIdentity,
  form: EditIdentity,
  labels: EditLabels,
  { t }: ViewCopy<EditBandKey>,
): string[] {
  const lines: string[] = [];
  const categoryChanged = original.category !== form.category;
  if (categoryChanged) {
    lines.push(t("edit.category", { from: labels.category(original.category), to: labels.category(form.category) }));
  } else if (typeOf(original.activityType) !== typeOf(form.activityType)) {
    const name = (value: string) => (value ? labels.activityType(form.category, value) : t("edit.none"));
    lines.push(t("edit.activityType", { from: name(typeOf(original.activityType)), to: name(typeOf(form.activityType)) }));
  }
  if (original.reportingYear !== form.reportingYear) {
    lines.push(t("edit.year", { from: original.reportingYear, to: form.reportingYear }));
  }
  if (original.reportingPeriod !== form.reportingPeriod || original.periodValue !== form.periodValue) {
    lines.push(t("edit.period", { from: labels.period(original.periodValue), to: labels.period(form.periodValue) }));
  }
  if (original.locationId !== form.locationId) {
    lines.push(t("edit.location", { from: labels.location(original.locationId), to: labels.location(form.locationId) }));
  }
  return lines;
}

/**
 * What the save does with the record's files (owner decision D1):
 *   - `removeAll`: the category changes, so every file comes off and the user
 *     must confirm it — the API refuses the save otherwise
 *     (`evidence_detach_required`);
 *   - `choose`: the activity type, year, period or location changes, and each
 *     file is kept unless the user removes it;
 *   - `none`: nothing that would make a file wrong changes, or there are no files.
 */
export type EvidencePlanMode = "none" | "removeAll" | "choose";

export interface EvidencePlan {
  mode: EvidencePlanMode;
  /** The ids the save sends as `detachEvidenceIds`. */
  detachIds: string[];
  /** True while the save must wait for the user's confirmation. */
  needsConfirmation: boolean;
}

export function evidencePlan(
  original: EditIdentity,
  form: EditIdentity,
  fileIds: readonly string[],
  /** The files the user chose to remove (`choose` mode). */
  removed: ReadonlySet<string>,
  /** Whether the user ticked "remove these files" (`removeAll` mode). */
  confirmed: boolean,
): EvidencePlan {
  if (fileIds.length === 0) return { mode: "none", detachIds: [], needsConfirmation: false };
  if (original.category !== form.category) {
    return { mode: "removeAll", detachIds: [...fileIds], needsConfirmation: !confirmed };
  }
  const identityMoves =
    typeOf(original.activityType) !== typeOf(form.activityType) ||
    original.reportingYear !== form.reportingYear ||
    original.reportingPeriod !== form.reportingPeriod ||
    original.periodValue !== form.periodValue ||
    original.locationId !== form.locationId;
  if (!identityMoves) return { mode: "none", detachIds: [], needsConfirmation: false };
  return { mode: "choose", detachIds: fileIds.filter((id) => removed.has(id)), needsConfirmation: false };
}

/** The user the row actions are decided for. */
export interface ActingUser {
  id: string;
  role: string;
}

/** The part of a listed record the row actions read. */
export interface ActionableRecord {
  status: string;
  createdBy: string | null;
  periodLocked?: boolean;
}

export interface RecordActions {
  /** Open the record in Edit mode — its author, editable status, open period. */
  edit: boolean;
  /** Take a submitted record back to draft — its author, before review. */
  recall: boolean;
  /** Pre-fill a new draft from a voided record — its author or a super_admin. */
  copy: boolean;
}

/**
 * Which of Edit, Recall and Copy a row offers, from the contract's own rules
 * (`mayEditRecord`, `mayRecallRecord`, `mayCopyVoidedRecord`) — the API's
 * gates, so a button is never offered that the API would refuse for who or
 * what. A locked period refuses every write, so neither Edit nor Recall is
 * offered in one; a copy is a new record and may target another period.
 */
export function recordActions(user: ActingUser | null, record: ActionableRecord): RecordActions {
  const open = !record.periodLocked;
  return {
    edit: open && mayEditRecord(user, record),
    recall: open && mayRecallRecord(user, record),
    copy: mayCopyVoidedRecord(user, record),
  };
}

/**
 * The form's sessions (BUG-R2-03 owner review P2). Every action that gives the
 * form a new subject — opening a record, starting over, Cancel, Copy — begins
 * one; a request started under an earlier session lands on a form that has
 * moved on, and its answer is dropped instead of overwriting what the user is
 * now typing. A late Cancel of record A must never refill the form over
 * record B.
 */
export interface FormSessions {
  /** Begin a new session and return its token. */
  begin(): number;
  /** True while no later session has begun. */
  isCurrent(token: number): boolean;
  /**
   * The session now running, without beginning one: for a save, which must not
   * drop what the form holds, yet must know whether the form moved on while it
   * was in flight (held evidence, BUG-R2-05).
   */
  current(): number;
}

export function createFormSessions(): FormSessions {
  let current = 0;
  return {
    begin: () => (current += 1),
    isCurrent: (token) => token === current,
    current: () => current,
  };
}

/** The form a "Copy to new draft" opens: the voided record's values, no id, no file. */
export interface CopyPrefill {
  subsidiaryId: string;
  locationId: string;
  reportingYear: number;
  reportingPeriod: ReportingPeriod;
  periodValue: string;
  category: string;
  activityType: string;
  activityValue: number;
  activityUnit: string;
  input: Record<string, unknown> | null;
  parameters: unknown;
  varianceReason: string;
}

export function copyPrefill(
  record: Pick<
    ActivityRecordDTO,
    | "subsidiaryId"
    | "locationId"
    | "reportingYear"
    | "reportingPeriod"
    | "periodValue"
    | "category"
    | "activityType"
    | "activityValue"
    | "activityUnit"
    | "input"
    | "parameters"
  >,
): CopyPrefill {
  return {
    subsidiaryId: record.subsidiaryId,
    locationId: record.locationId ?? "",
    reportingYear: record.reportingYear,
    reportingPeriod: record.reportingPeriod,
    periodValue: record.periodValue,
    category: record.category,
    activityType: record.activityType ?? "",
    activityValue: record.activityValue,
    activityUnit: record.activityUnit,
    input: (record.input as Record<string, unknown> | null) ?? null,
    parameters: record.parameters ?? null,
    // The voided figure's justification belongs to that figure; the new record
    // earns its own if it is flagged.
    varianceReason: "",
  };
}
