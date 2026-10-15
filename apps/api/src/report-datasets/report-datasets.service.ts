import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@tonyai/db';
import {
  REPORT_DATASET_SCHEMA_VERSION,
  type CaptureReportDatasetRequest,
  type ReportDataset,
  type ReportDatasetSummary,
  type ReportingContext,
  type UserRole,
} from '@tonyai/shared-types';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { QueryTooBroadError, ResourceNotFoundError } from '../common/api-error';
import { CaptureSnapshot } from '../common/capture-snapshot';
import { readRuntimeConfig } from '../common/runtime-config';
import { lockBoundaryHeader } from '../inventory-boundary/boundary-lock';
import { readInventoryBoundary } from '../inventory-boundary/boundary-reader';
import { PrismaService } from '../prisma/prisma.service';
import { assessDataset, type DatasetSelection } from './dataset-assessments';
import { reportDatasetFingerprint } from './dataset-fingerprint';
import { readCaptureContext, readCaptureFacts, referencedSubsidiaryIds } from './dataset-reader';
import { datasetRow, datasetSummary, listDatasetSummaries, readableBy, readDatasetContent } from './dataset-store';

/**
 * LP3-04 PR C — the report dataset's capture (README "Inventory coverage and
 * report datasets"; Decisions 2026-10-15 (ninth), V1–V12).
 *
 * A capture runs in two transactions (W8; PR B follow-up (4a)):
 *  1. READ COMMITTED — the only isolation the boundary guard freezes in
 *     (TA014): the version's header locked FOR UPDATE; every refusal the
 *     request alone decides (organisation, access, an empty version, a
 *     consultant before an open version, an extract's subsidiary — one the
 *     version declares, in the caller's access —, a capture
 *     certain to be too broad) made BEFORE anything is frozen; then, if the
 *     version is open, it freezes it unconfirmed — conditionally
 *     (`frozenAt: null`; none changed means it was frozen already) — and
 *     audits the freeze. Committed.
 *  2. REPEATABLE READ (`CaptureSnapshot`) — the version asserted frozen, then
 *     the boundary, records, evidence, locks and releases read in one
 *     snapshot; the dataset assessed and fingerprinted; its exact text
 *     retained with its audit row, atomically.
 * A capture that fails after its freeze leaves the version frozen without a
 * dataset: a retry captures it as it stands; an unconfirmed one is confirmed
 * only as a copy.
 */

/** Who captures (W4): super_admin and consultant. Only super_admin freezes an open version (V1). */
export const CAPTURE_ROLES: ReadonlySet<UserRole> = new Set(['super_admin', 'consultant']);
/** Who reads a retained dataset (V7): not data_entry, which generates no report (W3). */
export const DATASET_READ_ROLES: ReadonlySet<UserRole> = new Set(['super_admin', 'consultant', 'executive_viewer']);

const FREEZE_TX = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 };
const SNAPSHOT_TX = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 };

/** An extract's filters from the request; none is an inventory. */
export function selectionOf(dto: CaptureReportDatasetRequest): DatasetSelection {
  return {
    ...(dto.subsidiaryId !== undefined ? { subsidiaryId: dto.subsidiaryId } : {}),
    ...(dto.scope !== undefined ? { scope: dto.scope } : {}),
    ...(dto.category !== undefined ? { category: dto.category } : {}),
  };
}

/** The scopes whose records a selection captures — Scope 1/2 only (Water and Scope 3 are outside). */
export function capturedScopes(selection: DatasetSelection): Array<1 | 2> {
  return ([1, 2] as const).filter((s) => selection.scope === undefined || selection.scope === s);
}

/**
 * Did the retained datasets' guard refuse this insert (SQLSTATE TA016)? Every
 * rule it holds is the capture's own first, so one that arrives is a defect —
 * logged and answered as an internal error. Read as `boundaryGuardRefused`
 * reads TA014: Prisma 6 reports a trigger's RAISE on a model query as an
 * unknown request error carrying the code in the engine's own framing.
 */
export function datasetGuardRefused(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2010') {
    return (e.meta as { code?: unknown } | undefined)?.code === 'TA016';
  }
  return e instanceof Prisma.PrismaClientUnknownRequestError && /PostgresError \{ code: "TA016"/.test(e.message);
}

