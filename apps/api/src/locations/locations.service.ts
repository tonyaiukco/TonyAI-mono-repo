import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Location } from '@tonyai/db';
import type { LocationDTO } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { CreateLocationDto } from './dto/create-location.dto';
import { UpdateLocationDto } from './dto/update-location.dto';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  private toDTO(l: Location): LocationDTO {
    return {
      id: l.id,
      subsidiaryId: l.subsidiaryId,
      name: l.name,
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

  async create(user: RequestUser, dto: CreateLocationDto): Promise<LocationDTO> {
    this.assertCanWrite(user);
    // Tenant isolation: cannot attach a location to an inaccessible subsidiary.
    if (!user.accessibleSubsidiaryIds.includes(dto.subsidiaryId)) {
      throw new NotFoundException('Subsidiary not found');
    }
    const created = await this.prisma.location.create({
      data: {
        subsidiaryId: dto.subsidiaryId,
        name: dto.name,
        address: dto.address ?? null,
        authorizedPerson: dto.authorizedPerson ?? null,
      },
    });
    await this.audit(user.id, 'create', created.id, {
      after: this.toDTO(created),
    });
    return this.toDTO(created);
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
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.authorizedPerson !== undefined) {
      data.authorizedPerson = dto.authorizedPerson;
    }

    const updated = await this.prisma.location.update({ where: { id }, data });
    await this.audit(user.id, 'update', id, {
      before: this.toDTO(existing),
      after: this.toDTO(updated),
    });
    return this.toDTO(updated);
  }

  async remove(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    this.assertCanWrite(user);
    const existing = await this.loadScoped(user, id);
    await this.prisma.location.delete({ where: { id } });
    await this.audit(user.id, 'delete', id, { before: this.toDTO(existing) });
    return { id, deleted: true };
  }

  private async audit(
    userId: string,
    action: 'create' | 'update' | 'delete',
    entityId: string,
    diff: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        userId,
        action,
        entity: 'location',
        entityId,
        diff: diff as Prisma.InputJsonValue,
      },
    });
  }
}
