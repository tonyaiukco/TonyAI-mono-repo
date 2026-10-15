import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type InventoryBoundary } from '@tonyai/db';
import type {
  CreateInventoryBoundaryRequest,
  InventoryBoundaryVersionDTO,
  InventoryBoundaryVersionSummary,
  ListInventoryBoundariesParams,
  PutInventoryBoundarySubsidiaryRequest,
} from '@tonyai/shared-types';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { ResourceNotFoundError } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { copiedRows, declarationOf, declarationRows, type DeclarationRows, type VersionRows } from './boundary-declaration';
import { boundaryGaps } from './boundary-gaps';
import { lockBoundaryHeader } from './boundary-lock';
import { readBoundaryRows, readDeclaration, readVersionRows } from './boundary-rows';
import { buildBoundarySnapshot } from './boundary-snapshot';
import { loadBoundaryVersion, versionDTO, versionSummary } from './boundary-version';
import {
  BoundaryConfirmRequiresCopyError,
  BoundaryDraftOpenError,
  BoundaryFrozenError,
  BoundaryIncompleteError,
  boundaryGuardRefused,
} from './errors';

/**
 * LP3-04's write path (W1, W13; Decisions 2026-10-15 (fifth) E1–E9; the
 * contract in `packages/shared-types/src/inventory-boundary.ts`): a year's
 * boundary versions, one subsidiary's declaration at a time, and their
 * confirmation.
 *
 * `super_admin` alone writes and confirms (E2), every write in READ COMMITTED
 * — the only isolation the guard admits a row write or a freeze in (TA014) —
 * with the version's header locked FOR UPDATE as its first statement (W8, PR
 * B's (6)). Every rule the guard holds is checked here first: the version
 * open, a key never changed (rows are deleted and inserted, never updated),
 * a site within its subsidiary's months (the DTOs), no declared subsidiary or
 * site deleted (W9 — their own delete paths). So a TA014 that still arrives is
 * a defect: logged and answered as an internal error, never as "frozen" (E7).
 * Each write's audit row is written in its own transaction.
 */

const WRITE_TX = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 };
/** A version's rows read in one snapshot: between READ COMMITTED statements a
 * source could arrive at a site the read before it did not load. */
const READ_TX = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 };

const LOST_RACE_MESSAGE = 'The inventory boundary changed while this request was being saved. Reload it and try again.';

type Tx = Prisma.TransactionClient;

/** Two creates of one year's next version: the key decides between them. */
const versionTaken = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
  && JSON.stringify(e.meta?.target ?? null).includes('version');

/** The subsidiary, or a site, deleted between the check and the insert — the
 * only keys a valid declaration can break (Prisma 6 names it `meta.constraint`). */
const DECLARED_PARENT_KEYS = new Set([
  'inventory_boundary_subsidiaries_subsidiary_id_organisation_fkey',
  'inventory_boundary_sites_location_id_subsidiary_id_fkey',
]);
const declaredParentGone = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003'
  && DECLARED_PARENT_KEYS.has(String(e.meta?.constraint ?? ''));