@Injectable()
export class ReportDatasetsService {
  private readonly logger = new Logger(ReportDatasetsService.name);
  private readonly limits = readRuntimeConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async capture(user: RequestUser, dto: CaptureReportDatasetRequest): Promise<ReportDatasetSummary> {
    if (!CAPTURE_ROLES.has(user.role)) throw new ForbiddenException('Only super_admin or consultant may capture a report dataset');
    const organisationId = user.organisationId;
    if (!organisationId) throw new ForbiddenException('No organisation context for this user');
    const selection = selectionOf(dto);
    if (selection.subsidiaryId !== undefined && !user.accessibleSubsidiaryIds.includes(selection.subsidiaryId)) {
      throw new ResourceNotFoundError('subsidiary_not_found');
    }

    await this.freeze(user, organisationId, dto.boundaryId, selection);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const snapshot = await CaptureSnapshot.open(tx);
        const dataset = await this.assemble(snapshot, user, organisationId, dto.boundaryId, selection);
        const referenced = referencedSubsidiaryIds(dataset);
        // Every subsidiary it references is the capturer's to read now — the
        // rule its every reader is held to; no bypass for the capturer.
        if (!readableBy(referenced, user.accessibleSubsidiaryIds)) {
          throw new Error(`Report dataset ${dataset.datasetId} references a subsidiary outside its capturer's access.`);
        }
        const row = datasetRow(dataset, referenced, user.id);
        if (Buffer.byteLength(row.content, 'utf8') > this.limits.REPORT_MAX_BYTES) throw new QueryTooBroadError();
        await tx.reportDataset.create({ data: row });
        await this.audit.record(
          user,
          {
            action: 'capture',
            entity: 'report_dataset',
            entityId: dataset.datasetId,
            diff: {
              boundaryId: dataset.boundary.id,
              boundaryVersion: dataset.boundary.version,
              decision: dataset.boundary.decision,
              selection: dataset.selection,
              context: dataset.context,
              fingerprint: dataset.fingerprint.hex,
              records: dataset.records.length,
              evidence: dataset.evidence.length,
              gaps: dataset.coverage.gaps.length,
            },
          },
          tx,
        );
        return datasetSummary(dataset, user.id);
      }, SNAPSHOT_TX);
    } catch (e) {
      if (datasetGuardRefused(e)) {
        this.logger.error(`report dataset guard refused a capture of ${dto.boundaryId}: ${(e as Error).message}`);
        throw new Error('The report dataset could not be retained.', { cause: e });
      }
      throw e;
    }
  }

  /**
   * The capture's first transaction: every refusal the request decides, then
   * the freeze of an open version (super_admin's alone, V1), audited.
   */
  private async freeze(user: RequestUser, organisationId: string, boundaryId: string, selection: DatasetSelection): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockBoundaryHeader(tx, boundaryId, organisationId, 'update'))) {
        throw new ResourceNotFoundError('boundary_not_found');
      }
      const header = await tx.inventoryBoundary.findUniqueOrThrow({
        where: { id: boundaryId },
        select: { id: true, reportingYear: true, version: true, frozenAt: true, subsidiaries: { select: { subsidiaryId: true } } },
      });
      // W3: a version is captured whole, so every subsidiary it declares must
      // be the caller's; one declaring none is no one's.
      const access = new Set(user.accessibleSubsidiaryIds);
      const declared = header.subsidiaries.map((s) => s.subsidiaryId);
      if (declared.length === 0 || declared.some((id) => !access.has(id))) {
        throw new ResourceNotFoundError('boundary_not_found');
      }
      // An extract is of a subsidiary the version declares: of another, no
      // source is selected and every scope would read covered over nothing
      // (`architect`'s P2-1).
      if (selection.subsidiaryId !== undefined && !declared.includes(selection.subsidiaryId)) {
        throw new ResourceNotFoundError('subsidiary_not_found');
      }
      // A capture certain to be too broad — its records or their evidence
      // links — is refused before it freezes anything (the size of its text is
      // known only once it is built).
      const scopes = capturedScopes(selection);
      const selected = {
        subsidiaryId: { in: selection.subsidiaryId !== undefined ? [selection.subsidiaryId] : declared },
        reportingYear: header.reportingYear,
        scope: { in: scopes },
        ...(selection.category === undefined ? {} : { category: selection.category }),
      };
      const count = scopes.length === 0 ? 0 : await tx.activityRecord.count({ where: selected });
      if (count > this.limits.REPORT_RECORD_LIMIT) throw new QueryTooBroadError();
      const links = scopes.length === 0 ? 0 : await tx.activityRecordEvidence.count({ where: { activityRecord: selected } });
      if (links > this.limits.REPORT_EVIDENCE_LINK_LIMIT) throw new QueryTooBroadError();
      if (header.frozenAt !== null) return;
      if (user.role !== 'super_admin') {
        throw new ForbiddenException('Only super_admin may capture an open inventory boundary version; capture it once it is frozen');
      }
      // Conditional, so a retry never meets the guard: none changed means
      // another capture or a confirmation froze it first.
      const frozen = await tx.inventoryBoundary.updateMany({
        where: { id: header.id, organisationId, frozenAt: null },
        data: { frozenAt: new Date() },
      });
      if (frozen.count === 0) return;
      // The guard stamped the database's clock (W8).
      const after = await tx.inventoryBoundary.findUniqueOrThrow({ where: { id: header.id }, select: { frozenAt: true } });
      if (after.frozenAt === null) throw new Error(`Inventory boundary ${header.id} did not freeze.`);
      await this.audit.record(
        user,
        {
          action: 'freeze',
          entity: 'inventory_boundary',
          entityId: header.id,
          diff: {
            reportingYear: header.reportingYear,
            version: header.version,
            frozenAt: after.frozenAt.toISOString(),
            cause: 'capture',
          },
        },
        tx,
      );
    }, FREEZE_TX);
  }

  /** The dataset, read and assessed in the capture's snapshot. */
  private async assemble(
    snapshot: CaptureSnapshot,
    user: RequestUser,
    organisationId: string,
    boundaryId: string,
    selection: DatasetSelection,
  ): Promise<ReportDataset> {
    const db = CaptureSnapshot.txOf(snapshot);
    const at = await readCaptureContext(snapshot, organisationId, user.accessibleSubsidiaryIds);
    if (at === null) throw new ResourceNotFoundError('boundary_not_found');
    // PR B follow-up (1): the reader takes any version, so the capture
    // asserts the one it read is the one its freeze committed.
    const head = await db.inventoryBoundary.findFirst({ where: { id: boundaryId, organisationId }, select: { frozenAt: true } });
    if (head === null) throw new ResourceNotFoundError('boundary_not_found');
    if (head.frozenAt === null) throw new Error(`Inventory boundary ${boundaryId} is not frozen in the capture's snapshot.`);
    const boundary = await readInventoryBoundary(snapshot, { boundaryId, organisationId, accessibleSubsidiaryIds: at.currentAccess });
    if (boundary === null) throw new ResourceNotFoundError('boundary_not_found');
    if (selection.subsidiaryId !== undefined
      && (!at.currentAccess.includes(selection.subsidiaryId) || !boundary.subsidiaryIds.includes(selection.subsidiaryId))) {
      throw new ResourceNotFoundError('subsidiary_not_found');
    }
    // V3: an inventory is the declared boundary's subsidiaries; a subsidiary
    // extract that one alone.
    const resolvedSubsidiaryIds = selection.subsidiaryId !== undefined
      ? [selection.subsidiaryId]
      : [...boundary.subsidiaryIds].sort();
    const context: ReportingContext = { year: boundary.reportingYear, ...selection };
    const facts = await readCaptureFacts(
      snapshot,
      {
        organisationId,
        reportingYear: boundary.reportingYear,
        resolvedSubsidiaryIds,
        scopes: capturedScopes(selection),
        ...(selection.category === undefined ? {} : { category: selection.category }),
      },
      { records: this.limits.REPORT_RECORD_LIMIT, evidenceLinks: this.limits.REPORT_EVIDENCE_LINK_LIMIT },
    );
    const assessments = assessDataset({
      boundary, selection, records: facts.records, evidence: facts.evidence, releases: facts.releases,
    });
    const content: Omit<ReportDataset, 'fingerprint'> = {
      schemaVersion: REPORT_DATASET_SCHEMA_VERSION,
      datasetId: randomUUID(),
      capturedAt: at.capturedAt,
      organisationId,
      organisationName: at.organisationName,
      context,
      selection: Object.keys(selection).length === 0 ? 'inventory' : 'extract',
      resolvedSubsidiaryIds,
      boundary,
      records: facts.records,
      evidence: facts.evidence,
      periodLocks: facts.periodLocks,
      ...assessments,
    };
    return { ...content, fingerprint: reportDatasetFingerprint(content) };
  }

  /** One retained dataset's exact text — served as retained, never rebuilt. */
  async get(user: RequestUser, id: string): Promise<string> {
    if (!DATASET_READ_ROLES.has(user.role)) throw new ForbiddenException('data_entry users do not read report datasets');
    if (!user.organisationId) throw new ResourceNotFoundError('report_dataset_not_found');
    const content = await readDatasetContent(this.prisma, id, user.organisationId, user.accessibleSubsidiaryIds);
    if (content === null) throw new ResourceNotFoundError('report_dataset_not_found');
    return content;
  }

  /** A year's datasets the caller may read, newest first. */
  async list(user: RequestUser, year: number): Promise<ReportDatasetSummary[]> {
    if (!DATASET_READ_ROLES.has(user.role)) throw new ForbiddenException('data_entry users do not read report datasets');
    if (!user.organisationId) return [];
    return listDatasetSummaries(this.prisma, user.organisationId, year, user.accessibleSubsidiaryIds);
  }
}
