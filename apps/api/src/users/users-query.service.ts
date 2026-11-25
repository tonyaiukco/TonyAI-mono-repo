import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@tonyai/db';
import {
  ACCESS_ASSIGNABLE_ROLES,
  DEFAULT_LOCALE,
  can,
  isCategory,
  isLocale,
  type Category,
  type CursorPage,
  type InvitationStateDTO,
  type UserRole,
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
  subsidiaryAccess: { select: { subsidiaryId: true, categories: true }, orderBy: { subsidiaryId: 'asc' } },
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

/**
 * `scope` is the reader's companies when the reader is a super_admin (its
 * view of an account holds only the grants inside them), null for a
 * masterkey, who sees every grant.
 */
export function toUserSummary(row: SummaryRow, scope: ReadonlySet<string> | null = null): UserSummaryDTO {
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
    access: row.subsidiaryAccess
      .filter((g) => scope === null || scope.has(g.subsidiaryId))
      .map((g) => ({
        subsidiaryId: g.subsidiaryId,
        // Categories are a standard user's; a super_admin's grant covers all.
        categories: can(row.role, 'scope.categories') ? [...new Set(g.categories.filter(isCategory))].sort() : ([] as Category[]),
      })),
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

/**
 * Who reads which accounts (INC-2.6 §6, design Decision 9): a masterkey every
 * account of the organisation; a super_admin the standard users it
 * administers — those with a grant in one of its companies, and those with no
 * grant at all, whom nobody else could pick up (the masterkey does not assign
 * standard users) — each shown with the grants inside its companies only.
 */
interface UsersView {
  organisationId: string;
  /** Null: every account and every grant. */
  scope: ReadonlySet<string> | null;
  /** The roles a scoped reader administers (a super_admin: standard users). */
  administers: readonly UserRole[];
}

function usersView(actor: RequestUser): UsersView {
  if (!actor.organisationId || !can(actor.role, 'users.list')) {
    throw new ForbiddenException('Only a masterkey or a super_admin manages users.');
  }
  return {
    organisationId: actor.organisationId,
    scope: can(actor.role, 'scope.organisation') ? null : new Set(actor.accessibleSubsidiaryIds),
    administers: ACCESS_ASSIGNABLE_ROLES[actor.role] ?? [],
  };
}

/** The accounts a view lists. */
function listedWhere(view: UsersView): Prisma.ProfileWhereInput {
  if (view.scope === null) return { organisationId: view.organisationId };
  return {
    organisationId: view.organisationId,
    role: { in: [...view.administers] },
    OR: [
      { subsidiaryAccess: { none: {} } },
      { subsidiaryAccess: { some: { subsidiaryId: { in: [...view.scope] } } } },
    ],
  };
}

@Injectable()
export class UsersQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's organisation's members, newest first. */
  async list(actor: RequestUser, params: { limit?: number; cursor?: string }): Promise<CursorPage<UserSummaryDTO>> {
    const view = usersView(actor);
    const limit = pageLimit(params.limit);
    // The list has no filters, so the binding is the endpoint and sort alone.
    const binding = cursorBinding(USERS_SORT, {});
    const after = params.cursor !== undefined ? decodeCursor(USERS_SORT, binding, params.cursor) : null;
    const where = listedWhere(view);
    const rows = await this.prisma.profile.findMany({
      where: after ? { AND: [where, keysetWhere(USERS_SORT, after) as Prisma.ProfileWhereInput] } : where,
      orderBy: keysetOrderBy(USERS_SORT) as Prisma.ProfileOrderByWithRelationInput[],
      take: limit + 1,
      select: SUMMARY_SELECT,
    });
    return toCursorPage(rows, limit, USERS_SORT, binding, (r) => [r.createdAt, r.id], (r) => toUserSummary(r, view.scope));
  }

  /**
   * One member of the caller's organisation, as the caller's view shows it;
   * another tenant's id is 404. A super_admin reads any standard user of the
   * organisation here — the account it has just acted on may since hold no
   * grant inside its companies — but only the grants inside them.
   */
  async summary(actor: RequestUser, profileId: string): Promise<UserSummaryDTO> {
    const view = usersView(actor);
    const where: Prisma.ProfileWhereInput = view.scope === null
      ? { id: profileId, organisationId: view.organisationId }
      : { id: profileId, organisationId: view.organisationId, role: { in: [...view.administers] } };
    const row = await this.prisma.profile.findFirst({ where, select: SUMMARY_SELECT });
    if (!row) throw new ResourceNotFoundError('user_not_found');
    return toUserSummary(row, view.scope);
  }
}
