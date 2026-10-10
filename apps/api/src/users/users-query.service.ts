import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@tonyai/db';
import {
  DEFAULT_LOCALE,
  DEFAULT_PAGE_LIMIT,
  isLocale,
  MAX_CURSOR_LENGTH,
  type CursorPage,
  type InvitationStateDTO,
  type UserSummaryDTO,
} from '@tonyai/shared-types';
import { errorBody, ResourceNotFoundError } from '../common/api-error';
import { UUID_SHAPE } from '../common/parse-uuid-param.pipe';
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

/** The key a page continues after: the last row's sort key, newest first. */
interface UsersCursor {
  createdAt: Date;
  id: string;
}

const CURSOR_VERSION = 1;
const CURSOR_KIND = 'users';

/**
 * Opaque, versioned and bound to this endpoint and its one sort (LP4-05's
 * `CursorPage` contract): it carries the sort-key tuple — a timestamp and an
 * id — and neither a tenant nor an address, so no personal data reaches a URL.
 */
export function encodeUsersCursor(cursor: UsersCursor): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, k: CURSOR_KIND, t: cursor.createdAt.toISOString(), i: cursor.id }),
  ).toString('base64url');
}

export function decodeUsersCursor(raw: string): UsersCursor {
  const refuse = () => new BadRequestException(errorBody('validation_failed', ['cursor is invalid']));
  if (!raw || raw.length > MAX_CURSOR_LENGTH) throw refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw refuse();
  }
  const c = parsed as { v?: unknown; k?: unknown; t?: unknown; i?: unknown } | null;
  if (!c || typeof c !== 'object' || c.v !== CURSOR_VERSION || c.k !== CURSOR_KIND) throw refuse();
  if (typeof c.i !== 'string' || !UUID_SHAPE.test(c.i) || typeof c.t !== 'string') throw refuse();
  const createdAt = new Date(c.t);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== c.t) throw refuse();
  return { createdAt, id: c.i.toLowerCase() };
}

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
    const limit = params.limit ?? DEFAULT_PAGE_LIMIT;
    const after = params.cursor !== undefined ? decodeUsersCursor(params.cursor) : null;
    const rows = await this.prisma.profile.findMany({
      where: {
        organisationId,
        ...(after
          ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: SUMMARY_SELECT,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toUserSummary),
      limit,
      nextCursor: rows.length > limit && last ? encodeUsersCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  }

  /** One member of the caller's organisation; another tenant's id is 404. */
  async summary(actor: RequestUser, profileId: string): Promise<UserSummaryDTO> {
    const organisationId = adminOrganisation(actor);
    const row = await this.prisma.profile.findFirst({ where: { id: profileId, organisationId }, select: SUMMARY_SELECT });
    if (!row) throw new ResourceNotFoundError('user_not_found');
    return toUserSummary(row);
  }
}
