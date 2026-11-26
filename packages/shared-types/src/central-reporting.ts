/**
 * Central reporting (inc26-central-reporter-onboarding, INC-2.6 Rev.3 §4): a
 * record's owning and reporting entity, the central reporter grant, and the
 * single-entry rule between a company's own standard users and a central
 * reporter. The API, the database triggers (TA024–TA026) and the web share
 * these rules, so the preview, the screens and the stored value agree.
 *
 * No runtime import from `./index`: `index.ts` re-exports this module.
 */
import type { Category, UserAccessGrantDTO } from './index';

/**
 * What an access row is (design D3): an `assigned` company — a super_admin's
 * company, or a standard user's main company — or a company of a standard
 * user's central reporter grant. Stored in `user_subsidiary_access.kind`.
 */
export const GRANT_KINDS = ['assigned', 'central_reporter'] as const;
export type GrantKind = (typeof GRANT_KINDS)[number];

export function isGrantKind(value: unknown): value is GrantKind {
  return typeof value === 'string' && (GRANT_KINDS as readonly string[]).includes(value);
}

/**
 * The READ shape of an access row: what the user row (`GET /users`) and
 * `AuthUser.access` (`GET /me`) answer. The write shape stays
 * `UserAccessGrantDTO` (no `kind`): every company an invitation or
 * `PUT /users/:id/access` names is an `assigned` one, so an earlier client's
 * body means what it always meant. A grant is written only through
 * `PUT /users/:id/central-reporter-grant`.
 */
export interface UserAccessRowDTO extends UserAccessGrantDTO {
  kind: GrantKind;
}

/** The access rows a rule reads: a write-shape row with no `kind` is assigned. */
type AccessRowLike = Pick<UserAccessGrantDTO, 'subsidiaryId' | 'categories'> & { kind?: GrantKind };

const kindOf = (row: AccessRowLike): GrantKind => row.kind ?? 'assigned';

/**
 * The account's main company: its one `assigned` company, or `null` when it
 * holds none or several (a carried-over account, ruling R6, or a super_admin
 * of several companies). A central reporter always has exactly one (B2).
 */
export function mainCompanyOf(access: readonly AccessRowLike[]): string | null {
  const assigned = access.filter((row) => kindOf(row) === 'assigned');
  return assigned.length === 1 ? assigned[0]!.subsidiaryId : null;
}

/** A central reporter grant as one value: its companies and its one category list. */
export interface CentralReporterGrant {
  subsidiaryIds: string[];
  categories: Category[];
}

/**
 * The account's central reporter grant, or `null` when it holds none. The
 * grant has one category list (§4.1, an API invariant: the grant write gives
 * every row the same list); should rows ever differ, the union is answered,
 * in the order the rows give them, so nothing held is hidden.
 */
export function centralReporterGrantOf(access: readonly AccessRowLike[]): CentralReporterGrant | null {
  const rows = access.filter((row) => kindOf(row) === 'central_reporter');
  if (rows.length === 0) return null;
  const categories: Category[] = [];
  for (const row of rows) {
    for (const category of row.categories) if (!categories.includes(category)) categories.push(category);
  }
  return { subsidiaryIds: rows.map((row) => row.subsidiaryId), categories };
}

/**
 * The reporting entity a record for `subsidiaryId` gets when this account
 * enters it (§4; design D2) — the same answer trigger TA025 stores:
 *
 * - a company of the account's central reporter grant → the main company;
 * - any other company (the main company, a super_admin's, a carried-over
 *   account's, a masterkey's with no grant at all) → the company itself.
 *
 * `null` only for a grant company when the account holds no single main
 * company: the database refuses that write (B2 keeps it from arising).
 */
export function reportingEntityFor(access: readonly AccessRowLike[], subsidiaryId: string): string | null {
  const row = access.find((candidate) => candidate.subsidiaryId === subsidiaryId);
  if (!row || kindOf(row) !== 'central_reporter') return subsidiaryId;
  return mainCompanyOf(access);
}

/**
 * Which party already holds the categories in a single-entry conflict, the
 * sentence selector of `single_entry_conflict` (design D4): the company's own
 * standard users, or a central reporter.
 */
export const SINGLE_ENTRY_SIDES = ['company_users', 'central_reporter'] as const;
export type SingleEntrySide = (typeof SINGLE_ENTRY_SIDES)[number];

