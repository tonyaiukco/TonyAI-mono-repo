import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  Prisma,
  SubsidiaryStatus,
  TrackingGranularity,
  type ActivityRecordStatus,
  type Subsidiary,
} from '@tonyai/db';
import { PENDING_REVIEW_STATUSES, admitsChild, can, mayBeAssociate } from '@tonyai/shared-types';
import type {
  BoundaryExclusionDTO,
  ControlChangeBlockerKind,
  ControlKind,
  NodeType,
  SubsidiaryBlockerCount,
  SubsidiaryBlockerKind,
  SubsidiaryDTO,
  SubsidiarySummaryDTO,
} from '@tonyai/shared-types';
import { errorBody, ResourceNotFoundError } from '../common/api-error';
import { AccessAdminService, lockTenantAdmin } from '../auth/access-admin.service';
import { CalculationsService } from '../calculations/calculations.service';
import { assertPricedGeography } from '../common/priced-geography';
import {
  controlChangeBlocked,
  nodeMoveBlocked,
  nodePlacementInvalid,
  nodeTypeFixed,
  treeCycle,
  treeTriggerRefusal,
} from './tree-errors';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/auth.types';
import { recordScopeWhere } from '../activity-records/record-scope';
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
interface SubsidiaryDependentCounts {
  terminalRecords: number;
  /**
   * Inventory boundary versions declaring the subsidiary (LP3-04 W9): frozen
   * ones — confirmed or captured, never changed — keep it for good; an open
   * one can drop it. Neither is in the panel's DTO: the blockers say so.
   */
  frozenBoundaryVersions: number;
  openBoundaryVersions: number;
  reviewRecords: number;
  openRecords: number;
  /** A blocker since inc26-group-tree (RD9): a company with a facility is not
   *  deleted, and a delete no longer removes facilities. */
  locations: number;
  /** Child nodes in the group tree; the database's RESTRICT key holds it too. */
  children: number;
  /**
   * Locations of this subsidiary holding a record that belongs to a DIFFERENT
   * subsidiary — an integrity alarm, not a dependency anyone manages.
   *
   * It should be impossible: `computeSnapshot` refuses to attach a record to a
   * location outside its own subsidiary. But there is no composite FK or CHECK
   * behind that rule, PR 1's security review said so in as many words, and this
   * is the one place where trusting it would silently detach another
   * subsidiary's record.
   *
   * Counted with `subsidiaryId: { not: id }` deliberately. Counting ALL records
   * at the location — which is what this did first — double-reports the
   * subsidiary's own records, since those are already in the three tiers above.
   * It produced a 409 that told the user to remove a location AND that the
   * location would stay, and neither was true: deleting just the record made
   * the delete succeed with the location swept.
   */
  locationsHoldingForeignRecords: number;
  periodLocks: number;
  targets: number;
  denominators: number;
}

