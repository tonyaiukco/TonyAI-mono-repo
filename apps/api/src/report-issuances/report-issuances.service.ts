import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@tonyai/db';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type InventoryBoundarySnapshot,
  type Locale,
  type ReportIssuance,
  type ReportIssuanceGapCode,
  type UserRole,
} from '@tonyai/shared-types';
import { LIFECYCLE_TX } from '../activity-records/lifecycle-lock';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { errorBody, QueryTooBroadError, ResourceNotFoundError } from '../common/api-error';
import { CaptureSnapshot } from '../common/capture-snapshot';
import { readRuntimeConfig } from '../common/runtime-config';
import { readInventoryBoundary } from '../inventory-boundary/boundary-reader';
import { captureException } from '../observability/sentry';
import { PrismaService } from '../prisma/prisma.service';
import { readableBy } from '../report-datasets/dataset-store';
import { PdfRenderer } from '../common/pdf-renderer';
import { REPORT_ARTIFACTS_BUCKET } from '../storage/buckets';
import { StorageIntentsService, type ObjectRef } from '../storage/storage-intents.service';
import { StorageObjectMissingError, StorageService } from '../storage/storage.service';
import type { IssueReportDto } from './dto/issue-report.dto';
import { boundaryMatchesVersion, deriveIssuance, readRetainedDataset, RetainedDatasetError } from './issuance-gate';
import { buildIssuanceHtml, ISSUANCE_RENDERER } from './issuance-html';
import { readIssuanceRows, toIssuance, type IssuanceRow } from './issuance-store';

/**
 * LP3-04 PR D — the issuance (README "The issuance"; Decisions 2026-10-21):
 * a retained dataset issued as a PDF whose exact bytes are retained.
 *
 *  1. READ, in one REPEATABLE READ snapshot (`CaptureSnapshot`): the retained
 *     dataset under the read rule (organisation, then every subsidiary it
 *     references in the caller's CURRENT access — no bypass for the issuer;
 *     otherwise not found), the issuer's language (D16), a repeat of this
 *     issuance (`report_already_issued`), and the frozen version rebuilt from
 *     its stored rows.
 *  2. VERIFY and DERIVE, outside any transaction (`issuance-gate.ts`): the
 *     text held to its row, its fingerprint and its own assessments (K2), its
 *     boundary to the version (PR C follow-up (9)) — a mismatch is a defect,
 *     an internal error —, then status and gaps (D13, K4). A final is
 *     super_admin's (W4: `report_final_forbidden`).
 *  3. RENDER on the replica's one Chromium (`PdfRenderer`), no transaction open.
 *  4. RETAIN, recoverably (LP1-02): `beginUpload` → upload (never upsert) →
 *     the bytes read back and hashed — the contract's fingerprint is of the
 *     STORED bytes — → one transaction: `adoptUpload` FIRST, the row (its
 *     guard, TA017, binds it to the dataset), its audit row. Any failure
 *     abandons the upload, so no object outlives a refused issuance.
 *
 * Nothing is recalculated and no factor is read (V4): every figure is the
 * retained dataset's. A download re-hashes the retained bytes and never
 * renders again.
 */

/** Who issues (W4): super_admin and consultant — a partial. */
export const ISSUE_ROLES: ReadonlySet<UserRole> = new Set(['super_admin', 'consultant']);
/** Who issues a final (W4). */
export const FINAL_ROLES: ReadonlySet<UserRole> = new Set(['super_admin']);
/** Who reads an issuance and its PDF (W3): not data_entry. */
export const ISSUANCE_READ_ROLES: ReadonlySet<UserRole> = new Set(['super_admin', 'consultant', 'executive_viewer']);

const SNAPSHOT_TX = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 };

const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** `report_already_issued` (409): one issuance per dataset, language, template and options. */
export class ReportAlreadyIssuedError extends ConflictException {
  constructor() {
    super(errorBody('report_already_issued', 'This dataset is already issued in this language, template and options. Download its PDF instead.'));
  }
}

