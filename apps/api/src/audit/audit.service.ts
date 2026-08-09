import { Injectable } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';

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

/** The full taxonomy. `submit|review|approve|reject` used to be `update`. */
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'submit'
  | 'review'
  | 'approve'
  | 'reject'
  | 'lock'
  | 'unlock'
  | 'generate';

export type AuditEntity =
  | 'subsidiary'
  | 'location'
  | 'activity_record'
  | 'evidence'
  | 'period_lock'
  | 'target'
  | 'denominator'
  | 'report';

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
}