@Injectable()
export class SubsidiariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly locations: LocationsService,
    private readonly accessAdmin: AccessAdminService,
    private readonly calculations: CalculationsService,
  ) {}

  /**
   * The company as the API answers it. `readable` is the caller's accessible
   * set: `parentId` is answered only for a parent in it, and `null` otherwise
   * (design D4) — a reader granted a child but not its parent learns nothing
   * of the parent, not even its id. Omitted for an audit row's diff, which
   * holds the stored value (its readers read the whole organisation).
   */
  private toDTO(s: Subsidiary, readable?: ReadonlySet<string>): SubsidiaryDTO {
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
      trackingGranularity: s.trackingGranularity,
      parentId: s.parentId !== null && (readable === undefined || readable.has(s.parentId)) ? s.parentId : null,
      nodeType: s.nodeType,
      control: s.control,
      sharePercent: s.sharePercent === null ? null : s.sharePercent.toNumber(),
      naceCode: s.naceCode,
      createdByRole: s.createdByRole,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private static readable(user: RequestUser, ...more: string[]): ReadonlySet<string> {
    return new Set([...user.accessibleSubsidiaryIds, ...more]);
  }

  /** Changing, moving or deleting a company, and setting its control, are
   *  organisation structure — a masterkey only (INC-2.6 §6, RD8). */
  private assertCanWrite(user: RequestUser): void {
    if (!can(user.role, 'company.write')) {
      throw new ForbiddenException('Only a masterkey may modify subsidiaries');
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
    const readable = SubsidiariesService.readable(user);
    return subs.map((s) => this.toDTO(s, readable));
  }

  async get(user: RequestUser, id: string): Promise<SubsidiaryDTO> {
    // Tenant isolation: ids outside the accessible set are treated as not found.
    if (!user.accessibleSubsidiaryIds.includes(id)) {
      throw new ResourceNotFoundError('subsidiary_not_found');
    }
    const s = await this.prisma.subsidiary.findUnique({ where: { id } });
    if (!s) throw new ResourceNotFoundError('subsidiary_not_found');
    return this.toDTO(s, SubsidiariesService.readable(user));
  }

  /**
   * The associates the caller can read, for the boundary-exclusions note
   * (design D8, RD11): in practice a masterkey's and an auditor's, since no
   * grant can name an associate. Name and share percent only.
   */
  async boundaryExclusions(user: RequestUser): Promise<BoundaryExclusionDTO[]> {
    if (user.accessibleSubsidiaryIds.length === 0) return [];
    const rows = await this.prisma.subsidiary.findMany({
      where: { id: { in: user.accessibleSubsidiaryIds }, control: 'associate' },
      select: { id: true, legalName: true, sharePercent: true },
      orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({
      subsidiaryId: r.id,
      legalName: r.legalName,
      sharePercent: r.sharePercent === null ? null : r.sharePercent.toNumber(),
    }));
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
    this.assertCanCreate(user, dto);
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
    // Pure input validation, before anything is written: the locations for this
    // subsidiary are in the request, so the invariant needs no DB read and no
    // ordering inside the transaction. An earlier cut refused the field on
    // create for exactly that supposed reason — which was wrong, and cost the
    // derived `UpdateSubsidiaryInput` and a hole in the key-parity guard.
    if (dto.trackingGranularity === 'location') {
      this.assertHasLocations(dto.locations?.length ?? 0);
    }
    const placement = await this.resolvePlacement(tx, user, dto);
    const control: ControlKind = dto.control ?? 'controlled';
    if (control === 'associate' && !mayBeAssociate(placement.nodeType)) {
      throw nodePlacementInvalid('Only a company or a child company can be an associate; every other node is controlled.');
    }
    // A sector group is a label: it holds no facility and takes its parent's
    // geography unchecked, since nothing is ever priced for it (D10). Every
    // other node takes only a geography the factor library prices.
    let geographyCode = dto.geographyCode;
    if (placement.nodeType === 'sector_group') {
      if ((dto.locations?.length ?? 0) > 0) {
        throw nodePlacementInvalid('A sector group holds no facility: add the facility to a company beneath it.');
      }
      geographyCode = placement.parentGeography ?? geographyCode;
    } else {
      await assertPricedGeography(this.calculations, geographyCode);
    }
    // A super_admin's child company (D5): its scope re-read under the
    // administration lock before anything is written, and its grant written
    // below in this same transaction.
    const byCreator = !can(user.role, 'company.write');
    if (byCreator) await this.accessAdmin.lockChildCompanyCreator(tx, user, placement.parentId as string);
    let created: Subsidiary;
    try {
      created = await tx.subsidiary.create({
        data: {
          organisationId: user.organisationId as string,
          legalName: dto.legalName,
          tradingName: dto.tradingName ?? null,
          location: dto.location ?? null,
          geographyCode,
          businessArea: dto.businessArea ?? null,
          sector: dto.sector ?? null,
          designatedPerson: dto.designatedPerson ?? null,
          contactEmail: dto.contactEmail ?? null,
          contactPhone: dto.contactPhone ?? null,
          reportingStatus: (dto.reportingStatus ?? 'pending') as SubsidiaryStatus,
          includedScopes: dto.includedScopes ?? [1, 2],
          trackingGranularity: (dto.trackingGranularity ??
            'subsidiary') as TrackingGranularity,
          parentId: placement.parentId,
          nodeType: placement.nodeType,
          control,
          sharePercent: dto.sharePercent ?? null,
          naceCode: dto.naceCode ?? null,
          createdByRole: user.role,
        },
      });
    } catch (e) {
      throw treeTriggerRefusal(e) ?? e;
    }
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
    if (byCreator) await this.accessAdmin.grantChildCompanyCreator(tx, user, created.id);
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
    return this.toDTO(created, SubsidiariesService.readable(user, created.id));
  }

  /**
   * Who may create what (INC-2.6 §6, design D5) — role-only refusals, before
   * any company is looked at: a masterkey any admitted node; a super_admin a
   * controlled `child_company` only, its parent then checked against its
   * scope; anyone else nothing.
   */
  private assertCanCreate(user: RequestUser, dto: CreateSubsidiaryDto): void {
    if (!user.organisationId) throw new ForbiddenException('No organisation context for this user');
    if (can(user.role, 'company.write')) return;
    if (!can(user.role, 'company.create_child')) {
      throw new ForbiddenException('Only a masterkey may modify subsidiaries');
    }
    if (dto.nodeType !== 'child_company') {
      throw new ForbiddenException('A super_admin creates child companies only, under a company it is granted');
    }
    if (dto.control !== undefined && dto.control !== 'controlled') {
      throw new ForbiddenException("Only a masterkey sets a company's control");
    }
  }

  /**
   * Where a new node sits (RD7, RD14). A named parent must be readable by the
   * caller — anything else, another organisation's node included, answers as
   * an unknown company — and must admit the type. No parent named: under the
   * organisation's root as a `company`, or as the root itself (a `holding`)
   * when the organisation has none. The database's TA018 holds the same rules
   * for every writer; the API words them.
   */
  private async resolvePlacement(
    tx: Prisma.TransactionClient,
    user: RequestUser,
    dto: CreateSubsidiaryDto,
  ): Promise<{ parentId: string | null; nodeType: NodeType; parentGeography: string | null }> {
    const organisationId = user.organisationId as string;
    const select = { id: true, nodeType: true, control: true, geographyCode: true } as const;
    if (dto.parentId != null) {
      if (!user.accessibleSubsidiaryIds.includes(dto.parentId)) throw new ResourceNotFoundError('subsidiary_not_found');
      const parent = await tx.subsidiary.findFirst({ where: { id: dto.parentId, organisationId }, select });
      if (!parent) throw new ResourceNotFoundError('subsidiary_not_found');
      const nodeType = dto.nodeType ?? 'company';
      if (nodeType === 'holding') throw nodePlacementInvalid('This organisation already has its holding, the root.');
      if (!admitsChild(parent, nodeType)) throw nodePlacementInvalid();
      return { parentId: parent.id, nodeType, parentGeography: parent.geographyCode };
    }
    const root = await tx.subsidiary.findFirst({ where: { organisationId, nodeType: 'holding' }, select });
    if (!root) {
      // The organisation's first node is its root.
      if (dto.nodeType !== undefined && dto.nodeType !== 'holding' && dto.nodeType !== 'company') {
        throw nodePlacementInvalid("An organisation's first company is its root, the holding.");
      }
      return { parentId: null, nodeType: 'holding', parentGeography: null };
    }
    const nodeType = dto.nodeType ?? 'company';
    if (nodeType === 'holding') throw nodePlacementInvalid('This organisation already has its holding, the root.');
    if (!admitsChild(root, nodeType)) throw nodePlacementInvalid();
    return { parentId: root.id, nodeType, parentGeography: root.geographyCode };
  }

  async update(
    user: RequestUser,
    id: string,
    dto: UpdateSubsidiaryDto,
  ): Promise<SubsidiaryDTO> {
    this.assertCanWrite(user);
    // Tenant check, not just the role check: without it a masterkey of one
    // organisation could update another organisation's subsidiary. 404 (never
    // 403) so the response cannot confirm the row exists — the same rule every
    // other scoped read/write in the API follows.
    const existing = await this.loadScoped(user, id);
    // A node's type is fixed at creation; the same type sent back is no change.
    if (dto.nodeType !== undefined && dto.nodeType !== existing.nodeType) throw nodeTypeFixed();

    const data: Prisma.SubsidiaryUncheckedUpdateInput = {};
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
    if (dto.trackingGranularity !== undefined) {
      await this.assertGranularityIsUsable(id, dto.trackingGranularity);
      data.trackingGranularity = dto.trackingGranularity as TrackingGranularity;
    }
    if (dto.sharePercent !== undefined) data.sharePercent = dto.sharePercent;
    if (dto.naceCode !== undefined) data.naceCode = dto.naceCode;
    // A stored geography stays valid until it is changed (an existing company
    // is renamed whatever the library prices); a new one must be priced. A
    // sector group's is never priced, so never checked (D10).
    if (
      dto.geographyCode !== undefined &&
      dto.geographyCode !== existing.geographyCode &&
      existing.nodeType !== 'sector_group'
    ) {
      await assertPricedGeography(this.calculations, dto.geographyCode);
    }
    // In a transaction like create and delete. It was not, which left this
    // class half-atomic — a crash between the row write and the audit insert
    // lost the trail for an update while create and delete were safe.
    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.parentId !== undefined || dto.control !== undefined) {
        // TA018's own lock order, taken before the row: the organisation's
        // tree lock, then the node. Updating the row first and meeting the
        // tree lock in the trigger could deadlock against a move of an
        // ancestor, which holds the tree lock and then locks its subtree
        // (architect and security review, WP7).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tonyai.subsidiary_tree'), hashtext(${existing.organisationId}))`;
      }
      // The node FOR NO KEY UPDATE, then read again: what changes, and the
      // audit row's `before`, come from the row as locked, not from the read
      // before the transaction — two moves of one company would otherwise
      // both record its first parent (owner review of WP7, P2). The lock also
      // serialises an associate tick against a record, a grant or a boundary
      // declaration, each of which reads the row FOR SHARE.
      await tx.$queryRaw`SELECT id FROM subsidiaries WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
      const current = await tx.subsidiary.findUnique({ where: { id } });
      if (!current) throw new ResourceNotFoundError('subsidiary_not_found');
      const moves = dto.parentId !== undefined && dto.parentId !== current.parentId;
      if (moves) data.parentId = dto.parentId;
      const controlChanges = dto.control !== undefined && dto.control !== current.control;
      if (controlChanges) data.control = dto.control;
      if (moves) await this.assertMovable(tx, user, current, dto.parentId ?? null);
      if (controlChanges && dto.control === 'associate') await this.assertMayBecomeAssociate(tx, current);
      let row: Subsidiary;
      try {
        row = await tx.subsidiary.update({ where: { id }, data });
      } catch (e) {
        throw treeTriggerRefusal(e) ?? e;
      }
      await this.audit.record(
        user,
        {
          action: 'update',
          entity: 'subsidiary',
          entityId: id,
          diff: { before: this.toDTO(current), after: this.toDTO(row) },
        },
        tx,
      );
      return row;
    });
    return this.toDTO(updated, SubsidiariesService.readable(user));
  }

  /**
   * A move (INC-2.6 §2.2): the holding does not move and every other node
   * keeps a parent; the new parent is a readable node that admits the type;
   * never under the node itself or its subtree (`tree_cycle`); never while the
   * subtree — facilities included — holds a record in any status (RD6,
   * `node_move_blocked`). TA018 holds each rule again under the
   * organisation's lock, so a concurrent move or record the reads below miss
   * is refused there with the same code.
   */
  private async assertMovable(
    tx: Prisma.TransactionClient,
    user: RequestUser,
    node: Subsidiary,
    parentId: string | null,
  ): Promise<void> {
    if (node.nodeType === 'holding') throw nodePlacementInvalid('The holding is the root of the tree and does not move.');
    if (parentId === null) throw nodePlacementInvalid('Only the holding has no parent.');
    if (!user.accessibleSubsidiaryIds.includes(parentId)) throw new ResourceNotFoundError('subsidiary_not_found');
    const parent = await tx.subsidiary.findFirst({
      where: { id: parentId, organisationId: node.organisationId },
      select: { id: true, nodeType: true, control: true },
    });
    if (!parent) throw new ResourceNotFoundError('subsidiary_not_found');
    if (parent.id === node.id) throw treeCycle();
    const [{ cycle }] = await tx.$queryRaw<{ cycle: boolean }[]>`
      WITH RECURSIVE up (id, parent_id) AS (
        SELECT s.id, s.parent_id FROM subsidiaries s WHERE s.id = ${parent.id}::uuid
        UNION
        SELECT s.id, s.parent_id FROM subsidiaries s JOIN up ON s.id = up.parent_id
      )
      SELECT EXISTS (SELECT 1 FROM up WHERE up.id = ${node.id}::uuid) AS cycle`;
    if (cycle) throw treeCycle();
    if (!admitsChild(parent, node.nodeType)) throw nodePlacementInvalid();
    const [{ records }] = await tx.$queryRaw<{ records: boolean }[]>`
      WITH RECURSIVE down (id) AS (
        SELECT ${node.id}::uuid
        UNION
        SELECT s.id FROM subsidiaries s JOIN down d ON s.parent_id = d.id
      )
      SELECT EXISTS (SELECT 1 FROM activity_records r WHERE r.subsidiary_id IN (SELECT id FROM down)) AS records`;
    if (records) throw nodeMoveBlocked();
  }

  /**
   * Ticking associate (RD3): a company or child company only, and refused
   * while it — or a facility of it — holds a record in any status, an account
   * is assigned to it, it has a child node, or the newest inventory-boundary
   * version of any reporting year declares it. The refusal names each kind;
   * nothing is withdrawn or hidden silently. TA018 backs the first three.
   */
  private async assertMayBecomeAssociate(tx: Prisma.TransactionClient, node: Subsidiary): Promise<void> {
    if (!mayBeAssociate(node.nodeType)) {
      throw nodePlacementInvalid('Only a company or a child company can be an associate; every other node is controlled.');
    }
    const [records, assignments, children, declarations] = await Promise.all([
      tx.activityRecord.count({ where: { subsidiaryId: node.id } }),
      tx.userSubsidiaryAccess.count({ where: { subsidiaryId: node.id } }),
      tx.subsidiary.count({ where: { parentId: node.id } }),
      tx.inventoryBoundarySubsidiary.findMany({
        where: { subsidiaryId: node.id },
        select: { boundary: { select: { reportingYear: true, version: true } } },
      }),
    ]);
    // A year's current boundary: its newest version, or its newest frozen
    // one — which is the newest again once an open version after it is
    // deleted (owner review of WP7, P1). TA018 holds the same rule.
    let declaredInNewest = false;
    for (const year of new Set(declarations.map((d) => d.boundary.reportingYear))) {
      const [newest, newestFrozen] = await Promise.all([
        tx.inventoryBoundary.findFirst({
          where: { organisationId: node.organisationId, reportingYear: year },
          orderBy: { version: 'desc' },
          select: { version: true },
        }),
        tx.inventoryBoundary.findFirst({
          where: { organisationId: node.organisationId, reportingYear: year, frozenAt: { not: null } },
          orderBy: { version: 'desc' },
          select: { version: true },
        }),
      ]);
      const current = new Set([newest?.version, newestFrozen?.version].filter((v): v is number => v !== undefined));
      if (declarations.some((d) => d.boundary.reportingYear === year && current.has(d.boundary.version))) {
        declaredInNewest = true;
        break;
      }
    }
    const kinds: ControlChangeBlockerKind[] = [];
    if (records > 0) kinds.push('records');
    if (assignments > 0) kinds.push('assignments');
    if (children > 0) kinds.push('children');
    if (declaredInNewest) kinds.push('boundaryDeclarations');
    if (kinds.length > 0) throw controlChangeBlocked(kinds);
  }

  /**
   * Refuse `location` granularity for a subsidiary that owns no locations.
   *
   * The denominator is `locations × 12`, so with none every slot is vacuously
   * covered and any cell holding a record reads as complete — on the one screen
   * whose whole job is to show where data is missing. (A cell with no records
   * at all still reads `missing`, so the failure needs one stray record to
   * surface; that is a narrower hole, not an absent one.) Refusing here rather
   * than special-casing it downstream keeps the invariant where it can be
   * stated once — a subsidiary measured by location has locations to measure.
   */
  private async assertGranularityIsUsable(
    subsidiaryId: string,
    granularity: string,
  ): Promise<void> {
    if (granularity !== 'location') return;
    this.assertHasLocations(
      await this.prisma.location.count({ where: { subsidiaryId } }),
    );
  }

  /** The same invariant stated for the create path, where the locations are in
   *  the request rather than the database. Both callers land here so the rule
   *  cannot be enforced on one write path and not the other. */
  private assertHasLocations(count: number): void {
    if (count === 0) {
      throw new BadRequestException(
        errorBody(
          'subsidiary_location_required',
          'Add at least one location before tracking this subsidiary by location — ' +
            'the completeness rule counts one invoice per location per month, and ' +
            'with no locations every slot is vacuously covered — a subsidiary ' +
            'holding no data at all would read as complete.',
        ),
      );
    }
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
    /** The reader's record scope for the panel's read-only view; none for a
     *  delete, which must count every record it would cascade. */
    recordScope: Prisma.ActivityRecordWhereInput = {},
    /** The reader's companies, for the panel: a child it cannot read is not
     *  counted (nor named). None for a delete, which counts every child. */
    childScope?: readonly string[],
  ): Promise<SubsidiaryDependentCounts> {
    // Annotated, not inferred: assignability is what catches a status that no
    // longer exists in the Prisma enum, and it names the bad one. The same trap
    // period-locks.service.ts documents — an index-lookup form would only be
    // guarded by TS7053, which this package has switched off.
    const reviewable: ActivityRecordStatus[] = [...PENDING_REVIEW_STATUSES];
    const editable: ActivityRecordStatus[] = [...EDITABLE_STATUSES];
    // `terminal` is everything else — the count below really is a `notIn`, and
    // `voided` lands in it by construction. Saying so plainly because the
    // outcome IS the intended one and should not read as an accident: a voided
    // record contributes to no total, but it IS the record that a figure was
    // withdrawn and why; deleting the subsidiary would cascade it away and take
    // the only trace of the restatement with it. Same reasoning as approved and
    // locked: a subsidiary that has reported data is retired, not deleted.

    const [
      terminalRecords,
      reviewRecords,
      openRecords,
      locations,
      locationsHoldingForeignRecords,
      periodLocks,
      targets,
      denominators,
      frozenBoundaryVersions,
      openBoundaryVersions,
      children,
    ] =
      await Promise.all([
        db.activityRecord.count({
          where: { subsidiaryId: id, status: { notIn: [...editable, ...reviewable] }, AND: [recordScope] },
        }),
        db.activityRecord.count({
          where: { subsidiaryId: id, status: { in: reviewable }, AND: [recordScope] },
        }),
        db.activityRecord.count({
          where: { subsidiaryId: id, status: { in: editable }, AND: [recordScope] },
        }),
        db.location.count({ where: { subsidiaryId: id } }),
        db.location.count({
          where: {
            subsidiaryId: id,
            activityRecords: { some: { subsidiaryId: { not: id } } },
          },
        }),
        db.periodLock.count({ where: { subsidiaryId: id } }),
        db.target.count({ where: { subsidiaryId: id } }),
        db.subsidiaryDenominator.count({ where: { subsidiaryId: id } }),
        db.inventoryBoundarySubsidiary.count({ where: { subsidiaryId: id, boundary: { frozenAt: { not: null } } } }),
        db.inventoryBoundarySubsidiary.count({ where: { subsidiaryId: id, boundary: { frozenAt: null } } }),
        db.subsidiary.count({ where: { parentId: id, ...(childScope ? { id: { in: [...childScope] } } : {}) } }),
      ]);
    return {
      terminalRecords,
      frozenBoundaryVersions,
      openBoundaryVersions,
      reviewRecords,
      openRecords,
      locations,
      children,
      locationsHoldingForeignRecords,
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
   * only far more cheaply. The record counts take the reader's record scope,
   * so a standard user's counts its ticked categories and own records only.
   */
  async summary(user: RequestUser, id: string): Promise<SubsidiarySummaryDTO> {
    await this.loadScoped(user, id);
    // `this.prisma` is directly assignable — the delegates a transaction client
    // exposes are the ones used here. Verified: removing the cast typechecks.
    const counts = await this.countDependents(this.prisma, id, recordScopeWhere(user), user.accessibleSubsidiaryIds);
    const refusal = SubsidiariesService.describeBlockers(counts);
    const {
      locationsHoldingForeignRecords: _alarm,
      frozenBoundaryVersions: _frozen,
      openBoundaryVersions: _open,
      ...reportable
    } = counts;
    void _alarm;
    void _frozen;
    void _open;
    return {
      subsidiaryId: id,
      ...reportable,
      // The guard's own sentences, not a second set written for the UI.
      blockers: refusal?.blockers ?? [],
      blockerCounts: refusal?.counts ?? [],
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
   * with `approved` told a masterkey that a mistyped subsidiary was
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
    /** The same dependents as facts, in `blockers`' order (LP4-04 PR C). */
    counts: SubsidiaryBlockerCount[];
  } | null {
    if (c.terminalRecords > 0) {
      const message =
        `${c.terminalRecords} approved, locked or voided activity record(s) belong to this ` +
        'subsidiary, and deleting it would permanently destroy them along with ' +
        'their evidence. Those records cannot be deleted at any point, so a ' +
        'subsidiary that has reported data stays. Set its status to "inactive" ' +
        'to retire it instead.';
      return { message, blockers: [message], counts: [{ kind: 'terminalRecords', count: c.terminalRecords }] };
    }
    if (c.frozenBoundaryVersions > 0) {
      const message =
        `This subsidiary is declared in ${c.frozenBoundaryVersions} confirmed or captured inventory ` +
        'boundary version(s), which record the inventory a report was issued from and never ' +
        'change, so a subsidiary declared in one stays. Set its status to "inactive" to retire it instead.';
      return {
        message,
        blockers: [message],
        counts: [{ kind: 'frozenBoundaryVersions', count: c.frozenBoundaryVersions }],
      };
    }

    // Nothing terminal — so everything below IS removable, and the message
    // should say how rather than send the user to "inactive" for a subsidiary
    // that is genuinely disposable (a typo in the create form, most often).
    const blockers: string[] = [];
    const counts: SubsidiaryBlockerCount[] = [];
    const add = (kind: SubsidiaryBlockerKind, phrase: string): void => {
      blockers.push(phrase);
      counts.push({ kind, count: c[kind] });
    };
    // A child node and any facility block (inc26-group-tree, RD9): the tree
    // lists a facility as a node, and a node with a child or a facility is
    // not deleted. A delete no longer removes facilities.
    if (c.children > 0) add('children', `${c.children} child company node(s)`);
    if (c.locations > 0) add('locations', `${c.locations} facility(ies)`);
    if (c.reviewRecords > 0) add('reviewRecords', `${c.reviewRecords} record(s) awaiting review`);
    if (c.openRecords > 0) add('openRecords', `${c.openRecords} draft or returned record(s)`);
    if (c.locationsHoldingForeignRecords > 0) {
      add(
        'locationsHoldingForeignRecords',
        `${c.locationsHoldingForeignRecords} facility(ies) holding a record that belongs to another subsidiary`,
      );
    }
    if (c.periodLocks > 0) add('periodLocks', `${c.periodLocks} closed reporting period(s)`);
    if (c.targets > 0) add('targets', `${c.targets} reduction target(s)`);
    if (c.denominators > 0) add('denominators', `${c.denominators} intensity denominator(s)`);
    if (c.openBoundaryVersions > 0) {
      add('openBoundaryVersions', `${c.openBoundaryVersions} open inventory boundary version(s) declaring it`);
    }
    if (blockers.length === 0) return null;

    return {
      blockers,
      counts,
      message:
        `This subsidiary still holds ${blockers.join(', ')}. Deleting it would ` +
        'destroy them without an audit entry for each. Remove them first ' +
        '(move or delete each child company, delete each facility, ' +
        'reopen any closed period rather than deleting its lock' +
        (c.locationsHoldingForeignRecords > 0
          ? '; a facility holding another subsidiary\'s record cannot be swept up, because that figure was calculated with its geography — the record has to move or go first'
          : '') +
        (c.reviewRecords > 0
          ? '; a record awaiting review must be returned by a reviewer before it can be removed'
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
    if (refusal) throw new ConflictException(errorBody('subsidiary_in_use', refusal.message));
  }

  async remove(user: RequestUser, id: string): Promise<{ id: string; deleted: true }> {
    this.assertCanWrite(user);
    const existing = await this.loadScoped(user, id);
    // Delete + audit in one transaction: the row is gone afterwards, so a
    // failed audit insert would leave a deletion with no trail at all.
    // Stated, not inherited — the same argument the create path makes.
    await this.prisma.$transaction(async (tx) => {
      // The organisation's administrative lock first — a grant change holds
      // it while it reads and removes grants — so the grants this delete
      // removes are not also removed, and audited, by a concurrent access
      // change (owner review of WP7, P2). Before the row lock: a grant change
      // holding the admin lock inserts grants, which share-lock this row.
      await lockTenantAdmin(tx, existing.organisationId);
      // Lock the parent row BEFORE counting. Inserting any child takes a
      // FOR KEY SHARE lock on the row it references, so FOR UPDATE here
      // serialises against a record/location/target/lock being created while
      // the counts run. Without it the guard is a time-of-check read, and the
      // loser is not an error — the FK cascades the newcomer away silently,
      // which is the exact loss this whole guard exists to prevent.
      const [locked] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM subsidiaries WHERE id = ${id}::uuid FOR UPDATE`;
      // Deleted by a concurrent request while this one waited for the lock:
      // the answer it would get now, not a 500 (pre-pilot defects).
      if (!locked) throw new ResourceNotFoundError('subsidiary_not_found');
      // The guard refuses on anything left beneath the company — a child
      // node and a facility included (RD9) — so nothing cascades.
      await this.assertDeletable(tx, id);
      // Its grants go first, removed here rather than by the key's cascade,
      // and each removal is audited as a grant's removal is anywhere else
      // (security review, WP7) — only the rows this statement removed (owner
      // review, P2). A child company a super_admin created carries one from
      // the start.
      const grants = await tx.$queryRaw<{ userId: string }[]>`
        DELETE FROM user_subsidiary_access WHERE subsidiary_id = ${id}::uuid RETURNING user_id::text AS "userId"`;
      await tx.subsidiary.delete({ where: { id } });
      await this.audit.record(
        user,
        { action: 'delete', entity: 'subsidiary', entityId: id, diff: { before: this.toDTO(existing) } },
        tx,
      );
      for (const { userId } of [...grants].sort((a, b) => a.userId.localeCompare(b.userId))) {
        await this.audit.record(
          user,
          { action: 'delete', entity: 'subsidiary_access', entityId: userId, diff: { subsidiaryId: id, reason: 'company deleted' } },
          tx,
        );
      }
    }, { timeout: 15_000 });
    return { id, deleted: true };
  }

  /**
   * Load a subsidiary the caller is entitled to see. Out-of-set ids 404 rather
   * than 403 so the response never confirms that a row exists in another
   * tenant (the project-wide rule, documented in permissions_and_roles.md §6.2).
   */
  private async loadScoped(user: RequestUser, id: string): Promise<Subsidiary> {
    if (!user.accessibleSubsidiaryIds.includes(id)) {
      throw new ResourceNotFoundError('subsidiary_not_found');
    }
    const row = await this.prisma.subsidiary.findUnique({ where: { id } });
    if (!row) throw new ResourceNotFoundError('subsidiary_not_found');
    return row;
  }
}
