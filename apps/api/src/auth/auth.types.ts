import type { UserRole } from '@tonyai/shared-types';

export interface RequestUser {
  id: string;
  email: string;
  role: UserRole;
  organisationId: string | null;
  accessibleSubsidiaryIds: string[];
}
