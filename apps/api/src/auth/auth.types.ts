import type { UserRole } from '@tonyai/shared-types';

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