/** `report_final_forbidden` (403, W4): the dataset qualifies as final, and a final is super_admin's. */
export class ReportFinalForbiddenError extends ForbiddenException {
  constructor() {
    super(errorBody('report_final_forbidden', 'This dataset qualifies as a final report, and only a super_admin issues a final report.'));
  }
}

/**
 * Did the issuances' guard refuse this insert (SQLSTATE TA017)? Every rule it
 * holds is the gate's own first, so one that arrives is a defect — logged and
 * answered as an internal error (as `datasetGuardRefused` reads TA016).
 */
export function issuanceGuardRefused(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2010') {
    return (e.meta as { code?: unknown } | undefined)?.code === 'TA017';
  }
  return e instanceof Prisma.PrismaClientUnknownRequestError && /PostgresError \{ code: "TA017"/.test(e.message);
}

/** A unique violation of the one-issuance key (dataset, language, template, options). */
function repeatedIssuance(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  const named = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return /dataset/i.test(named);
}

interface IssuanceRead {
  row: {
    id: string;
    organisationId: string;
    boundaryId: string;
    reportingYear: number;
    schemaVersion: number;
    canonicalization: string;
    fingerprintHex: string;
    referencedSubsidiaryIds: string[];
    content: string;
  };
  language: Locale;
  frozen: boolean;
  rebuilt: InventoryBoundarySnapshot | null;
}

