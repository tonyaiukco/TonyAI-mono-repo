import { Injectable, NotFoundException } from '@nestjs/common';
import type { ImportBatch } from '@tonyai/db';
import {
  EVIDENCE_REQUIRED_CATEGORIES,
  mayAuthorRecords,
  type BulkSubmitReportDTO,
  type EvidenceUrlDTO,
  type ImportBatchDetailDTO,
  type ImportBatchDTO,
  type ImportBatchRecordRef,
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { actorDisplayName, resolveProfiles } from '../common/resolve-profiles';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { BulkSubmitService } from './bulk-submit.service';
import { IMPORT_SOURCES_BUCKET } from './bulk-upload.service';

const DEFAULT_LIST_LIMIT = 20;
/** Seconds a source-file download link stays valid — the evidence module's. */
const SIGNED_URL_TTL_SECONDS = 60;
/**
 * A draft that is not waiting for an evidence file: its category needs none,
 * or one is attached — the rule `needsEvidenceBeforeSubmit` states, as a query.
 */
const READY_FOR_SUBMIT = {
  OR: [
    { category: { notIn: EVIDENCE_REQUIRED_CATEGORIES as string[] } },
    { evidence: { some: {} } },
  ],
};

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
    const url = await this.storage.createSignedUrl(
      IMPORT_SOURCES_BUCKET,
      batch.storagePath,
      SIGNED_URL_TTL_SECONDS,
      batch.fileName,
    );
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }

  /**
   * Send for review every draft of this batch the caller authored (a
   * super_admin: every draft). The ids are handed to the ordinary bulk submit,
   * whose pre-flight re-checks role, author, status and tenant for each — the
   * batch only names them. A role that may not submit is refused there, with
   * its audit row, before anything is looked up.
   */
  async submit(user: RequestUser, id: string): Promise<BulkSubmitReportDTO> {
    if (!mayAuthorRecords(user)) {
      return this.bulkSubmit.submitIds(user, [], { batchId: id });
    }
    await this.visibleBatch(user, id);
    // Only drafts that are not waiting for an evidence file: the button said
    // how many would go, and sending the others would only report them back.
    const drafts = await this.prisma.activityRecord.findMany({
      where: { ...this.submittableWhere(user, [id]), ...READY_FOR_SUBMIT },
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
      batch.subsidiaryIds.length > 0 &&
      batch.subsidiaryIds.every((sid) => accessible.has(sid))
    );
  }

  /** Drafts the caller could send for review now: their own, or any for a super_admin. */
  private submittableWhere(user: RequestUser, batchIds: string[]) {
    return {
      importBatchId: { in: batchIds },
      status: 'draft' as const,
      subsidiaryId: { in: user.accessibleSubsidiaryIds },
      ...(user.role === 'super_admin' ? {} : { createdBy: user.id }),
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
          where: { ...this.submittableWhere(user, ids), ...READY_FOR_SUBMIT },
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
      subsidiaryIds: b.subsidiaryIds,
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
