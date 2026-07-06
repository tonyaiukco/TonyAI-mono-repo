import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ActivityRecordStatus,
  Prisma,
  type ActivityRecord,
  type Evidence,
} from '@tonyai/db';
import {
  EVIDENCE_ALLOWED_MIME_TYPES,
  EVIDENCE_MAX_SIZE_BYTES,
  type EvidenceDTO,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { RequestUser } from '../auth/auth.types';

export const EVIDENCE_BUCKET = 'evidence';
const SIGNED_URL_TTL_SECONDS = 60;

// Mirrors activity-records: who may attach/remove evidence, and while the parent
// record is still editable (evidence is frozen once a record is committed).
const WRITE_ROLES = new Set(['data_entry', 'consultant', 'super_admin']);
const EDITABLE_STATUSES = new Set<ActivityRecordStatus>([
  ActivityRecordStatus.draft,
  ActivityRecordStatus.rejected,
]);

@Injectable()
export class EvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  private toDTO(e: Evidence): EvidenceDTO {
    return {
      id: e.id,
      activityRecordId: e.activityRecordId,
      fileName: e.fileName,
      mimeType: e.mimeType,
      sizeBytes: e.sizeBytes,
      uploadedBy: e.uploadedBy,
      createdAt: e.createdAt.toISOString(),
    };
  }

  /** Load an activity record and enforce tenant isolation (out-of-set → 404). */
  private async loadRecordScoped(
    user: RequestUser,
    recordId: string,
  ): Promise<ActivityRecord> {
    const record = await this.prisma.activityRecord.findUnique({
      where: { id: recordId },
    });
    if (!record || !user.accessibleSubsidiaryIds.includes(record.subsidiaryId)) {
      throw new NotFoundException('Activity record not found');
    }
    return record;
  }

  /** Author-or-super_admin gate on a still-editable record (mirrors activity-records). */
  private assertCanMutate(user: RequestUser, record: ActivityRecord): void {
    if (!WRITE_ROLES.has(user.role)) {
      throw new ForbiddenException('Your role may not modify evidence');
    }
    if (user.role !== 'super_admin' && record.createdBy !== user.id) {
      throw new ForbiddenException(
        'You may only modify evidence on records you created',
      );
    }
    if (!EDITABLE_STATUSES.has(record.status)) {
      throw new BadRequestException(
        `Cannot modify evidence on a record in status "${record.status}"`,
      );
    }
  }

  async list(user: RequestUser, recordId: string): Promise<EvidenceDTO[]> {
    await this.loadRecordScoped(user, recordId);
    const rows = await this.prisma.evidence.findMany({
      where: { activityRecordId: recordId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((e) => this.toDTO(e));
  }

  async upload(
    user: RequestUser,
    recordId: string,
    file: Express.Multer.File,
  ): Promise<EvidenceDTO> {
    const record = await this.loadRecordScoped(user, recordId);
    this.assertCanMutate(user, record);

    if (!file) throw new BadRequestException('No file provided');
    if (!(EVIDENCE_ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed: PDF, JPG, PNG, XLSX, CSV.`,
      );
    }
    if (file.size > EVIDENCE_MAX_SIZE_BYTES) {
      throw new BadRequestException('File exceeds the 10 MB limit');
    }

    // Deterministic-ish object key: <recordId>/<uuid>-<sanitised name>.
    const safeName = file.originalname.replace(/[^\w.\-]+/g, '_').slice(0, 120);
    const storagePath = `${recordId}/${randomUUID()}-${safeName}`;
    await this.storage.upload(
      EVIDENCE_BUCKET,
      storagePath,
      file.buffer,
      file.mimetype,
    );

    const created = await this.prisma.evidence.create({
      data: {
        activityRecordId: recordId,
        storagePath,
        fileName: file.originalname.slice(0, 255),
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedBy: user.id,
      },
    });
    await this.audit(user.id, 'create', created.id, {
      after: { ...this.toDTO(created), recordId },
    });
    return this.toDTO(created);
  }

  /** Load evidence + enforce read access via its parent record's tenant scope. */
  private async loadEvidenceScoped(
    user: RequestUser,
    id: string,
  ): Promise<{ evidence: Evidence; record: ActivityRecord }> {
    const evidence = await this.prisma.evidence.findUnique({ where: { id } });
    if (!evidence) throw new NotFoundException('Evidence not found');
    const record = await this.loadRecordScoped(user, evidence.activityRecordId);
    return { evidence, record };
  }

  async signedUrl(
    user: RequestUser,
    id: string,
  ): Promise<{ url: string; expiresIn: number }> {
    const { evidence } = await this.loadEvidenceScoped(user, id);
    const url = await this.storage.createSignedUrl(
      EVIDENCE_BUCKET,
      evidence.storagePath,
      SIGNED_URL_TTL_SECONDS,
    );
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }

  async remove(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const { evidence, record } = await this.loadEvidenceScoped(user, id);
    this.assertCanMutate(user, record);
    await this.storage.remove(EVIDENCE_BUCKET, [evidence.storagePath]);
    await this.prisma.evidence.delete({ where: { id } });
    await this.audit(user.id, 'delete', id, {
      before: this.toDTO(evidence),
    });
    return { id, deleted: true };
  }

  private async audit(
    userId: string,
    action: 'create' | 'delete',
    entityId: string,
    diff: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        userId,
        action,
        entity: 'evidence',
        entityId,
        diff: diff as Prisma.InputJsonValue,
      },
    });
  }
}
