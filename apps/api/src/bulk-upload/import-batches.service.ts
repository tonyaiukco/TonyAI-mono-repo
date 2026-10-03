import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ImportBatch } from '@tonyai/db';
import {
  mayAuthorRecords,
  type BulkSubmitReportDTO,
  type EvidenceUrlDTO,
  type ImportBatchDetailDTO,
  type ImportBatchDTO,
  type ImportBatchRecordRef,
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { actorDisplayName, resolveProfiles } from '../common/resolve-profiles';
import { evidenceReadyWhere } from '../activity-records/activity-records.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageObjectMissingError, StorageService } from '../storage/storage.service';
import { IMPORT_SOURCES_BUCKET } from '../storage/buckets';
import { captureException } from '../observability/sentry';
import { BulkSubmitService } from './bulk-submit.service';

const DEFAULT_LIST_LIMIT = 20;
/** Seconds a source-file download link stays valid — the evidence module's. */
const SIGNED_URL_TTL_SECONDS = 60;
/** Roles that read every batch of their organisation, as they read its records. */
const ORGANISATION_READERS = new Set(['super_admin', 'consultant', 'executive_viewer']);

/**
 * Applied bulk imports: list, read, download the source file, submit the
 * drafts one produced. The rule for who may see a batch is the RLS policy's
 * (`import_batches_select_scoped`), applied here because the API reads as the
 * owner role, which bypasses RLS:
 *
 *   - super_admin, consultant, executive_viewer: every batch of their
 *     organisation;
 *   - data_entry: a batch THEY uploaded, and only while they can still reach
 *     every subsidiary it names — the source file holds every row, refused
 *     ones included, so reading it requires reaching all of them.
 *
 * A batch the caller cannot see is a 404, never a 403: no existence oracle.
 */
@Injectable()
export class ImportBatchesService {
  private readonly logger = new Logger(ImportBatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly bulkSubmit: BulkSubmitService,
  ) {}

  async list(user: RequestUser, limit = DEFAULT_LIST_LIMIT): Promise<ImportBatchDTO[]> {
    if (!user.organisationId) return [];
    const organisationReader = ORGANISATION_READERS.has(user.role);
    const rows = await this.prisma.importBatch.findMany({
      where: {
        organisationId: user.organisationId,
        ...(organisationReader ? {} : { uploadedBy: user.id }),
      },
      orderBy: { createdAt: 'desc' },
      // A data_entry reader's own batches are filtered by subsidiary below, so
      // read a margin past the limit; the list is a recent-activity view.
      take: organisationReader ? limit : limit * 4,
    });
    const visible = rows.filter((b) => this.canSee(user, b)).slice(0, limit);
    return this.toDtos(user, visible);
  }

  async detail(user: RequestUser, id: string): Promise<ImportBatchDetailDTO> {
    const batch = await this.visibleBatch(user, id);
    const [dto] = await this.toDtos(user, [batch]);
    const records = await this.prisma.activityRecord.findMany({
      // Tenant-filtered like every record read: a consultant sees them all,
      // and a data_entry reader who can see the batch can reach every one.
      where: { importBatchId: id, subsidiaryId: { in: user.accessibleSubsidiaryIds } },
      orderBy: [{ reportingYear: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        status: true,
        subsidiaryId: true,
        locationId: true,
        reportingYear: true,
        reportingPeriod: true,
        periodValue: true,
        category: true,
        createdBy: true,
      },
    });
    return { ...dto, records: records as ImportBatchRecordRef[] };
  }

  async sourceUrl(user: RequestUser, id: string): Promise<EvidenceUrlDTO> {
    const batch = await this.visibleBatch(user, id);
    if (!batch.storagePath) {
      throw new NotFoundException('This import has no source file.');
    }
    let url: string;
    try {
      url = await this.storage.createSignedUrl(
        IMPORT_SOURCES_BUCKET,
        batch.storagePath,
        SIGNED_URL_TTL_SECONDS,
        batch.fileName,
      );
    } catch (error) {
      if (!(error instanceof StorageObjectMissingError)) throw error;
      // The row says the file was kept and Storage has no bytes: an integrity
      // incident, reported — `storage:reconcile` lists every such row.
      this.logger.error(
        `Import batch ${batch.id} has no source object in Storage (${IMPORT_SOURCES_BUCKET}/${batch.storagePath})`,
      );
      captureException(error, { userId: user.id });
      throw new NotFoundException(
        "This import's source file is missing from storage. The problem has been reported to the administrators.",
      );
    }
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }

  /**
   * Send for review every draft of this batch the caller authored — a
   * super_admin too, since only the author submits (decision D02). The ids are
   * handed to the ordinary bulk submit,
   * whose pre-flight re-checks role, author, status and tenant for each — the
   * batch only names them. A role that may not submit is refused there, with
   * its audit row, before anything is looked up.
   */
  async submit(user: RequestUser, id: string): Promise<BulkSubmitReportDTO> {
    if (!mayAuthorRecords(user)) {
      // Refused before the batch is looked up, so the refusal says nothing
      // about whether it exists. The id on the audit row is therefore the
      // caller's (uuid-shaped, by the route pipe), not a verified batch.
      return this.bulkSubmit.submitIds(user, [], { batchId: id });
    }
    await this.visibleBatch(user, id);
    // Only drafts that are not waiting for an evidence file: the button said
    // how many would go, and sending the others would only report them back.
    const drafts = await this.prisma.activityRecord.findMany({
      where: { ...this.submittableWhere(user, [id]), ...evidenceReadyWhere() },
      select: { id: true },
    });
    return this.bulkSubmit.submitIds(
      user,
      drafts.map((d) => d.id),
      { batchId: id },
    );
  }

  // -- helpers -----------------------------------------------------------------

  private async visibleBatch(user: RequestUser, id: string): Promise<ImportBatch> {
    const batch = await this.prisma.importBatch.findUnique({ where: { id } });
    if (!batch || !this.canSee(user, batch)) {
      throw new NotFoundException('Import not found');
    }
    return batch;
  }

  private canSee(user: RequestUser, batch: ImportBatch): boolean {
    if (!user.organisationId || batch.organisationId !== user.organisationId) return false;
    if (ORGANISATION_READERS.has(user.role)) return true;
    const accessible = new Set(user.accessibleSubsidiaryIds);
    return (
      batch.uploadedBy === user.id &&
      // `subsidiary_ids` is a nullable column (Prisma cannot mark a list NOT
      // NULL); the API always writes it, and a null reads as "names nothing",
      // which no data_entry reader may see — the RLS policy's rule.
      (batch.subsidiaryIds ?? []).length > 0 &&
      (batch.subsidiaryIds ?? []).every((sid) => accessible.has(sid))
    );
  }

  /**
   * Drafts the caller could send for review now: their own, whatever the role
   * — only the author submits (decision D02), so counting a colleague's drafts
   * would offer a "Send N" whose N the submit then refuses as `not_author`.
   */
  private submittableWhere(user: RequestUser, batchIds: string[]) {
    return {
      importBatchId: { in: batchIds },
      status: 'draft' as const,
      subsidiaryId: { in: user.accessibleSubsidiaryIds },
      createdBy: user.id,
    };
  }

  private async toDtos(user: RequestUser, batches: ImportBatch[]): Promise<ImportBatchDTO[]> {
    if (batches.length === 0) return [];
    const ids = batches.map((b) => b.id);
    const actors = await resolveProfiles(this.prisma, batches.map((b) => b.uploadedBy));
    const draftCount = new Map<string, number>();
    const readyCount = new Map<string, number>();
    if (mayAuthorRecords(user)) {
      const [drafts, ready] = await Promise.all([
        this.prisma.activityRecord.groupBy({
          by: ['importBatchId'],
          where: this.submittableWhere(user, ids),
          _count: { _all: true },
        }),
        this.prisma.activityRecord.groupBy({
          by: ['importBatchId'],
          where: { ...this.submittableWhere(user, ids), ...evidenceReadyWhere() },
          _count: { _all: true },
        }),
      ]);
      for (const d of drafts) {
        if (d.importBatchId) draftCount.set(d.importBatchId, d._count._all);
      }
      for (const d of ready) {
        if (d.importBatchId) readyCount.set(d.importBatchId, d._count._all);
      }
    }
    return batches.map((b) => ({
      id: b.id,
      fileName: b.fileName,
      fileFormat: b.fileFormat === 'xlsx' ? 'xlsx' : 'csv',
      sizeBytes: b.sizeBytes,
      sha256: b.sha256,
      status: b.status,
      totalRows: b.totalRows,
      acceptedCount: b.acceptedCount,
      rejectedCount: b.rejectedCount,
      subsidiaryIds: b.subsidiaryIds ?? [],
      uploadedBy: b.uploadedBy,
      uploadedByName: actorDisplayName(b.uploadedBy, actors),
      hasSourceFile: b.storagePath !== null,
      draftCount: draftCount.get(b.id) ?? 0,
      submittableDraftCount: readyCount.get(b.id) ?? 0,
      createdAt: b.createdAt.toISOString(),
      completedAt: b.completedAt ? b.completedAt.toISOString() : null,
    }));
  }
}
