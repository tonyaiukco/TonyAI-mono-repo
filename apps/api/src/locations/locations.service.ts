import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Location } from '@tonyai/db';
import type { LocationDTO } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';

@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private toDTO(l: Location): LocationDTO {
    return {
      id: l.id,
      subsidiaryId: l.subsidiaryId,
      name: l.name,
      geographyCode: l.geographyCode,
      address: l.address,
      authorizedPerson: l.authorizedPerson,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    };
  }

  /** Admin-managed org structure: only super_admin may modify locations. */
  private assertCanWrite(user: RequestUser): void {
    if (user.role !== 'super_admin') {
      throw new ForbiddenException('Only super_admin may modify locations');
    }
  }

  /**
   * Load a location and enforce tenant isolation: ids whose parent subsidiary
   * is outside the caller's accessible set are treated as not found.
   */
  private async loadScoped(user: RequestUser, id: string): Promise<Location> {
    const location = await this.prisma.location.findUnique({ where: { id } });
    if (
      !location ||
      !user.accessibleSubsidiaryIds.includes(location.subsidiaryId)
    ) {
      throw new NotFoundException('Location not found');
    }
    return location;
  }

  async list(
    user: RequestUser,
    subsidiaryId?: string,
  ): Promise<LocationDTO[]> {
    // Tenant scope: intersect any requested subsidiaryId with the accessible set.
    let subsidiaryFilter: Prisma.StringFilter | string;
    if (subsidiaryId) {
      if (!user.accessibleSubsidiaryIds.includes(subsidiaryId)) {
        return []; // requested a subsidiary the caller cannot see -> empty
      }
      subsidiaryFilter = subsidiaryId;
    } else {
      subsidiaryFilter = { in: user.accessibleSubsidiaryIds };
    }

    const rows = await this.prisma.location.findMany({
      where: { subsidiaryId: subsidiaryFilter },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((l) => this.toDTO(l));
  }

  async get(user: RequestUser, id: string): Promise<LocationDTO> {
    const location = await this.loadScoped(user, id);
    return this.toDTO(location);
  }

  /**
   * Write one location row and its audit entry, against a parent the CALLER has
   * already established the right to write to.
   *
   * Exported for `POST /subsidiaries`, which creates a subsidiary and its
   * locations in a single transaction. That path cannot go through `create()`
   * below: `accessibleSubsidiaryIds` is computed at authentication time, so it
   * does not contain a subsidiary created moments earlier in the same request —
   * the tenant check would 404 against the row the very same transaction just
   * inserted.
   *
   * So this deliberately performs NO authorisation of its own, and the name is
   * meant to make that impossible to miss. It is `public` only because Nest
   * services are injected across module boundaries; the two callers are
   * `create()` (which checks the role AND the accessible set first) and the
   * subsidiary create (which is creating the parent, so the parent is the
   * actor's own organisation by construction).
   *
   * Living here rather than in the subsidiary service is the point: the audit
   * row's shape is defined once. A location created during a subsidiary create
   * must be indistinguishable in the trail from one added later, or the meaning
   * of the audit log depends on which screen was used — the exact defect WP16
   * PR 1 fixed for the geography confirmation.
   */
  async writeLocationForTrustedParent(
    db: Prisma.TransactionClient,
    user: RequestUser,
    subsidiaryId: string,
    input: Omit<CreateLocationDto, 'subsidiaryId'>,
  ): Promise<LocationDTO> {
    const created = await db.location.create({
      data: {
        subsidiaryId,
        name: input.name,
        geographyCode: input.geographyCode,
        address: input.address ?? null,
        authorizedPerson: input.authorizedPerson ?? null,
      },
    });
    await this.audit.record(
      user,
      {
        action: 'create',
        entity: 'location',
        entityId: created.id,
        diff: { after: this.toDTO(created) },
      },
      db,
    );
    return this.toDTO(created);
  }

  async create(user: RequestUser, dto: CreateLocationDto): Promise<LocationDTO> {
    this.assertCanWrite(user);
    // Tenant isolation: cannot attach a location to an inaccessible subsidiary.
    if (!user.accessibleSubsidiaryIds.includes(dto.subsidiaryId)) {
      throw new NotFoundException('Subsidiary not found');
    }
    // Same writer the subsidiary create uses, so the two produce byte-identical
    // rows and audit entries. Wrapped in a transaction here too — this endpoint
    // used to write its audit row outside the mutation, so a crash between them
    // left a location with no trail.
    return this.prisma.$transaction((tx) =>
      this.writeLocationForTrustedParent(tx, user, dto.subsidiaryId, dto),
    );
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateLocationDto,
  ): Promise<LocationDTO> {
    this.assertCanWrite(user);
    const existing = await this.loadScoped(user, id);

    const data: Prisma.LocationUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.geographyCode !== undefined) data.geographyCode = dto.geographyCode;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.authorizedPerson !== undefined) {
      data.authorizedPerson = dto.authorizedPerson;
    }

    const updated = await this.prisma.location.update({ where: { id }, data });
    await this.audit.record(user, {
      action: 'update',
      entity: 'location',
      entityId: id,
      diff: {
      before: this.toDTO(existing),
      after: this.toDTO(updated),
    },
    });
    return this.toDTO(updated);
  }

  /**
   * Refuse to delete something that committed data still points at.
   *
   * The FK is `ON DELETE SET NULL`, so a delete used to succeed silently and
   * leave every referencing record claiming the SUBSIDIARY's geography while its
   * frozen calculation snapshot was computed from the LOCATION's — measured:
   * subsidiary TR, location UK, record detached with `geographyCode: 'UK'` still
   * in the snapshot. Nothing recorded that per record, so the divergence was
   * undiscoverable from the audit trail.
   *
   * The count is part of the message because "you cannot delete this" without a
   * number leaves the user with no idea what to do next.
   */
  private async assertNoRecords(locationId: string): Promise<void> {
    const count = await this.prisma.activityRecord.count({
      where: { locationId },
    });
    if (count > 0) {
      // Draft and rejected records can be re-targeted; committed ones cannot be
      // moved OR deleted, so for those the honest answer is that the location
      // stays — it is part of what the reported figures mean.
      throw new ConflictException(
        `${count} activity record(s) are recorded at this location. Deleting it ` +
          'would leave them showing a different geography than the one they ' +
          'were calculated with. Re-target any draft records to another ' +
          'location first; a location with committed records stays, because it ' +
          'is part of what those figures mean.',
      );
    }
  }

  async remove(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    this.assertCanWrite(user);
    const existing = await this.loadScoped(user, id);
    await this.assertNoRecords(id);
    // Delete + audit in one transaction (see subsidiaries.remove).
    await this.prisma.$transaction(async (tx) => {
      await tx.location.delete({ where: { id } });
      await this.audit.record(
        user,
        { action: 'delete', entity: 'location', entityId: id, diff: { before: this.toDTO(existing) } },
        tx,
      );
    });
    return { id, deleted: true };
  }

}
