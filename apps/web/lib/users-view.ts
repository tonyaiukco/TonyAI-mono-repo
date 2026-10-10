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

/** Subsidiary grants are a data_entry user's alone; every other role reads the organisation. */
export function accessSummary(user: UserSummaryDTO):
  | { key: "wholeOrganisation" | "noAccess"; values?: undefined }
  | { key: "accessCount"; values: { count: number } } {
  if (user.role !== "data_entry") return { key: "wholeOrganisation" };
  if (user.subsidiaryIds.length === 0) return { key: "noAccess" };
  return { key: "accessCount", values: { count: user.subsidiaryIds.length } };
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
