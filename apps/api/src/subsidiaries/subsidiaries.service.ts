import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SubsidiaryStatus,
  type ActivityRecordStatus,
  type Subsidiary,
} from '@tonyai/db';
import { PENDING_REVIEW_STATUSES } from '@tonyai/shared-types';
import type { SubsidiaryDTO } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { EDITABLE_STATUSES } from '../activity-records/activity-records.service';
import { CreateSubsidiaryDto } from './dto/create-subsidiary.dto';
import { UpdateSubsidiaryDto } from './dto/update-subsidiary.dto';

@Injectable()
export class SubsidiariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private toDTO(s: Subsidiary): SubsidiaryDTO {
    return {
      id: s.id,
      organisationId: s.organisationId,
      legalName: s.legalName,
      tradingName: s.tradingName,
      location: s.location,
      geographyCode: s.geographyCode,
      businessArea: s.businessArea,
      sector: s.sector,
      designatedPerson: s.designatedPerson,
      reportingStatus: s.reportingStatus,
      includedScopes: s.includedScopes,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private assertCanWrite(user: RequestUser): void {
    if (user.role !== 'super_admin') {
      throw new ForbiddenException('Only super_admin may modify subsidiaries');
    }
    if (!user.organisationId) {
      throw new ForbiddenException('No organisation context for this user');
    }
  }

  async list(user: RequestUser): Promise<SubsidiaryDTO[]> {
    const subs = await this.prisma.subsidiary.findMany({
      where: { id: { in: user.accessibleSubsidiaryIds } },
      orderBy: { createdAt: 'asc' },
    });
    return subs.map((s) => this.toDTO(s));
  }

  async get(user: RequestUser, id: string): Promise<SubsidiaryDTO> {
    // Tenant isolation: ids outside the accessible set are treated as not found.
    if (!user.accessibleSubsidiaryIds.includes(id)) {
      throw new NotFoundException('Subsidiary not found');
    }
    const s = await this.prisma.subsidiary.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Subsidiary not found');
    return this.toDTO(s);
  }

  async create(user: RequestUser, dto: CreateSubsidiaryDto): Promise<SubsidiaryDTO> {
    this.assertCanWrite(user);
    const created = await this.prisma.subsidiary.create({
      data: {
        organisationId: user.organisationId as string,
        legalName: dto.legalName,
        tradingName: dto.tradingName ?? null,
        location: dto.location ?? null,
        geographyCode: dto.geographyCode,
        businessArea: dto.businessArea ?? null,
        sector: dto.sector ?? null,
        designatedPerson: dto.designatedPerson ?? null,
        reportingStatus: (dto.reportingStatus ?? 'pending') as SubsidiaryStatus,
        includedScopes: dto.includedScopes ?? [1, 2],
      },
    });
    await this.audit.record(user, {
      action: 'create',
      entity: 'subsidiary',
      entityId: created.id,
      diff: { after: this.toDTO(created) },
    });
    return this.toDTO(created);
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateSubsidiaryDto,
  ): Promise<SubsidiaryDTO> {
    this.assertCanWrite(user);
    // Tenant check, not just the role check: without it a super_admin of one
    // organisation could update another organisation's subsidiary. 404 (never
    // 403) so the response cannot confirm the row exists — the same rule every
    // other scoped read/write in the API follows.
    const existing = await this.loadScoped(user, id);

    const data: Prisma.SubsidiaryUpdateInput = {};
    if (dto.legalName !== undefined) data.legalName = dto.legalName;
    if (dto.tradingName !== undefined) data.tradingName = dto.tradingName;
    if (dto.location !== undefined) data.location = dto.location;
    if (dto.geographyCode !== undefined) data.geographyCode = dto.geographyCode;
    if (dto.businessArea !== undefined) data.businessArea = dto.businessArea;
    if (dto.sector !== undefined) data.sector = dto.sector;
    if (dto.designatedPerson !== undefined) data.designatedPerson = dto.designatedPerson;
    if (dto.reportingStatus !== undefined) {
      data.reportingStatus = dto.reportingStatus as SubsidiaryStatus;
    }
    if (dto.includedScopes !== undefined) data.includedScopes = dto.includedScopes;

    const updated = await this.prisma.subsidiary.update({ where: { id }, data });
    await this.audit.record(user, {
      action: 'update',
      entity: 'subsidiary',
      entityId: id,
      diff: { before: this.toDTO(existing), after: this.toDTO(updated) },
    });
    return this.toDTO(updated);
  }

  /**
   * A subsidiary may only be deleted once nothing is left under it.
   *
   * EVERY child relation is `onDelete: Cascade` (schema.prisma:101, 189, 210,
   * 235), so a delete never detached anything — it destroyed it, and the FK does
   * that below the application, so the whole lot went unaudited behind a single
   * "delete subsidiary" row. Two measurements:
   *
   * - a record taken through draft → evidence → submit → approve was a 404
   *   immediately after one DELETE, with nothing recorded about the approved
   *   emissions figures that went with it;
   * - a period lock erased by cascade left its `lock` audit row with no matching
   *   `unlock`, i.e. a closed reporting period reopened with no trace, while
   *   `DELETE /period-locks/:id` writes that `unlock` row properly.
   *
   * Hence "empty it first" rather than "records only". Every dependent counted
   * here has its own endpoint that deletes it with an audit row, so the advice
   * can actually be followed.
   *
   * Records are graded in three tiers, not two, because only TWO statuses are
   * genuinely terminal. `approved` and `locked` can never be deleted, so the
   * honest answer there is that the subsidiary stays and `reportingStatus:
   * 'inactive'` is how an entity gets retired. But `submitted`/`under_review`
   * look terminal and are not: a reviewer rejects the record, and it becomes
   * deletable — measured, delete then went through with 200. Lumping those in
   * with `approved` told a super_admin that a mistyped subsidiary was
   * permanently in the register, which forecloses an action the API grants. It
   * is the same error as promising a delete that cannot happen, pointing the
   * other way.
   */
  private async assertDeletable(
    db: Prisma.TransactionClient,
    id: string,
  ): Promise<void> {
    // Annotated, not inferred: assignability is what catches a status that no
    // longer exists in the Prisma enum, and it names the bad one. The same trap
    // period-locks.service.ts documents — an index-lookup form would only be
    // guarded by TS7053, which this package has switched off.
    const reviewable: ActivityRecordStatus[] = [...PENDING_REVIEW_STATUSES];
    const editable: ActivityRecordStatus[] = [...EDITABLE_STATUSES];
    const [terminalRecords, reviewRecords, openRecords, locations, periodLocks, targets, denominators] =
      await Promise.all([
        db.activityRecord.count({
          where: { subsidiaryId: id, status: { notIn: [...editable, ...reviewable] } },
        }),
        db.activityRecord.count({
          where: { subsidiaryId: id, status: { in: reviewable } },
        }),
        db.activityRecord.count({
          where: { subsidiaryId: id, status: { in: editable } },
        }),
        db.location.count({ where: { subsidiaryId: id } }),
        db.periodLock.count({ where: { subsidiaryId: id } }),
        db.target.count({ where: { subsidiaryId: id } }),
        db.subsidiaryDenominator.count({ where: { subsidiaryId: id } }),
      ]);

    if (terminalRecords > 0) {
      throw new ConflictException(
        `${terminalRecords} approved or locked activity record(s) belong to this ` +
          'subsidiary, and deleting it would permanently destroy them along with ' +
          'their evidence. Those records cannot be deleted at any point, so a ' +
          'subsidiary that has reported data stays. Set its status to "inactive" ' +
          'to retire it instead.',
      );
    }

    // Nothing terminal — so everything below IS removable, and the message
    // should say how rather than send the user to "inactive" for a subsidiary
    // that is genuinely disposable (a typo in the create form, most often).
    const blockers: string[] = [];
    if (reviewRecords > 0) blockers.push(`${reviewRecords} record(s) awaiting review`);
    if (openRecords > 0) blockers.push(`${openRecords} draft or rejected record(s)`);
    if (locations > 0) blockers.push(`${locations} location(s)`);
    if (periodLocks > 0) blockers.push(`${periodLocks} closed reporting period(s)`);
    if (targets > 0) blockers.push(`${targets} reduction target(s)`);
    if (denominators > 0) blockers.push(`${denominators} intensity denominator(s)`);
    if (blockers.length > 0) {
      throw new ConflictException(
        `This subsidiary still holds ${blockers.join(', ')}. Deleting it would ` +
          'destroy them without an audit entry for each. Remove them first ' +
          '(reopen any closed period rather than deleting its lock' +
          (reviewRecords > 0
            ? '; a record awaiting review must be sent back by a reviewer before it can be removed'
            : '') +
          '), then delete the subsidiary.',
      );
    }
  }

  async remove(user: RequestUser, id: string): Promise<{ id: string; deleted: true }> {
    this.assertCanWrite(user);
    const existing = await this.loadScoped(user, id);
    // Delete + audit in one transaction: the row is gone afterwards, so a
    // failed audit insert would leave a deletion with no trail at all.
    await this.prisma.$transaction(async (tx) => {
      // Lock the parent row BEFORE counting. Inserting any child takes a
      // FOR KEY SHARE lock on the row it references, so FOR UPDATE here
      // serialises against a record/location/target/lock being created while
      // the counts run. Without it the guard is a time-of-check read, and the
      // loser is not an error — the FK cascades the newcomer away silently,
      // which is the exact loss this whole guard exists to prevent.
      await tx.$queryRaw`SELECT id FROM subsidiaries WHERE id = ${id}::uuid FOR UPDATE`;
      await this.assertDeletable(tx, id);
      await tx.subsidiary.delete({ where: { id } });
      await this.audit.record(
        user,
        { action: 'delete', entity: 'subsidiary', entityId: id, diff: { before: this.toDTO(existing) } },
        tx,
      );
    });
    return { id, deleted: true };
  }

  /**
   * Load a subsidiary the caller is entitled to see. Out-of-set ids 404 rather
   * than 403 so the response never confirms that a row exists in another
   * tenant (the project-wide rule, documented in permissions_and_roles.md §6.2).
   */
  private async loadScoped(user: RequestUser, id: string): Promise<Subsidiary> {
    if (!user.accessibleSubsidiaryIds.includes(id)) {
      throw new NotFoundException('Subsidiary not found');
    }
    const row = await this.prisma.subsidiary.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Subsidiary not found');
    return row;
  }
}
