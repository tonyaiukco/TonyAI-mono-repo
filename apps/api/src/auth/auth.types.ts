import type { Category, UserRole } from '@tonyai/shared-types';

/**
 * The authenticated caller, built once per request by the auth guard.
 *
 * Carries PII since `fullName` was added, which makes a habit load-bearing that
 * used to be style: the logger, the exception filter, the Sentry scope and the
 * audit writer each PICK the fields they need and none of them spreads this
 * object. Keep it that way — a spread is how a display name reaches a log line
 * or an append-only row that has no correction path.
 */
export interface RequestUser {
  id: string;
  email: string;
  /** The caller's display name, already loaded by the guard. Carried so a write
   *  path can name its own actor without a second query — `created_by` on a
   *  create is always the caller. `profiles.full_name` is NOT NULL. */
  fullName: string;
  role: UserRole;
  organisationId: string | null;
  /** The companies the caller works in: every subsidiary of the organisation
   *  for a masterkey and an auditor, the same-organisation grants for a
   *  super_admin and a standard user (INC-2.6 §1). Every read is scoped by it. */
  accessibleSubsidiaryIds: string[];
  /**
   * A standard user's ticked categories per granted company (`subsidiaryId →
   * categories`), set by the guard for every caller (empty for the other
   * roles, which categories never narrow). Optional only so hand-built test
   * users compile: a standard user WITHOUT it is narrowed to nothing but its
   * own records — the read scope fails closed (`recordScopeWhere`).
   */
  categoryGrants?: Readonly<Record<string, readonly Category[]>>;
}
