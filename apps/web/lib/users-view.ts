import { ApiError } from "@/lib/api";
import {
  ACCESS_ASSIGNABLE_ROLES,
  CATEGORIES,
  INVITABLE_ROLES,
  ROLE_CHANGE_TARGETS,
  can,
  holdsRecords,
  type AuthUser,
  type Category,
  type ControlKind,
  type NodeType,
  type InviteUserRequest,
  type Locale,
  type UserAccessGrantDTO,
  type UserRole,
  type UserSummaryDTO,
} from "@/lib/types";

/**
 * The users screen's decisions (LP4-01; the four roles of
 * inc26-roles-approval-chain, design Decision 9), out of the component so
 * they are tested (`users-view.spec.ts`). Keys are in the `users` namespace.
 * The API enforces every rule here; the screen only offers what it would
 * accept, so a refusal is the exception rather than the way to learn a rule.
 */

/** Who reads the screen: the signed-in account, as `GET /me` answers it. */
export type Reader = Pick<AuthUser, "id" | "role" | "accessibleSubsidiaryIds">;

// --- Invitations ----------------------------------------------------------

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

// --- Roles the reader may hand out -----------------------------------------

/** One empty list, so a component depending on the answer does not see a new one each render. */
const NO_ROLES: readonly UserRole[] = Object.freeze([]);

/**
 * The roles the invite dialog offers its sender: a masterkey Super Admin and
 * Auditor, a super_admin Standard User alone, anyone else none. Never
 * Masterkey (ruling R1).
 */
export function invitableRoles(reader: Pick<Reader, "role"> | null | undefined): readonly UserRole[] {
  if (!reader || !can(reader.role, "users.invite")) return NO_ROLES;
  const roles = INVITABLE_ROLES[reader.role] ?? NO_ROLES;
  // The contract never lists it; kept out here too, so a wrong table cannot offer it.
  return roles.includes("masterkey") ? roles.filter((r) => r !== "masterkey") : roles;
}

/** The roles a role change offers: a masterkey's targets, never Masterkey; nobody else changes roles. */
export function roleChangeOptions(reader: Pick<Reader, "role"> | null | undefined): readonly UserRole[] {
  if (!reader || !can(reader.role, "users.set_role")) return NO_ROLES;
  return ROLE_CHANGE_TARGETS;
}

/** The role the role-change select starts on: the account's own when it is offered, else none chosen. */
export function initialRoleChoice(target: Pick<UserSummaryDTO, "role">, options: readonly UserRole[]): UserRole | null {
  return options.includes(target.role) ? target.role : null;
}

// --- Row actions -------------------------------------------------------------

export interface RowActions {
  /** "Edit access" in the access cell (and in the menu). */
  editAccess: boolean;
  changeRole: boolean;
  /** Disable or enable, whichever the account's state calls for. */
  toggleEnabled: boolean;
  resend: boolean;
  /** Whether the row's action menu has anything in it. */
  menu: boolean;
}

/** Whose access the reader sets: a masterkey a super_admin's, a super_admin a standard user's. */
export function mayEditAccess(reader: Reader | null | undefined, member: Pick<UserSummaryDTO, "id" | "role">): boolean {
  if (!reader || member.id === reader.id || !can(reader.role, "users.set_access")) return false;
  return (ACCESS_ASSIGNABLE_ROLES[reader.role] ?? []).includes(member.role);
}

/**
 * What a row offers its reader (design Decision 9): nothing on their own row;
 * role changes and disabling a masterkey's alone; a re-send to whoever may
 * invite the account's role (`reopenInvitation`'s rule).
 */
export function rowActions(reader: Reader | null | undefined, member: UserSummaryDTO): RowActions {
  const none: RowActions = { editAccess: false, changeRole: false, toggleEnabled: false, resend: false, menu: false };
  if (!reader || member.id === reader.id) return none;
  const editAccess = mayEditAccess(reader, member);
  const changeRole = can(reader.role, "users.set_role");
  const toggleEnabled = can(reader.role, "users.disable");
  const resend = canResend(member) && invitableRoles(reader).includes(member.role);
  return { editAccess, changeRole, toggleEnabled, resend, menu: editAccess || changeRole || toggleEnabled || resend };
}

