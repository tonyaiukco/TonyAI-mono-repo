import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import type {
  AuditAction,
  AuditEntity,
  AuditLogDTO,
  Paginated,
  UserRole,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { resolveProfiles } from '../common/resolve-profiles';
import type { RequestUser } from '../auth/auth.types';
import { DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT } from './audit.constants';
import { ListAuditQueryDto } from './dto/list-audit-query.dto';

/**
 * The single place an audit row is written.
 *
 * Before WP7 each of the eight feature services carried its own private
 * `audit()` helper. They drifted: none recorded the actor's role, none recorded
 * a tenant, half wrote the row inside the mutation's transaction and half after
 * it (so a crash in between lost the audit row), and the workflow transitions
 * all logged `action: 'update'` with the real transition buried in the diff.
 *
 * `audit_log` is APPEND-ONLY (CLAUDE.md, and there is no UPDATE/DELETE RLS
 * policy) — this service therefore only ever creates.
 */

// The taxonomy lives in @tonyai/shared-types — one source of truth. Writers
// import it from there directly rather than through this module.

/** Reading the trail is super_admin-only, matching the RLS policy exactly.
 * The API is the primary control (Prisma connects as the runtime role, which
 * bypasses RLS — LP1-03), so this check is what actually enforces it. */
const READ_ROLES = new Set<UserRole>(['super_admin']);

/** Accepts a transaction client so the audit row commits with the mutation. */
type Writer = Pick<Prisma.TransactionClient, 'auditLog'>;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    user: RequestUser,
    entry: {
      action: AuditAction;
      entity: AuditEntity;
      entityId: string | null;
      diff?: unknown;
    },
    /** Pass the `tx` client from inside a `$transaction` — always prefer this. */
    tx?: Writer,
  ): Promise<void> {
    const writer: Writer = tx ?? this.prisma;
    await writer.auditLog.create({
      data: {
        userId: user.id,
        // Stamped at write time: roles change, and rendering today's role next
        // to a year-old action would misstate who was allowed to do what.
        role: user.role,
        // Tenant scope comes from the ACTOR, not the entity — `report` rows have
        // no entityId and `delete` rows point at a row that is already gone.
        organisationId: user.organisationId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        diff: (entry.diff ?? null) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Read the trail, newest first, scoped to the caller's organisation.
   *
   * Tenant scoping uses `audit_log.organisation_id`, denormalised from the
   * ACTOR at write time — a `report` row has no `entityId` and a `delete` row
   * points at a row that no longer exists, so joining to the entity is not
   * possible for every action. A caller with no organisation reads nothing:
   * a null tenant would otherwise widen the query to every row ever written.
   */
  async list(
    user: RequestUser,
    query: ListAuditQueryDto,
  ): Promise<Paginated<AuditLogDTO>> {
    if (!READ_ROLES.has(user.role)) {
      throw new ForbiddenException('Only a super_admin may read the audit trail');
    }
    if (!user.organisationId) {
      // Default-deny, mirroring the guard's treatment of an org-less profile.
      return {
        items: [],
        total: 0,
        limit: Math.min(Math.max(query.limit ?? DEFAULT_AUDIT_LIMIT, 1), MAX_AUDIT_LIMIT),
        offset: Math.max(query.offset ?? 0, 0),
      };
    }

    const limit = Math.min(Math.max(query.limit ?? DEFAULT_AUDIT_LIMIT, 1), MAX_AUDIT_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);

    const where: Prisma.AuditLogWhereInput = {
      organisationId: user.organisationId,
      ...(query.entity ? { entity: query.entity } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        // `created_at` is TIMESTAMP(3) defaulting to the TRANSACTION start
        // time, so every row written in one transaction ties exactly — and
        // Postgres gives no stable order among ties. Without the id tiebreaker
        // an offset page can repeat a row or skip one, which on an append-only
        // compliance trail is the worst possible failure.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    // `audit_log.user_id` has no FK (the row must survive the actor's deletion),
    // so the actor is resolved separately — one query for the page, not per row.
    const byId = await resolveProfiles(this.prisma, rows.map((r) => r.userId));

    return {
      items: rows.map((r) => {
        const profile = r.userId ? byId.get(r.userId) : undefined;
        return {
          id: r.id,
          action: r.action as AuditAction,
          entity: r.entity as AuditEntity,
          entityId: r.entityId,
          userId: r.userId,
          userEmail: profile?.email ?? null,
          userFullName: profile?.fullName ?? null,
          // The role STORED on the row, never the profile's current role: an
          // audit trail that re-derived it would misstate who was allowed to
          // do what at the time.
          role: (r.role as UserRole | null) ?? null,
          diff: (r.diff as Record<string, unknown> | null) ?? null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      total,
      limit,
      offset,
    };
  }

}
