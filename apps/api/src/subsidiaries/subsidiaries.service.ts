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
import type { SubsidiaryDTO, SubsidiarySummaryDTO } from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { LocationsService, TrustedParent } from '../locations/locations.service';
import { EDITABLE_STATUSES } from '../activity-records/activity-records.service';
import { CreateSubsidiaryDto } from './dto/create-subsidiary.dto';
import { UpdateSubsidiaryDto } from './dto/update-subsidiary.dto';

/**
 * The counts, on their own. Named as its own type rather than derived from the
 * summary DTO so that adding an INFORMATIONAL field to the DTO later cannot
 * silently enrol it as a delete blocker.
 *
 * There used to be a `BLOCKING_DEPENDENTS` array beside this, listing which of
 * these actually stop a delete. It is gone: `describeBlockers` is now the only
 * thing that decides, and `hasBlockingDependents` is simply "did it refuse".
 * A list that has to be kept in sync with a function is strictly worse than
 * having no second list at all.
 */
type SubsidiaryDependentCounts = Pick<
  SubsidiarySummaryDTO,
  | 'terminalRecords'
  | 'reviewRecords'
  | 'openRecords'
  | 'locations'
  | 'periodLocks'
  | 'targets'
  | 'denominators'
>;

@Injectable()
export class SubsidiariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly locations: LocationsService,
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
      contactEmail: s.contactEmail,
      contactPhone: s.contactPhone,
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

  /**
   * Create a subsidiary and, optionally, its operational locations — all in one
   * transaction (round-1 UAT SUB-3).
   *
   * Atomic on purpose: a half-created subsidiary is worse than a failed create,
   * because its locations are its reporting borders and a partial set produces
   * a completeness denominator that is quietly wrong rather than obviously
   * missing.
   *
   * The locations go through `LocationsService.writeLocationForTrustedParent`
   * rather than `LocationsService.create`, because the latter checks
   * `accessibleSubsidiaryIds` — computed at authentication time, so it cannot
   * contain the subsidiary this very transaction just inserted. Using the
   * shared writer also means each location's audit row is byte-identical to one
   * created later through `POST /locations`.
   */
  async create(user: RequestUser, dto: CreateSubsidiaryDto): Promise<SubsidiaryDTO> {
    this.assertCanWrite(user);
    // The timeout is stated, not inherited. Prisma's default is 5s; the DTO
    // caps `locations` so the work fits well inside it, and naming the number
    // here means a future raise of that cap has to confront this line.
    return this.prisma.$transaction(async (tx) => this.createInTx(tx, user, dto), {
      timeout: 10_000,
    });
  }

  private async createInTx(
    tx: Prisma.TransactionClient,
    user: RequestUser,
    dto: CreateSubsidiaryDto,
  ): Promise<SubsidiaryDTO> {
    const created = await tx.subsidiary.create({
      data: {
        organisationId: user.organisationId as string,
        legalName: dto.legalName,
        tradingName: dto.tradingName ?? null,
        location: dto.location ?? null,
        geographyCode: dto.geographyCode,
        businessArea: dto.businessArea ?? null,
        sector: dto.sector ?? null,
        designatedPerson: dto.designatedPerson ?? null,
        contactEmail: dto.contactEmail ?? null,
        contactPhone: dto.contactPhone ?? null,
        reportingStatus: (dto.reportingStatus ?? 'pending') as SubsidiaryStatus,
        includedScopes: dto.includedScopes ?? [1, 2],
      },
    });
    await this.audit.record(
      user,
      {
        action: 'create',
        entity: 'subsidiary',
        entityId: created.id,
        diff: { after: this.toDTO(created) },
      },
      tx,
    );
    // One audit row per location, exactly as `POST /locations` writes them —
    // never a single batched row, or a location's history would depend on how
    // it was created.
    for (const loc of dto.locations ?? []) {
      await this.locations.writeLocationForTrustedParent(
        tx,
        user,
        TrustedParent.becauseJustCreated(created),
        loc,
      );
    }
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
    if (dto.contactEmail !== undefined) data.contactEmail = dto.contactEmail;
    if (dto.contactPhone !== undefined) data.contactPhone = dto.contactPhone;
    if (dto.reportingStatus !== undefined) {
      data.reportingStatus = dto.reportingStatus as SubsidiaryStatus;
    }
    if (dto.includedScopes !== undefined) data.includedScopes = dto.includedScopes;

    // In a transaction like create and delete. It was not, which left this
    // class half-atomic — a crash between the row write and the audit insert
    // lost the trail for an update while create and delete were safe.
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.subsidiary.update({ where: { id }, data });
      await this.audit.record(
        user,
        {
          action: 'update',
          entity: 'subsidiary',
          entityId: id,
          diff: { before: this.toDTO(existing), after: this.toDTO(row) },
        },
        tx,
      );
      return row;
    });
    return this.toDTO(updated);
  }

  /**
   * Count everything that hangs off a subsidiary, in one round of queries.
   *
   * Extracted so the delete guard and `GET /subsidiaries/:id/summary` cannot
   * disagree. If the read path counted separately it would eventually drift,
   * and the visible failure would be a control panel promising a delete that
   * the API then refuses — or, worse, hiding one it would have allowed.
   */
  private async countDependents(
    db: Prisma.TransactionClient | PrismaService,
    id: string,
  ): Promise<SubsidiaryDependentCounts> {
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
    return {
      terminalRecords,
      reviewRecords,
      openRecords,
      locations,
      periodLocks,
      targets,
      denominators,
    };
  }

  /**
   * Read-only view of the same counts, for the control panel.
   *
   * Tenant-scoped but NOT role-gated, matching `get()` and SUB-2's note that
   * "reads remain tenant-scoped for other roles" — it exposes nothing a caller
   * could not already obtain by listing the child collections they can see,
   * only far more cheaply.
   */
  async summary(user: RequestUser, id: string): Promise<SubsidiarySummaryDTO> {
    await this.loadScoped(user, id);
    // `this.prisma` is directly assignable — the delegates a transaction client
    // exposes are the ones used here. Verified: removing the cast typechecks.
    const counts = await this.countDependents(this.prisma, id);
    const refusal = SubsidiariesService.describeBlockers(counts);
    return {
      subsidiaryId: id,
      ...counts,
      // The guard's own sentences, not a second set written for the UI.
      blockers: refusal?.blockers ?? [],
      // Named explicitly rather than `Object.values(counts).every(...)`. That
      // form made the dependency run backwards: because `counts` was typed off
      // the DTO, every future summary field would have been forced into the
      // blocking computation, so adding an informational count (evidence files,
      // records this year) would silently turn it into a delete blocker.
      hasBlockingDependents: refusal !== null,
    };
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
  /**
   * Compose the refusal from a set of counts — the ONE place the wording lives.
   *
   * Returns `null` when nothing blocks. Both consumers read it: the guard turns
   * it into the 409, and `summary()` returns the same sentences so a control
   * panel can explain the refusal without attempting it. Splitting them would
   * reintroduce, at the level of prose, exactly the drift that extracting
   * `countDependents` removed at the level of numbers — and prose drift is
   * worse, because two slightly different explanations of the same rule read
   * like two different rules.
   */
  private static describeBlockers(c: SubsidiaryDependentCounts): {
    message: string;
    blockers: string[];
  } | null {
    if (c.terminalRecords > 0) {
      const message =
        `${c.terminalRecords} approved or locked activity record(s) belong to this ` +
        'subsidiary, and deleting it would permanently destroy them along with ' +
        'their evidence. Those records cannot be deleted at any point, so a ' +
        'subsidiary that has reported data stays. Set its status to "inactive" ' +
        'to retire it instead.';
      return { message, blockers: [message] };
    }

    // Nothing terminal — so everything below IS removable, and the message
    // should say how rather than send the user to "inactive" for a subsidiary
    // that is genuinely disposable (a typo in the create form, most often).
    const blockers: string[] = [];
    if (c.reviewRecords > 0) blockers.push(`${c.reviewRecords} record(s) awaiting review`);
    if (c.openRecords > 0) blockers.push(`${c.openRecords} draft or rejected record(s)`);
    if (c.locations > 0) blockers.push(`${c.locations} location(s)`);
    if (c.periodLocks > 0) blockers.push(`${c.periodLocks} closed reporting period(s)`);
    if (c.targets > 0) blockers.push(`${c.targets} reduction target(s)`);
    if (c.denominators > 0) blockers.push(`${c.denominators} intensity denominator(s)`);
    if (blockers.length === 0) return null;

    return {
      blockers,
      message:
        `This subsidiary still holds ${blockers.join(', ')}. Deleting it would ` +
        'destroy them without an audit entry for each. Remove them first ' +
        '(reopen any closed period rather than deleting its lock' +
        (c.reviewRecords > 0
          ? '; a record awaiting review must be sent back by a reviewer before it can be removed'
          : '') +
        '), then delete the subsidiary.',
    };
  }

  private async assertDeletable(
    db: Prisma.TransactionClient,
    id: string,
  ): Promise<void> {
    const refusal = SubsidiariesService.describeBlockers(
      await this.countDependents(db, id),
    );
    if (refusal) throw new ConflictException(refusal.message);
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