// --- The access column -------------------------------------------------------

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
 * A masterkey and an auditor read the whole parent company; a super_admin and
 * a standard user work in their grants, named — never only counted — sorted
 * for the UI's locale, or marked as having none. A grant whose subsidiary is
 * missing from `names` (a list loaded before it was added) is counted in the
 * overflow, never shown as an id.
 */
export function accessSummary(
  user: UserSummaryDTO,
  names: ReadonlyMap<string, string>,
  localeTag: string,
): AccessSummary {
  if (!can(user.role, "scope.granted")) return { key: "wholeOrganisation" };
  if (user.access.length === 0) return { key: "noAccess" };
  const collator = new Intl.Collator(localeTag, { sensitivity: "base" });
  const all = user.access
    .map((grant) => names.get(grant.subsidiaryId))
    .filter((name): name is string => name !== undefined)
    .sort(collator.compare);
  const shown = all.slice(0, ACCESS_NAMES_SHOWN);
  return { key: "named", names: shown, overflow: user.access.length - shown.length, all };
}

// --- The picker ----------------------------------------------------------------

/** What the dialog shows for a role: several companies, one company with its categories, or the whole-parent-company note. */
export type PickerKind = "companies" | "singleCompany" | "wholeOrganisation";

export function pickerKind(role: UserRole): PickerKind {
  if (can(role, "scope.categories")) return "singleCompany";
  if (can(role, "scope.granted")) return "companies";
  return "wholeOrganisation";
}

/**
 * The companies the reader may assign, in the list's order: a masterkey the
 * organisation's, a super_admin its own grants, anyone else none. The
 * subsidiaries list is already scoped by the API; this keeps the picker to
 * the reader's grants even if it is not.
 */
export function assignableCompanies<S extends { id: string; nodeType: NodeType; control: ControlKind }>(
  reader: Reader | null | undefined,
  subsidiaries: readonly S[],
): S[] {
  if (!reader || !can(reader.role, "users.set_access")) return [];
  // No account is assigned to an associate or a sector group (inc26-group-tree):
  // the API refuses one with `subsidiary_not_assignable`.
  const open = subsidiaries.filter((s) => holdsRecords(s));
  if (can(reader.role, "scope.organisation")) return open;
  const own = new Set(reader.accessibleSubsidiaryIds);
  return open.filter((s) => own.has(s.id));
}

/** A selection being edited: the grants the request will send. */
export type AccessDraft = UserAccessGrantDTO[];

/** The dialog's starting selection: the account's grants as the reader sees them, a super_admin's with no category list. */
export function initialDraft(member: Pick<UserSummaryDTO, "role" | "access">): AccessDraft {
  const categories = can(member.role, "scope.categories");
  return member.access.map((g) => ({ subsidiaryId: g.subsidiaryId, categories: categories ? canonicalCategories(g.categories) : [] }));
}

/**
 * An account carried over from the earlier role model with several companies
 * (ruling R6): its companies are shown as held — each can be withdrawn or
 * have its categories changed — and no further company can be added.
 */
export function isCarriedOver(role: UserRole, initial: readonly UserAccessGrantDTO[]): boolean {
  return pickerKind(role) === "singleCompany" && initial.length > 1;
}

function canonicalCategories(list: readonly Category[]): Category[] {
  const ticked = new Set(list);
  return CATEGORIES.filter((c) => ticked.has(c));
}

// Several companies (a super_admin) ------------------------------------------

/** Ticks or unticks one company of a super_admin's selection, keeping the rest in order. */
export function toggleCompany(draft: AccessDraft, id: string, checked: boolean): AccessDraft {
  const rest = draft.filter((g) => g.subsidiaryId !== id);
  return checked ? [...rest, { subsidiaryId: id, categories: [] }] : rest;
}

/**
 * Every listed company, ticked. A ticked id the list does not hold (a grant
 * on a subsidiary added after the list loaded) is kept, so "select all" never
 * withdraws a grant the screen cannot show.
 */
