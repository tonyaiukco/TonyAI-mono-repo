import type { UserRole } from '@tonyai/shared-types';

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
  accessibleSubsidiaryIds: string[];
}
