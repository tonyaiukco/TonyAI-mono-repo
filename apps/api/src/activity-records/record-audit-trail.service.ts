import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  mayReadRecordTrail,
  RECORD_TRAIL_MAX_EVENTS,
  type RecordAuditTrailDTO,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { ActivityRecordsService } from './activity-records.service';
import { buildRecordTrail } from './record-trail';

export const RECORD_TRAIL_REFUSAL = "You can read the history only of records you created.";

/**
 * One activity record's history (`GET /activity-records/:id/audit-trail`;
 * WP5, `uat4-review-resubmit`, design decision 5).
 *
 * The API runs as the runtime role, which bypasses RLS, so this service is the
 * whole of the read's confinement:
 *
 * 1. The record is loaded through the same scoped read as `GET /:id`, so a
 *    record the caller cannot read (another organisation, a subsidiary with no
 *    grant, a deleted draft) is refused exactly as its read is.
 * 2. `mayReadRecordTrail` (shared-types, the web reads it too): the three
 *    organisation-wide roles read any record they can read; `data_entry` only
 *    a record they created. A `data_entry` user can already read a colleague's
 *    record, so the 403 reveals nothing.
 * 3. The audit rows are keyed by the record AND the caller's organisation.
 *
 * The answer is built from an allow-list (`buildRecordTrail`), never from the
 * stored JSON. Reading writes nothing, like `GET /audit`.
 */
@Injectable()
export class RecordAuditTrailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly records: ActivityRecordsService,
  ) {}

  async read(user: RequestUser, id: string): Promise<RecordAuditTrailDTO> {
    const record = await this.records.get(user, id);
    // Default-deny an organisation-less caller, as `GET /audit` does: the
    // organisation is part of the audit query's key.
    if (!user.organisationId || !mayReadRecordTrail(user, record)) {
      throw new ForbiddenException(RECORD_TRAIL_REFUSAL);
    }

    // The newest rows first, one more than the cap to know whether any were
    // left out; on the existing (entity, entity_id) index.
    const newest = await this.prisma.auditLog.findMany({
      where: {
        entity: 'activity_record',
        entityId: record.id,
        organisationId: user.organisationId,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RECORD_TRAIL_MAX_EVENTS + 1,
      select: { id: true, action: true, userId: true, role: true, diff: true, createdAt: true },
    });
    const truncated = newest.length > RECORD_TRAIL_MAX_EVENTS;
    const rows = newest.slice(0, RECORD_TRAIL_MAX_EVENTS).reverse();

    const userIds = [...new Set(rows.map((r) => r.userId).filter((u): u is string => !!u))];
    const locationIds = new Set<string>();
    for (const r of rows) {
      const diff = r.diff as { before?: { locationId?: unknown }; after?: { locationId?: unknown } } | null;
      for (const side of [diff?.before, diff?.after]) {
        if (typeof side?.locationId === 'string') locationIds.add(side.locationId);
      }
    }

    type Named = { id: string; name: string };
    const none: Promise<Named[]> = Promise.resolve([]);
    const [profiles, locations] = await Promise.all([
      userIds.length
        ? this.prisma.profile
            .findMany({
              where: { id: { in: userIds }, organisationId: user.organisationId },
              select: { id: true, fullName: true },
            })
            .then((rows): Named[] => rows.map((p) => ({ id: p.id, name: p.fullName })))
        : none,
      locationIds.size
        ? this.prisma.location.findMany({
            where: { id: { in: [...locationIds] }, subsidiaryId: record.subsidiaryId },
            select: { id: true, name: true },
          })
        : none,
    ]);

    return {
      recordId: record.id,
      events: buildRecordTrail(rows, {
        names: new Map(profiles.map((p) => [p.id, p.name])),
        locations: new Map(locations.map((l) => [l.id, l.name])),
      }),
      truncated,
    };
  }
}
