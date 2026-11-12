import type { UserSummaryDTO } from "@/lib/types";

/**
 * The users screen's decisions (LP4-01), out of the component so they are
 * tested (`users-view.spec.ts`). Keys are in the `users` namespace.
 */

export type InvitationNote =
  | { key: "deliveryFailed" | "invitationPending"; values?: undefined }
  | { key: "invitationSent"; values: { date: string } };

/** The line under an invited member's status: delivered, on its way, or failed. */
export function invitationNote(user: UserSummaryDTO): InvitationNote | null {
  const invitation = user.invitation;
  if (!invitation || user.status === "disabled") return null;
  if (invitation.status === "pending") {
    return invitation.lastErrorStep ? { key: "deliveryFailed" } : { key: "invitationPending" };
  }
  if (invitation.status === "sent" && invitation.sentAt) return { key: "invitationSent", values: { date: invitation.sentAt } };
  return null;
}

/** An invitation not yet accepted, on an enabled account, can be re-sent. */
export function canResend(user: UserSummaryDTO): boolean {
  return user.status !== "disabled" && user.invitation !== null && user.invitation.status !== "accepted";
}

/** How many granted subsidiaries the users list names before it says "+N more". */
export const ACCESS_NAMES_SHOWN = 3;

export type AccessSummary =
  | { key: "wholeOrganisation" | "noAccess" }
  | {
      key: "named";
      /** At most {@link ACCESS_NAMES_SHOWN} names, in name order. */
      names: string[];
      /** Grants not named in `names`, including any whose subsidiary is not in the map. */
      overflow: number;
      /** Every resolvable name, in name order, for the row's tooltip. */
      all: string[];
    };

/**
 * Subsidiary grants are a data_entry user's alone; every other role reads the
 * whole parent company (OpenSpec `organisation-hierarchy`). A data_entry user's
 * grants are named — never only counted — sorted for the UI's locale. A grant
 * whose subsidiary is missing from `names` (a list loaded before it was added)
 * is counted in the overflow, never shown as an id.
 */
export function accessSummary(
  user: UserSummaryDTO,
  names: ReadonlyMap<string, string>,
  localeTag: string,
): AccessSummary {
  if (user.role !== "data_entry") return { key: "wholeOrganisation" };
  if (user.subsidiaryIds.length === 0) return { key: "noAccess" };
  const collator = new Intl.Collator(localeTag, { sensitivity: "base" });
  const all = user.subsidiaryIds
    .map((id) => names.get(id))
    .filter((name): name is string => name !== undefined)
    .sort(collator.compare);
  const shown = all.slice(0, ACCESS_NAMES_SHOWN);
  return { key: "named", names: shown, overflow: user.subsidiaryIds.length - shown.length, all };
}

/** Ticks or unticks one subsidiary in a picker's selection, keeping the rest in order. */
export function toggleSubsidiary(selected: readonly string[], id: string, checked: boolean): string[] {
  const rest = selected.filter((s) => s !== id);
  return checked ? [...rest, id] : rest;
}

/**
 * Every subsidiary the picker lists, ticked. A ticked id the list does not
 * hold (a grant on a subsidiary added after the list loaded) is kept, so
 * "select all" never revokes a grant the screen cannot show.
 */
export function selectAllSubsidiaries(selected: readonly string[], listed: readonly { id: string }[]): string[] {
  const listedIds = listed.map((s) => s.id);
  const known = new Set(listedIds);
  return [...selected.filter((id) => !known.has(id)), ...listedIds];
}

export interface SelectionState {
  /** Listed subsidiaries that are ticked; an id the list does not hold is not counted. */
  count: number;
  total: number;
  allSelected: boolean;
  noneSelected: boolean;
}

/** What the picker says about its selection: "n of m selected", and whether select-all or clear would change anything. */
export function selectionState(selected: readonly string[], listed: readonly { id: string }[]): SelectionState {
  const ticked = new Set(selected);
  const count = listed.filter((s) => ticked.has(s.id)).length;
  return { count, total: listed.length, allSelected: listed.length > 0 && count === listed.length, noneSelected: count === 0 };
}

/** Replaces one member in a loaded list with the API's fresh copy (every action answers one). */
export function replaceUser(list: UserSummaryDTO[], updated: UserSummaryDTO): UserSummaryDTO[] {
  return list.map((u) => (u.id === updated.id ? updated : u));
}

/** Appends a page, dropping any member already shown (a page boundary that moved). */
export function appendPage(list: UserSummaryDTO[], page: UserSummaryDTO[]): UserSummaryDTO[] {
  const seen = new Set(list.map((u) => u.id));
  return [...list, ...page.filter((u) => !seen.has(u.id))];
}