@Injectable()
export class InventoryBoundariesService {
  private readonly logger = new Logger(InventoryBoundariesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** One year's versions, newest first; a data_entry user's, only those
   * declaring a subsidiary it is granted (the boundary's RLS, W3). */
  async list(user: RequestUser, query: ListInventoryBoundariesParams): Promise<InventoryBoundaryVersionSummary[]> {
    if (!user.organisationId) return [];
    const headers = await this.prisma.inventoryBoundary.findMany({
      where: {
        organisationId: user.organisationId,
        reportingYear: query.reportingYear,
        ...(user.role === 'data_entry'
          ? { subsidiaries: { some: { subsidiaryId: { in: user.accessibleSubsidiaryIds } } } }
          : {}),
      },
      orderBy: { version: 'desc' },
    });
    return headers.map(versionSummary);
  }

  async get(user: RequestUser, id: string): Promise<InventoryBoundaryVersionDTO> {
    const organisationId = user.organisationId;
    if (!organisationId) throw new ResourceNotFoundError('boundary_not_found');
    return this.prisma.$transaction(async (tx) => {
      const loaded = await loadBoundaryVersion(tx, id, organisationId);
      if (loaded === null) throw new ResourceNotFoundError('boundary_not_found');
      return versionDTO(loaded, user);
    }, READ_TX);
  }

  /**
   * A new open version: the year's highest + 1, refused while the newest is
   * open (E4). A copy (`copyOf`, any year, open or frozen) takes its source's
   * declarations as they are, read under the source header's share lock so no
   * edit tears it (W8); its names are read live again (W7).
   */
  async create(user: RequestUser, dto: CreateInventoryBoundaryRequest): Promise<InventoryBoundaryVersionDTO> {
    const organisationId = this.writerOrganisation(user);
    return this.write('create', dto.copyOf ?? null, async (tx) => {
      let copy: VersionRows | null = null;
      if (dto.copyOf !== undefined) {
        if (!(await lockBoundaryHeader(tx, dto.copyOf, organisationId, 'share'))) {
          throw new ResourceNotFoundError('boundary_not_found');
        }
        copy = await readVersionRows(tx, dto.copyOf);
      }
      const newest = await tx.inventoryBoundary.findFirst({
        where: { organisationId, reportingYear: dto.reportingYear },
        orderBy: { version: 'desc' },
        select: { version: true, frozenAt: true },
      });
      if (newest !== null && newest.frozenAt === null) throw new BoundaryDraftOpenError();
      const header = await tx.inventoryBoundary.create({
        data: { organisationId, reportingYear: dto.reportingYear, version: (newest?.version ?? 0) + 1, createdBy: user.id },
      });
      if (copy !== null) await insertVersionRows(tx, copiedRows(copy, header.id, randomUUID));
      await this.audit.record(
        user,
        {
          action: 'create',
          entity: 'inventory_boundary',
          entityId: header.id,
          diff: {
            reportingYear: header.reportingYear,
            version: header.version,
            ...(dto.copyOf !== undefined ? { copyOf: dto.copyOf } : {}),
          },
        },
        tx,
      );
      return this.versionIn(tx, header.id, organisationId, user);
    }, versionTaken);
  }

  /** One subsidiary's whole declaration in an open version, replacing the
   * stored one (E1); the last writer wins (E5) and its audit row holds what it
   * replaced. */
  async putSubsidiary(
    user: RequestUser,
    id: string,
    subsidiaryId: string,
    body: PutInventoryBoundarySubsidiaryRequest,
  ): Promise<InventoryBoundaryVersionDTO> {
    const organisationId = this.writerOrganisation(user);
    return this.write('put', id, async (tx) => {
      const header = await this.lockOpen(tx, id, organisationId);
      const subsidiary = await tx.subsidiary.findFirst({ where: { id: subsidiaryId, organisationId }, select: { id: true } });
      if (subsidiary === null) throw new ResourceNotFoundError('subsidiary_not_found');
      // Each site one of this subsidiary's own locations — a sibling's, another
      // organisation's and a missing one alike (the key `locations(id, subsidiary_id)`).
      const siteIds = [...new Set(body.sites.map((s) => s.locationId))];
      if (siteIds.length > 0) {
        const own = await tx.location.count({ where: { id: { in: siteIds }, subsidiaryId: subsidiary.id } });
        if (own !== siteIds.length) throw new ResourceNotFoundError('location_not_found');
      }
      const before = await readDeclaration(tx, header.id, subsidiary.id);
      // Delete and insert, never update: no key changes (TA014), no policy
      // re-keyed under its sources; the subsidiary's row cascades to the rest.
      await tx.inventoryBoundarySubsidiary.deleteMany({ where: { boundaryId: header.id, subsidiaryId: subsidiary.id } });
      const rows = declarationRows({ boundaryId: header.id, organisationId, subsidiaryId: subsidiary.id }, body, randomUUID);
      await insertDeclaration(tx, rows);
      await this.audit.record(
        user,
        {
          action: 'update',
          entity: 'inventory_boundary',
          entityId: header.id,
          diff: { subsidiaryId: subsidiary.id, before: before && declarationOf(before), after: declarationOf(rows) },
        },
        tx,
      );
      return this.versionIn(tx, header.id, organisationId, user);
    }, declaredParentGone);
  }

  /** Removes a subsidiary from an open version — the blocker W9's 409 asks to clear. */
  async deleteSubsidiary(user: RequestUser, id: string, subsidiaryId: string): Promise<InventoryBoundaryVersionDTO> {
    const organisationId = this.writerOrganisation(user);
    return this.write('delete_subsidiary', id, async (tx) => {
      const header = await this.lockOpen(tx, id, organisationId);
      // Not declared — another organisation's subsidiary included — reads as none.
      const before = await readDeclaration(tx, header.id, subsidiaryId);
      if (before === null) throw new ResourceNotFoundError('subsidiary_not_found');
      await tx.inventoryBoundarySubsidiary.delete({
        where: { boundaryId_subsidiaryId: { boundaryId: header.id, subsidiaryId: before.subsidiaryId } },
      });
      await this.audit.record(
        user,
        {
          action: 'update',
          entity: 'inventory_boundary',
          entityId: header.id,
          diff: { subsidiaryId: before.subsidiaryId, before: declarationOf(before), after: null },
        },
        tx,
      );
      return this.versionIn(tx, header.id, organisationId, user);
    });
  }

  /**
   * Confirms and freezes a version in one step (E3). Refused when it is
   * already confirmed (`boundary_frozen`), froze unconfirmed in a capture
   * (`boundary_confirm_requires_copy` — copy it, confirm the copy), or
   * declares no subsidiary or has any boundary gap (`boundary_incomplete`).
   */
  async confirm(user: RequestUser, id: string): Promise<InventoryBoundaryVersionDTO> {
    const organisationId = this.writerOrganisation(user);
    return this.write('confirm', id, async (tx) => {
      const header = await this.lockVersion(tx, id, organisationId);
      if (header.decision === 'confirmed') throw new BoundaryFrozenError();
      if (header.frozenAt !== null) throw new BoundaryConfirmRequiresCopyError();
      const boundary = buildBoundarySnapshot(await readBoundaryRows(tx, header));
      if (boundary.subsidiaryIds.length === 0 || boundaryGaps(boundary).length > 0) throw new BoundaryIncompleteError();
      const now = new Date();
      // The guard stamps both with the database's clock as the freeze runs,
      // and copies the names into the version (W7).
      const confirmed = await tx.inventoryBoundary.update({
        where: { id: header.id },
        data: { decision: 'confirmed', decidedBy: user.id, decidedAt: now, frozenAt: now },
      });
      await this.audit.record(
        user,
        {
          action: 'confirm',
          entity: 'inventory_boundary',
          entityId: header.id,
          diff: {
            reportingYear: confirmed.reportingYear,
            version: confirmed.version,
            decidedAt: confirmed.decidedAt?.toISOString() ?? null,
            frozenAt: confirmed.frozenAt?.toISOString() ?? null,
          },
        },
        tx,
      );
      return this.versionIn(tx, header.id, organisationId, user);
    });
  }

  /** Deletes an open version; its number is free again (E4). */
  async remove(user: RequestUser, id: string): Promise<void> {
    const organisationId = this.writerOrganisation(user);
    await this.write('delete', id, async (tx) => {
      const header = await this.lockOpen(tx, id, organisationId);
      const declared = await tx.inventoryBoundarySubsidiary.findMany({
        where: { boundaryId: header.id },
        select: { subsidiaryId: true },
        orderBy: { subsidiaryId: 'asc' },
      });
      await tx.inventoryBoundary.delete({ where: { id: header.id } });
      await this.audit.record(
        user,
        {
          action: 'delete',
          entity: 'inventory_boundary',
          entityId: header.id,
          diff: { before: { ...versionSummary(header), subsidiaryIds: declared.map((d) => d.subsidiaryId) } },
        },
        tx,
      );
    });
  }

  /** The organisation a super_admin writes in; anyone else is refused before
   * anything is read (E2). */
  private writerOrganisation(user: RequestUser): string {
    if (user.role !== 'super_admin') throw new ForbiddenException('Only super_admin may change an inventory boundary');
    if (!user.organisationId) throw new ForbiddenException('No organisation context for this user');
    return user.organisationId;
  }

  /** The version's header, locked FOR UPDATE — or boundary_not_found. */
  private async lockVersion(tx: Tx, id: string, organisationId: string): Promise<InventoryBoundary> {
    if (!(await lockBoundaryHeader(tx, id, organisationId, 'update'))) throw new ResourceNotFoundError('boundary_not_found');
    return tx.inventoryBoundary.findUniqueOrThrow({ where: { id } });
  }

  /** As `lockVersion`, refusing a frozen version (W10). */
  private async lockOpen(tx: Tx, id: string, organisationId: string): Promise<InventoryBoundary> {
    const header = await this.lockVersion(tx, id, organisationId);
    if (header.frozenAt !== null) throw new BoundaryFrozenError();
    return header;
  }

  /** The version as its writer now reads it, in the write's own transaction. */
  private async versionIn(tx: Tx, id: string, organisationId: string, user: RequestUser): Promise<InventoryBoundaryVersionDTO> {
    const loaded = await loadBoundaryVersion(tx, id, organisationId);
    if (loaded === null) throw new Error(`inventory boundary ${id} vanished inside its own write`);
    return versionDTO(loaded, user);
  }

  private async write<T>(
    operation: string,
    boundaryId: string | null,
    work: (tx: Tx) => Promise<T>,
    lostRace: (e: unknown) => boolean = () => false,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(work, WRITE_TX);
    } catch (e) {
      if (boundaryGuardRefused(e)) {
        // E7: every rule the guard holds was checked above — this is a defect.
        this.logger.error(
          `The inventory boundary guard refused a ${operation} the service had checked (version ${boundaryId ?? 'new'})`,
        );
        throw e;
      }
      if (lostRace(e)) throw new ConflictException(LOST_RACE_MESSAGE);
      throw e;
    }
  }
}

/** A version's rows, in the order their keys need. */
async function insertVersionRows(tx: Tx, rows: VersionRows): Promise<void> {
  if (rows.subsidiaries.length) await tx.inventoryBoundarySubsidiary.createMany({ data: [...rows.subsidiaries] });
  if (rows.sites.length) await tx.inventoryBoundarySite.createMany({ data: [...rows.sites] });
  if (rows.policies.length) await tx.inventoryAttributionPolicy.createMany({ data: [...rows.policies] });
  if (rows.cells.length) await tx.inventoryApplicabilityCell.createMany({ data: [...rows.cells] });
  if (rows.sources.length) await tx.inventorySource.createMany({ data: [...rows.sources] });
}

/** One subsidiary's declaration, in the order its keys need. */
async function insertDeclaration(tx: Tx, rows: DeclarationRows): Promise<void> {
  await tx.inventoryBoundarySubsidiary.create({ data: rows.subsidiary });
  if (rows.sites.length) await tx.inventoryBoundarySite.createMany({ data: rows.sites });
  if (rows.policies.length) await tx.inventoryAttributionPolicy.createMany({ data: rows.policies });
  if (rows.cells.length) await tx.inventoryApplicabilityCell.createMany({ data: rows.cells });
  if (rows.sources.length) await tx.inventorySource.createMany({ data: rows.sources });
}