export function selectAllCompanies(draft: AccessDraft, listed: readonly { id: string }[]): AccessDraft {
  const known = new Set(listed.map((s) => s.id));
  return [...draft.filter((g) => !known.has(g.subsidiaryId)), ...listed.map((s) => ({ subsidiaryId: s.id, categories: [] }))];
}

export interface SelectionState {
  /** Listed entries that are ticked; an id the list does not hold is not counted. */
  count: number;
  total: number;
  allSelected: boolean;
  noneSelected: boolean;
}

function selection(ticked: ReadonlySet<string>, listed: readonly string[]): SelectionState {
  const count = listed.filter((id) => ticked.has(id)).length;
  return { count, total: listed.length, allSelected: listed.length > 0 && count === listed.length, noneSelected: count === 0 };
}

/** What the company picker says: "n of m selected", and whether select-all or clear would change anything. */
export function companySelection(draft: AccessDraft, listed: readonly { id: string }[]): SelectionState {
  return selection(new Set(draft.map((g) => g.subsidiaryId)), listed.map((s) => s.id));
}

// One company with categories (a standard user) ------------------------------

/**
 * Chooses the one company of a standard user: the others are unselected. The
 * company already chosen keeps its categories; a newly chosen one starts with
 * nothing ticked.
 */
export function chooseCompany(draft: AccessDraft, id: string): AccessDraft {
  const held = draft.find((g) => g.subsidiaryId === id);
  return [held ?? { subsidiaryId: id, categories: [] }];
}

/** Withdraws one company (a held one of a carried-over account, or the chosen one). */
export function withdrawCompany(draft: AccessDraft, id: string): AccessDraft {
  return draft.filter((g) => g.subsidiaryId !== id);
}

/** Puts a withdrawn held company back with the categories it held, in its original place. */
export function restoreCompany(draft: AccessDraft, initial: readonly UserAccessGrantDTO[], id: string): AccessDraft {
  if (draft.some((g) => g.subsidiaryId === id)) return draft;
  const kept = new Set([...draft.map((g) => g.subsidiaryId), id]);
  const current = new Map(draft.map((g) => [g.subsidiaryId, g]));
  return initial
    .filter((g) => kept.has(g.subsidiaryId))
    .map((g) => current.get(g.subsidiaryId) ?? { subsidiaryId: g.subsidiaryId, categories: canonicalCategories(g.categories) });
}

function mapGrant(draft: AccessDraft, id: string, change: (categories: Category[]) => Category[]): AccessDraft {
  return draft.map((g) => (g.subsidiaryId === id ? { ...g, categories: canonicalCategories(change(g.categories)) } : g));
}

/** Ticks or unticks one category of a company's grant; the list stays in the product's order. */
export function toggleCategory(draft: AccessDraft, id: string, category: Category, checked: boolean): AccessDraft {
  return mapGrant(draft, id, (list) => (checked ? [...list, category] : list.filter((c) => c !== category)));
}

export function selectAllCategories(draft: AccessDraft, id: string): AccessDraft {
  return mapGrant(draft, id, () => [...CATEGORIES]);
}

export function clearCategories(draft: AccessDraft, id: string): AccessDraft {
  return mapGrant(draft, id, () => []);
}

/** A company's category checklist: "n of m selected", select all, clear. */
export function categorySelection(grant: Pick<UserAccessGrantDTO, "categories">): SelectionState {
  return selection(new Set<string>(grant.categories), [...CATEGORIES]);
}

// Warnings: never a refusal --------------------------------------------------

export interface AccessWarnings {
  /** No company is selected: the user cannot work until one is. */
  noCompany: boolean;
  /** The reader has no company to assign at all ("0 of 0"). */
  noneAssignable: boolean;
  /** Ticked companies of a standard user with no category, in the draft's order. */
  companiesWithoutCategory: string[];
}

/** What the picker warns about. Saving and inviting stay allowed whatever it says. */
export function accessWarnings(role: UserRole, draft: AccessDraft, assignable: readonly { id: string }[]): AccessWarnings {
  const kind = pickerKind(role);
  if (kind === "wholeOrganisation") return { noCompany: false, noneAssignable: false, companiesWithoutCategory: [] };
  return {
    noCompany: draft.length === 0,
    noneAssignable: assignable.length === 0,
    companiesWithoutCategory: kind === "singleCompany" ? draft.filter((g) => g.categories.length === 0).map((g) => g.subsidiaryId) : [],
  };
}

