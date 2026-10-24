import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@tonyai/db';
import {
  DEFAULT_LOCALE,
  isLocale,
  type CursorPage,
  type InvitationStateDTO,
  type UserSummaryDTO,
} from '@tonyai/shared-types';
import { ResourceNotFoundError } from '../common/api-error';
import {
  cursorBinding,
  decodeCursor,
  keysetOrderBy,
  keysetWhere,
  pageLimit,
  toCursorPage,
  type KeysetSort,
} from '../common/keyset-cursor';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

const SUMMARY_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  language: true,
  disabledAt: true,
  authSyncPendingSince: true,
  createdAt: true,
  subsidiaryAccess: { select: { subsidiaryId: true }, orderBy: { subsidiaryId: 'asc' } },
  invitation: {
    select: {
      status: true,
      language: true,
      attempts: true,
      lastErrorStep: true,
      lastErrorCode: true,
      lastAttemptAt: true,
      sentAt: true,
      acceptedAt: true,
    },
  },
} satisfies Prisma.ProfileSelect;

type SummaryRow = Prisma.ProfileGetPayload<{ select: typeof SUMMARY_SELECT }>;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toUserSummary(row: SummaryRow): UserSummaryDTO {
  const invitation: InvitationStateDTO | null = row.invitation
    ? {
        status: row.invitation.status,
        language: isLocale(row.invitation.language) ? row.invitation.language : DEFAULT_LOCALE,
        attempts: row.invitation.attempts,
        lastErrorStep: row.invitation.lastErrorStep === 'auth' || row.invitation.lastErrorStep === 'email'
          ? row.invitation.lastErrorStep
          : null,
        lastErrorCode: row.invitation.lastErrorCode,
        lastAttemptAt: iso(row.invitation.lastAttemptAt),
        sentAt: iso(row.invitation.sentAt),
        acceptedAt: iso(row.invitation.acceptedAt),
      }
    : null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    role: row.role,
    language: isLocale(row.language) ? row.language : DEFAULT_LOCALE,
    status: row.disabledAt ? 'disabled' : invitation && invitation.status !== 'accepted' ? 'invited' : 'active',
    subsidiaryIds: row.subsidiaryAccess.map((g) => g.subsidiaryId),
    disabledAt: iso(row.disabledAt),
    authSyncPending: row.authSyncPendingSince !== null,
    invitation,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Newest first; `(created_at, id)` are both millisecond-exact (`TIMESTAMP(3)`, uuid). */
export const USERS_SORT: KeysetSort = {
  endpoint: 'users',
  table: 'profiles',
  name: 'newest',
  keys: [
    { field: 'createdAt', kind: 'timestamp3', direction: 'desc' },
    { field: 'id', kind: 'uuid', direction: 'desc' },
  ],
};

/** Reading users is the tenant administrator's, like changing them. */
function adminOrganisation(actor: RequestUser): string {
  if (actor.role !== 'super_admin' || !actor.organisationId) {
    throw new ForbiddenException('Only a super_admin manages users.');
  }
  return actor.organisationId;
}

@Injectable()
export class UsersQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's organisation's members, newest first. */
  async list(actor: RequestUser, params: { limit?: number; cursor?: string }): Promise<CursorPage<UserSummaryDTO>> {
    const organisationId = adminOrganisation(actor);
    const limit = pageLimit(params.limit);
    // The list has no filters, so the binding is the endpoint and sort alone.
    const binding = cursorBinding(USERS_SORT, {});
    const after = params.cursor !== undefined ? decodeCursor(USERS_SORT, binding, params.cursor) : null;
    const where: Prisma.ProfileWhereInput = { organisationId };
    const rows = await this.prisma.profile.findMany({
      where: after ? { AND: [where, keysetWhere(USERS_SORT, after) as Prisma.ProfileWhereInput] } : where,
      orderBy: keysetOrderBy(USERS_SORT) as Prisma.ProfileOrderByWithRelationInput[],
      take: limit + 1,
      select: SUMMARY_SELECT,
    });
    return toCursorPage(rows, limit, USERS_SORT, binding, (r) => [r.createdAt, r.id], toUserSummary);
  }

  /** One member of the caller's organisation; another tenant's id is 404. */
  async summary(actor: RequestUser, profileId: string): Promise<UserSummaryDTO> {
    const organisationId = adminOrganisation(actor);
    const row = await this.prisma.profile.findFirst({ where: { id: profileId, organisationId }, select: SUMMARY_SELECT });
    if (!row) throw new ResourceNotFoundError('user_not_found');
    return toUserSummary(row);
  }
}