@Injectable()
export class ReportIssuancesService {
  private readonly logger = new Logger(ReportIssuancesService.name);
  private readonly limits = readRuntimeConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pdf: PdfRenderer,
    private readonly storage: StorageService,
    private readonly intents: StorageIntentsService,
  ) {}

  async issue(user: RequestUser, dto: IssueReportDto): Promise<ReportIssuance> {
    if (!ISSUE_ROLES.has(user.role)) throw new ForbiddenException('Only super_admin or consultant may issue a report');
    const organisationId = user.organisationId;
    if (!organisationId) throw new ResourceNotFoundError('report_dataset_not_found');
    const options = {
      includeMethodologyNotes: dto.includeMethodologyNotes ?? false,
      includeEvidenceSummary: dto.includeEvidenceSummary ?? false,
    };

    // 1. Read, in one snapshot.
    const read = await this.prisma.$transaction(async (tx): Promise<IssuanceRead> => {
      const row = await tx.reportDataset.findFirst({
        where: { id: dto.datasetId, organisationId },
        select: {
          id: true, organisationId: true, boundaryId: true, reportingYear: true, schemaVersion: true,
          canonicalization: true, fingerprintHex: true, referencedSubsidiaryIds: true, content: true,
        },
      });
      if (row === null || !readableBy(row.referencedSubsidiaryIds, user.accessibleSubsidiaryIds)) {
        throw new ResourceNotFoundError('report_dataset_not_found');
      }
      const language = dto.language ?? await this.languageOf(tx, user.id);
      const repeat = await tx.reportIssuance.findFirst({
        where: { datasetId: row.id, organisationId, language, template: dto.template, ...options },
        select: { id: true },
      });
      if (repeat !== null) throw new ReportAlreadyIssuedError();
      const snapshot = await CaptureSnapshot.open(tx);
      const header = await tx.inventoryBoundary.findFirst({
        where: { id: row.boundaryId, organisationId },
        select: { frozenAt: true },
      });
      const rebuilt = await readInventoryBoundary(snapshot, {
        boundaryId: row.boundaryId, organisationId, accessibleSubsidiaryIds: user.accessibleSubsidiaryIds,
      });
      return { row, language, frozen: header?.frozenAt != null, rebuilt };
    }, SNAPSHOT_TX);

    // 2. Verify and derive, from the retained dataset alone.
    let dataset: ReturnType<typeof readRetainedDataset>;
    try {
      dataset = readRetainedDataset(read.row);
      if (!read.frozen || !boundaryMatchesVersion(dataset.schemaVersion, dataset.boundary, read.rebuilt)) {
        throw new RetainedDatasetError(read.row.id, 'its boundary is not its frozen version as stored');
      }
    } catch (e) {
      if (!(e instanceof RetainedDatasetError)) throw e;
      this.logger.error(e.message);
      throw new Error('The report dataset could not be issued.', { cause: e });
    }
    const derived = deriveIssuance(dataset);
    if (derived.status === 'final' && !FINAL_ROLES.has(user.role)) throw new ReportFinalForbiddenError();

    // 3. Render — no transaction open.
    const issuanceId = randomUUID();
    const artifactId = randomUUID();
    const html = buildIssuanceHtml({
      issuanceId, dataset, status: derived.status, gaps: derived.gaps,
      language: read.language, template: dto.template, options,
    });
    if (Buffer.byteLength(html, 'utf8') > this.limits.REPORT_MAX_BYTES) throw new QueryTooBroadError();
    const { bytes, engine } = await this.pdf.render(html);
    const sha256 = sha256Of(bytes);
    const rendererVersion = `${ISSUANCE_RENDERER} (${engine})`;

    // 4. Retain the bytes, then the row — recoverably.
    const storagePath = `${organisationId}/${artifactId}.pdf`;
    const ref: ObjectRef = { bucket: REPORT_ARTIFACTS_BUCKET, path: storagePath };
    const origin = { organisationId };
    const intentId = await this.intents.beginUpload(ref, { reason: 'report_issuance.upload', ...origin });
    try {
      await this.storage.upload(REPORT_ARTIFACTS_BUCKET, storagePath, bytes, 'application/pdf');
      // The contract's fingerprint is of the STORED bytes.
      const stored = await this.storage.download(REPORT_ARTIFACTS_BUCKET, storagePath);
      if (stored.length !== bytes.length || sha256Of(stored) !== sha256) {
        throw new Error(`Report issuance ${issuanceId}: the stored PDF is not the rendered one.`);
      }
    } catch (error) {
      await this.intents.abandonUpload(intentId, ref, error, origin);
      throw error;
    }

    let issuedAt: Date;
    try {
      issuedAt = await this.prisma.$transaction(async (tx) => {
        // The row takes the object over FIRST — refused if the sweeper
        // abandoned it during a slow render or upload — so whatever fails
        // after this rolls the adoption back and leaves the intent to abandon.
        await this.intents.adoptUpload(tx, intentId);
        const created = await tx.reportIssuance.create({
          data: {
            id: issuanceId,
            organisationId,
            datasetId: dataset.datasetId,
            reportingYear: dataset.context.year,
            canonicalization: dataset.fingerprint.canonicalization,
            datasetFingerprintHex: dataset.fingerprint.hex,
            status: derived.status,
            gaps: derived.gaps as unknown as Prisma.InputJsonArray,
            language: read.language,
            template: dto.template,
            ...options,
            rendererVersion,
            artifactId,
            storagePath,
            sizeBytes: bytes.length,
            sha256,
            referencedSubsidiaryIds: [...read.row.referencedSubsidiaryIds],
            issuedBy: user.id,
          },
          select: { issuedAt: true },
        });
        await this.audit.record(
          user,
          {
            action: 'issue',
            entity: 'report_issuance',
            entityId: issuanceId,
            diff: {
              datasetId: dataset.datasetId,
              datasetFingerprint: dataset.fingerprint.hex,
              boundaryId: dataset.boundary.id,
              boundaryVersion: dataset.boundary.version,
              selection: dataset.selection,
              status: derived.status,
              gaps: gapCounts(derived.gaps),
              language: read.language,
              template: dto.template,
              options,
              rendererVersion,
              pdf: { artifactId, sha256, sizeBytes: bytes.length },
            },
          },
          tx,
        );
        return created.issuedAt;
      }, LIFECYCLE_TX);
    } catch (error) {
      await this.intents.abandonUpload(intentId, ref, error, origin);
      if (repeatedIssuance(error)) throw new ReportAlreadyIssuedError();
      if (issuanceGuardRefused(error)) {
        this.logger.error(`report issuance guard refused issuance ${issuanceId} of ${dataset.datasetId}: ${(error as Error).message}`);
        throw new Error('The report could not be issued.', { cause: error });
      }
      throw error;
    }

    const base = {
      id: issuanceId,
      organisation_id: organisationId,
      dataset_id: dataset.datasetId,
      reporting_year: dataset.context.year,
      canonicalization: dataset.fingerprint.canonicalization,
      dataset_fingerprint_hex: dataset.fingerprint.hex,
      status: derived.status,
      gaps: [...derived.gaps],
      language: read.language,
      template: dto.template,
      include_methodology_notes: options.includeMethodologyNotes,
      include_evidence_summary: options.includeEvidenceSummary,
      renderer_version: rendererVersion,
      artifact_id: artifactId,
      storage_path: storagePath,
      size_bytes: bytes.length,
      sha256,
      issued_by: user.id,
      issued_at: issuedAt.toISOString(),
    } satisfies IssuanceRow;
    return toIssuance(base);
  }

  /** A year's issuances the caller may read, newest first. */
  async list(user: RequestUser, year: number): Promise<ReportIssuance[]> {
    if (!ISSUANCE_READ_ROLES.has(user.role)) throw new ForbiddenException('data_entry users do not read report issuances');
    if (!user.organisationId) return [];
    const rows = await readIssuanceRows(this.prisma, user.organisationId, user.accessibleSubsidiaryIds, { year });
    return rows.map(toIssuance);
  }

  /** One issuance's metadata. */
  async get(user: RequestUser, id: string): Promise<ReportIssuance> {
    return toIssuance(await this.readable(user, id));
  }

  /**
   * The retained PDF, exactly as issued: re-hashed against the issuance before
   * it is served — bytes that differ are never sent (an internal error,
   * reported) — and never rendered again. Bytes that are gone answer
   * `report_artifact_missing`, reported to operators.
   */
  async pdfOf(user: RequestUser, id: string): Promise<{ bytes: Buffer; filename: string }> {
    const row = await this.readable(user, id);
    let bytes: Buffer;
    try {
      bytes = await this.storage.download(REPORT_ARTIFACTS_BUCKET, row.storage_path);
    } catch (error) {
      if (!(error instanceof StorageObjectMissingError)) throw error;
      // Ids only: `storage:reconcile` lists every such row with its key.
      this.logger.error(`Report issuance ${row.id} has no object in Storage`);
      captureException(new Error(`Report issuance ${row.id} has no object in Storage`), { userId: user.id });
      throw new NotFoundException(errorBody(
        'report_artifact_missing',
        "This report's PDF is missing from storage. The problem has been reported to the administrators.",
      ));
    }
    if (bytes.length !== row.size_bytes || sha256Of(bytes) !== row.sha256) {
      throw new Error(`Report issuance ${row.id}: the stored PDF does not hash to the issuance's SHA-256.`);
    }
    return { bytes, filename: `tonyai-report-${row.reporting_year}-${row.template}-${row.language}-${row.status}.pdf` };
  }

  private async readable(user: RequestUser, id: string): Promise<IssuanceRow> {
    if (!ISSUANCE_READ_ROLES.has(user.role)) throw new ForbiddenException('data_entry users do not read report issuances');
    if (!user.organisationId) throw new ResourceNotFoundError('report_issuance_not_found');
    const [row] = await readIssuanceRows(this.prisma, user.organisationId, user.accessibleSubsidiaryIds, { id });
    if (row === undefined) throw new ResourceNotFoundError('report_issuance_not_found');
    return row;
  }

  /** D16: the issuer's own language, else the product's default. */
  private async languageOf(tx: Prisma.TransactionClient, userId: string): Promise<Locale> {
    const profile = await tx.profile.findUnique({ where: { id: userId }, select: { language: true } });
    const language = profile?.language;
    return (SUPPORTED_LOCALES as readonly string[]).includes(language ?? '') ? (language as Locale) : DEFAULT_LOCALE;
  }
}

/** The audit row's summary of the gaps: how many of each code. */
function gapCounts(gaps: readonly { code: ReportIssuanceGapCode }[]): Partial<Record<ReportIssuanceGapCode, number>> {
  const counts: Partial<Record<ReportIssuanceGapCode, number>> = {};
  for (const g of gaps) counts[g.code] = (counts[g.code] ?? 0) + 1;
  return counts;
}