/** One access row as the single-entry rule reads it: whose, where, which kind. */
export interface SingleEntryAccessRow {
  userId: string;
  subsidiaryId: string;
  kind: GrantKind;
  categories: readonly Category[];
  /** The holder's current role. Only a `standard_user`'s row is a party: a
   *  super_admin's carries `{}`, and a stray grant carried onto a masterkey or
   *  an auditor (WP6's migration) holds every category but is no party. */
  holderRole: string | null | undefined;
}

/** A conflict: at `subsidiaryId`, `side` already holds `categories`. */
export interface SingleEntryConflict {
  subsidiaryId: string;
  categories: Category[];
  side: SingleEntrySide;
}

const sideOf = (kind: GrantKind): SingleEntrySide => (kind === 'assigned' ? 'company_users' : 'central_reporter');

/**
 * The single-entry conflicts a write would open (§4.2; design D4): at one
 * company, a category is open to the company's own standard users (`assigned`
 * rows) or to a central reporter (`central_reporter` rows), never to both.
 *
 * `standing` is the company's rows as they stand; `proposed` is the complete
 * set of rows the write leaves for the account(s) it changes. A standing row
 * of an account the write changes is replaced by its proposed rows, so it is
 * ignored here. Rows of a holder that is not a standard user are no party. A
 * carried-over account's rows are `assigned`, so they count as the company's
 * own users; two central reporters at one company do not conflict.
 *
 * One conflict per company and side, its categories in the order met. Empty
 * when the write opens nothing to both parties.
 */
export function singleEntryConflicts(
  standing: readonly SingleEntryAccessRow[],
  proposed: readonly SingleEntryAccessRow[],
): SingleEntryConflict[] {
  const party = (row: SingleEntryAccessRow) => row.holderRole === 'standard_user';
  const changed = new Set(proposed.map((row) => row.userId));
  const others = standing.filter((row) => party(row) && !changed.has(row.userId));
  const conflicts: SingleEntryConflict[] = [];
  for (const row of proposed) {
    if (!party(row)) continue;
    for (const other of others) {
      if (other.subsidiaryId !== row.subsidiaryId || other.kind === row.kind) continue;
      const overlap = row.categories.filter((category) => other.categories.includes(category));
      if (overlap.length === 0) continue;
      const side = sideOf(other.kind);
      let conflict = conflicts.find((c) => c.subsidiaryId === row.subsidiaryId && c.side === side);
      if (!conflict) {
        conflict = { subsidiaryId: row.subsidiaryId, categories: [], side };
        conflicts.push(conflict);
      }
      for (const category of overlap) if (!conflict.categories.includes(category)) conflict.categories.push(category);
    }
  }
  return conflicts;
}

/** The two parties of the single-entry rule (§5.3). */
export const RECORD_PARTIES = ['central_reporter', 'company_user'] as const;
export type RecordParty = (typeof RECORD_PARTIES)[number];

/**
 * Which party a record belongs to (design D5, C3): a central reporter's when
 * its reporting entity is set and differs from its company; the company's own
 * user's when it is not and its author is a `standard_user` NOW (the reading
 * approval routing takes, WP6); `null` — neither party's — for a masterkey's,
 * a super_admin's, an auditor's or a missing author's record.
 *
 * Reads both the stored form (`reportedBySubsidiaryId` null = own company)
 * and the DTO form (always present, equal to `subsidiaryId` for own).
 */
export function recordParty(
  record: { subsidiaryId: string; reportedBySubsidiaryId: string | null | undefined },
  authorRole: string | null | undefined,
): RecordParty | null {
  const reported = record.reportedBySubsidiaryId;
  if (reported != null && reported !== record.subsidiaryId) return 'central_reporter';
  return authorRole === 'standard_user' ? 'company_user' : null;
}

/** PUT /api/v1/users/:id/central-reporter-grant — the whole grant, masterkey
 *  only (`central_reporter.grant`). No company withdraws the grant; companies
 *  with no category are refused as invalid input. */
export interface CentralReporterGrantInput {
  subsidiaryIds: string[];
  categories: Category[];
}

/** One company of a `single_entry_conflict` refusal: identifiers only, worded
 *  by the screen from its own lists; never an account. */
export interface SingleEntryConflictDTO {
  subsidiaryId: string;
  categories: Category[];
}