// Requests --------------------------------------------------------------------

/** The `access` a request sends for a role: a super_admin's with no category list, a standard user's in the product's order. */
export function accessPayload(role: UserRole, draft: AccessDraft): UserAccessGrantDTO[] {
  const kind = pickerKind(role);
  if (kind === "wholeOrganisation") return [];
  const seen = new Set<string>();
  const out: UserAccessGrantDTO[] = [];
  for (const g of draft) {
    if (seen.has(g.subsidiaryId)) continue;
    seen.add(g.subsidiaryId);
    out.push({ subsidiaryId: g.subsidiaryId, categories: kind === "singleCompany" ? canonicalCategories(g.categories) : [] });
  }
  return out;
}

/** The invite dialog's selection, one per role that has a picker, so switching roles and back keeps what was chosen. */
export type InviteDrafts = Partial<Record<UserRole, AccessDraft>>;

export interface InviteForm {
  email: string;
  fullName: string;
  role: UserRole;
  language: Locale;
  drafts: InviteDrafts;
}

/** `POST /users/invitations`: `access` only for a role that holds grants (an auditor's carries none). */
export function invitePayload(form: InviteForm): InviteUserRequest {
  const base = { email: form.email.trim(), fullName: form.fullName.trim(), role: form.role, language: form.language };
  if (pickerKind(form.role) === "wholeOrganisation") return base;
  return { ...base, access: accessPayload(form.role, form.drafts[form.role] ?? []) };
}

// After a role change ------------------------------------------------------------

/**
 * What follows a masterkey's role change (spec "A role change to a granted
 * role leads to the access choice"): to Super Admin, the access editor opens;
 * to Standard User, a note that a super_admin assigns their companies and
 * categories; anything else, nothing more.
 */
export type RoleChangeFollowUp = "openAccessEditor" | "superAdminAssigns" | "none";

export function roleChangeFollowUp(reader: Reader | null | undefined, before: UserRole, after: UserSummaryDTO): RoleChangeFollowUp {
  if (before === after.role) return "none";
  if (mayEditAccess(reader, after)) return "openAccessEditor";
  if (after.role === "standard_user") return "superAdminAssigns";
  return "none";
}

// Refusals ------------------------------------------------------------------------

/**
 * A refusal the users screen words itself (`users.errors.*`), else null and
 * the shared error toast words it.
 */
export type UsersErrorKey = "errors.standardUserSingleCompany";

export function usersErrorKey(error: unknown): UsersErrorKey | null {
  if (error instanceof ApiError && error.code === "standard_user_single_company") return "errors.standardUserSingleCompany";
  return null;
}

// List updates ---------------------------------------------------------------------

/** Replaces one member in a loaded list with the API's fresh copy (every action answers one). */
export function replaceUser(list: UserSummaryDTO[], updated: UserSummaryDTO): UserSummaryDTO[] {
  return list.map((u) => (u.id === updated.id ? updated : u));
}

/** Appends a page, dropping any member already shown (a page boundary that moved). */
export function appendPage(list: UserSummaryDTO[], page: UserSummaryDTO[]): UserSummaryDTO[] {
  const seen = new Set(list.map((u) => u.id));
  return [...list, ...page.filter((u) => !seen.has(u.id))];
}

/**
 * After an access save, whether the screen re-reads the list rather than
 * putting the answer in the row (owner's review): a super_admin who withdraws
 * the last grant it can see may have taken the account out of its list — it
 * may still hold a grant elsewhere, which this reader is never shown — so the
 * API decides whether the account stays listed. A masterkey sees every account
 * and every grant, so its answer is always the row.
 */
export function reloadAfterAccessSave(
  reader: Reader | null | undefined,
  before: Pick<UserSummaryDTO, "access">,
  after: Pick<UserSummaryDTO, "access">,
): boolean {
  if (!reader || can(reader.role, "scope.organisation")) return false;
  return before.access.length > 0 && after.access.length === 0;
}

