import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ActivityRecordStatus, Prisma, type ActivityRecord } from '@tonyai/db';
import {
  type Category,
  EVIDENCE_ALLOWED_MIME_TYPES,
  EVIDENCE_MAX_SIZE_BYTES,
  type EvidenceDTO,
  type EvidenceDetachDTO,
  type EvidenceLinkRefusal,
  type EvidenceLinkRefusedDTO,
  mayAuthorRecords,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PeriodLockedError, RecordChangedError } from '../activity-records/errors';
import {
  LIFECYCLE_TX,
  asLostRace,
  changedSince,
  lockActivityRecordRows,
  lockEvidenceRows,
  lockPeriodsShared,
  type PeriodKey,
} from '../activity-records/lifecycle-lock';
import { canonicalUuid } from '../common/parse-uuid-param.pipe';

export const EVIDENCE_BUCKET = 'evidence';
const SIGNED_URL_TTL_SECONDS = 60;

// Mirrors activity-records: who may attach/remove evidence, and while the parent
// record is still editable (evidence is frozen once a record is committed).
// Mirrors activity-records: a consultant is review-only (decision 2026-07-30).
const EDITABLE_STATUSES = new Set<ActivityRecordStatus>([
  ActivityRecordStatus.draft,
  ActivityRecordStatus.rejected,
]);

const ROLE_REFUSAL = 'Your role may not modify evidence';
const RECORD_NOT_FOUND = 'Activity record not found';
const EVIDENCE_NOT_FOUND = 'Evidence not found';

/** Every record a file backs, with what a reviewer needs to judge the link. */
const WITH_LINKED_RECORDS = {
  links: {
    orderBy: [{ linkedAt: 'asc' }, { activityRecordId: 'asc' }],
    select: {
      activityRecord: {
        select: {
          id: true,
          category: true,
          reportingYear: true,
          periodValue: true,
          status: true,
          location: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.EvidenceInclude;

type EvidenceWithLinks = Prisma.EvidenceGetPayload<{
  include: typeof WITH_LINKED_RECORDS;
}>;

/** How a record is named in a refusal — the caller picked it from a list showing exactly this. */
function recordLabel(r: ActivityRecord): string {
  return `${r.category} · ${r.periodValue} ${r.reportingYear}`;
}

function lockKey(r: PeriodKey): string {
  return [r.subsidiaryId, r.reportingYear, r.reportingPeriod, r.periodValue].join('|');
}

function periodOf(r: PeriodKey): PeriodKey {
  return {
    subsidiaryId: r.subsidiaryId,
    reportingYear: r.reportingYear,
    reportingPeriod: r.reportingPeriod,
    periodValue: r.periodValue,
  };
}

/**
 * A refusal raised against a LOCKED record (the lifecycle protocol's step 4,
 * `lifecycle-lock.ts`) that the caller's own read did not raise: the record
 * changed in between, so it is a lost race (409) — unless it is the period
 * lock, whose own sentence says what happened.
 */
function lockedRefusal(refusal: HttpException, seen: ActivityRecord | undefined, current: ActivityRecord): HttpException {
  if (refusal instanceof PeriodLockedError) return refusal;
  if (seen && !changedSince(seen, current)) return refusal;
  return new RecordChangedError();
}

/**
 * Evidence files and the records they back.
 *
 * A file belongs to a subsidiary and backs one or more of its records through
 * `activity_record_evidence` (WP8 decision 3a). What follows from that:
 *  - a file is uploaded together with every record it backs — there is no way
 *    to link an existing file later — so a file with no links never gains one
 *    again, and deleting it then is safe;
 *  - taking a file off one record (`detach`) needs only THAT record to be
 *    editable, and deletes the file only when it was the last link — so a
 *    file backing an approved record can never vanish from it through another
 *    record's screen;
 *  - deleting the file outright (`remove`) needs EVERY record it backs to be
 *    editable.
 */
@Injectable()
export class EvidenceService {
  private readonly logger = new Logger(EvidenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  private toDTO(e: EvidenceWithLinks): EvidenceDTO {
    return {
      id: e.id,
      subsidiaryId: e.subsidiaryId,
      fileName: e.fileName,
      mimeType: e.mimeType,
      sizeBytes: e.sizeBytes,
      uploadedBy: e.uploadedBy,
      createdAt: e.createdAt.toISOString(),
      linkedRecords: e.links.map(({ activityRecord: r }) => ({
        id: r.id,
        // The column is TEXT; the vocabulary is enforced on write, as
        // `ActivityRecordsService.toAuditSnapshot` relies on too.
        category: r.category as Category,
        reportingYear: r.reportingYear,
        periodValue: r.periodValue,
        locationName: r.location?.name ?? null,
        status: r.status,
      })),
    };
  }

  /** The audit trail's picture of a file: its metadata and the ids it backs, not the record details. */
  private auditSnapshot(e: EvidenceWithLinks) {
    const { linkedRecords, ...file } = this.toDTO(e);
    return { ...file, recordIds: linkedRecords.map((r) => r.id) };
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
      throw new NotFoundException(RECORD_NOT_FOUND);
    }
    return record;
  }

  /** Load a file through its own subsidiary (out-of-set → 404, the same as a missing id). */
  private async loadEvidenceScoped(
    user: RequestUser,
    id: string,
  ): Promise<EvidenceWithLinks> {
    const evidence = await this.prisma.evidence.findUnique({
      where: { id },
      include: WITH_LINKED_RECORDS,
    });
    if (!evidence || !user.accessibleSubsidiaryIds.includes(evidence.subsidiaryId)) {
      throw new NotFoundException(EVIDENCE_NOT_FOUND);
    }
    return evidence;
  }

  private assertRole(user: RequestUser): void {
    if (!mayAuthorRecords(user)) throw new ForbiddenException(ROLE_REFUSAL);
  }

  /** The ids of `records` whose reporting period is closed — one query for all of them. */
  private async lockedRecordIds(
    records: ActivityRecord[],
    client: Pick<Prisma.TransactionClient, 'periodLock'> = this.prisma,
  ): Promise<Set<string>> {
    if (records.length === 0) return new Set();
    // One condition per distinct period, not per record: a thousand drafts of
    // one import share a handful of periods.
    const periods = [...new Map(records.map((r) => [lockKey(r), r])).values()];
    const locks = await client.periodLock.findMany({
      where: {
        OR: periods.map((r) => ({
          subsidiaryId: r.subsidiaryId,
          reportingYear: r.reportingYear,
          reportingPeriod: r.reportingPeriod,
          periodValue: r.periodValue,
        })),
      },
      select: {
        subsidiaryId: true,
        reportingYear: true,
        reportingPeriod: true,
        periodValue: true,
      },
    });
    const closed = new Set(locks.map(lockKey));
    return new Set(records.filter((r) => closed.has(lockKey(r))).map((r) => r.id));
  }

  /**
   * Why this caller may not change the evidence on `record`, or null.
   *
   * Author-or-super_admin, on a still-editable record, in an open period —
   * the same three rules a record's own edit obeys. The period lock is new
   * here (WP8 PR7): until then a rejected record inside a locked period could
   * still gain or lose a file.
   */
  private refusalFor(
    user: RequestUser,
    record: ActivityRecord,
    locked: boolean,
  ): HttpException | null {
    if (user.role !== 'super_admin' && record.createdBy !== user.id) {
      return new ForbiddenException(
        'You may only modify evidence on records you created',
      );
    }
    if (!EDITABLE_STATUSES.has(record.status)) {
      return new BadRequestException(
        `Cannot modify evidence on a record in status "${record.status}"`,
      );
    }
    if (locked) {
      return new PeriodLockedError(
        `Reporting period ${record.periodValue} ${record.reportingYear} is locked — a super_admin must unlock it before its evidence can change.`,
      );
    }
    return null;
  }

  /** The single-record gate: role, then the record's own refusal as its own status. */
  private async assertCanMutate(
    user: RequestUser,
    record: ActivityRecord,
  ): Promise<void> {
    this.assertRole(user);
    const locked = await this.lockedRecordIds([record]);
    const refusal = this.refusalFor(user, record, locked.has(record.id));
    if (refusal) throw refusal;
  }

  private assertFile(file: Express.Multer.File | undefined): asserts file {
    if (!file) throw new BadRequestException('No file provided');
    if (!(EVIDENCE_ALLOWED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed: PDF, JPG, PNG, XLSX, CSV.`,
      );
    }
    if (file.size > EVIDENCE_MAX_SIZE_BYTES) {
      throw new BadRequestException('File exceeds the 10 MB limit');
    }
  }

  async list(user: RequestUser, recordId: string): Promise<EvidenceDTO[]> {
    await this.loadRecordScoped(user, recordId);
    const rows = await this.prisma.evidence.findMany({
      where: { links: { some: { activityRecordId: recordId } } },
      include: WITH_LINKED_RECORDS,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((e) => this.toDTO(e));
  }

  /** `POST /activity-records/:recordId/evidence` — one file for one record, with that record's own refusals. */
  async upload(
    user: RequestUser,
    recordId: string,
    file: Express.Multer.File,
  ): Promise<EvidenceDTO> {
    const record = await this.loadRecordScoped(user, recordId);
    await this.assertCanMutate(user, record);
    this.assertFile(file);
    return this.store(user, [record], file);
  }

  /**
   * `POST /evidence` — one file for several records of one subsidiary, all or
   * nothing.
   *
   * Every named record is checked before anything is stored, and one refused
   * record refuses the whole upload, naming each refused record and why: a
   * file that silently backed eight of the ten records the user picked would
   * leave them believing the other two were covered. A record the caller
   * cannot reach is refused with the same sentence as one that does not exist.
   */
  async uploadForRecords(
    user: RequestUser,
    recordIds: string[],
    file: Express.Multer.File,
  ): Promise<EvidenceDTO> {
    this.assertRole(user);
    const ids = [...new Set(recordIds.map((id) => canonicalUuid(id) ?? id))];
    const found = await this.prisma.activityRecord.findMany({
      where: { id: { in: ids }, subsidiaryId: { in: user.accessibleSubsidiaryIds } },
    });
    const byId = new Map(found.map((r) => [r.id, r]));

    const refused: EvidenceLinkRefusal[] = ids
      .filter((id) => !byId.has(id))
      .map((recordId) => ({ recordId, reason: RECORD_NOT_FOUND }));

    const subsidiaries = new Set(found.map((r) => r.subsidiaryId));
    if (refused.length === 0 && subsidiaries.size > 1) {
      throw new BadRequestException(
        'These records belong to more than one subsidiary. One file evidences records of one subsidiary — upload it once per subsidiary.',
      );
    }

    const locked = await this.lockedRecordIds(found);
    const labels: string[] = refused.map((r) => `${r.recordId} — ${r.reason}`);
    for (const id of ids) {
      const record = byId.get(id);
      if (!record) continue;
      const refusal = this.refusalFor(user, record, locked.has(id));
      if (!refusal) continue;
      refused.push({ recordId: id, reason: refusal.message });
      labels.push(`${recordLabel(record)} — ${refusal.message}`);
    }
    if (refused.length > 0) {
      const body: EvidenceLinkRefusedDTO = {
        message: `${refused.length} of the ${ids.length} records cannot take this file, so nothing was uploaded: ${labels.join('; ')}`,
        refused,
      };
      throw new BadRequestException(body);
    }

    this.assertFile(file);
    return this.store(user, ids.map((id) => byId.get(id)!), file);
  }

  /**
   * Upload the blob, then write the file row, its links and its audit row in
   * one transaction. The caller has already checked every record; the
   * transaction checks them again under the lifecycle protocol — their
   * periods shared, their rows locked — so a record submitted, or a period
   * locked, while the blob was uploading does not gain the file. If the rows
   * cannot be written the blob is removed again, so a failed upload leaves
   * nothing.
   */
  private async store(
    user: RequestUser,
    records: ActivityRecord[],
    file: Express.Multer.File,
  ): Promise<EvidenceDTO> {
    const subsidiaryId = records[0].subsidiaryId;
    // Opaque object key: <subsidiaryId>/<uuid>-<sanitised name>.
    //
    // `\w` is ASCII-only, so Turkish letters collapse to `_` here. That is fine
    // and deliberate: the key is opaque, never displayed, and made unique by the
    // uuid — the user's real name lives in `fileName` and now also rides on the
    // signed URL's download parameter. Transliterating instead would buy nothing
    // and risk collisions. Files uploaded before WP8 PR7 keep their
    // <recordId>/… keys; keys are matched exactly, never parsed.
    const safeName = file.originalname.replace(/[^\w.-]+/g, '_').slice(0, 120);
    const storagePath = `${subsidiaryId}/${randomUUID()}-${safeName}`;
    await this.storage.upload(
      EVIDENCE_BUCKET,
      storagePath,
      file.buffer,
      file.mimetype,
    );

    const seen = new Map(records.map((r) => [r.id, r]));
    const ids = [...seen.keys()];
    let created: EvidenceWithLinks;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await lockPeriodsShared(tx, records.map(periodOf));
        const present = await lockActivityRecordRows(tx, ids);
        if (present.size !== ids.length) throw new NotFoundException(RECORD_NOT_FOUND);
        const current = await tx.activityRecord.findMany({ where: { id: { in: ids } } });
        const locked = await this.lockedRecordIds(current, tx);
        for (const record of current) {
          if (record.subsidiaryId !== subsidiaryId) throw new RecordChangedError();
          const refusal = this.refusalFor(user, record, locked.has(record.id));
          if (refusal) throw lockedRefusal(refusal, seen.get(record.id), record);
        }
        const row = await tx.evidence.create({
          data: {
            subsidiaryId,
            storagePath,
            fileName: file.originalname.slice(0, 255),
            mimeType: file.mimetype,
            sizeBytes: file.size,
            uploadedBy: user.id,
          },
        });
        await tx.activityRecordEvidence.createMany({
          data: records.map((r) => ({
            activityRecordId: r.id,
            evidenceId: row.id,
            subsidiaryId,
            linkedBy: user.id,
          })),
        });
        const stored = await tx.evidence.findUniqueOrThrow({
          where: { id: row.id },
          include: WITH_LINKED_RECORDS,
        });
        await this.audit.record(
          user,
          {
            action: 'create',
            entity: 'evidence',
            entityId: stored.id,
            diff: { after: this.auditSnapshot(stored) },
          },
          tx,
        );
        return stored;
      }, LIFECYCLE_TX);
    } catch (error) {
      await this.removeBlobs([storagePath]);
      // A record deleted between the checks and the link: the link's foreign
      // key refuses it (P2003). That is the same answer as a record that was
      // never there, not a server error.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new NotFoundException(RECORD_NOT_FOUND);
      }
      throw asLostRace(error);
    }
    return this.toDTO(created);
  }

  async signedUrl(
    user: RequestUser,
    id: string,
  ): Promise<{ url: string; expiresIn: number }> {
    const evidence = await this.loadEvidenceScoped(user, id);
    const url = await this.storage.createSignedUrl(
      EVIDENCE_BUCKET,
      evidence.storagePath,
      SIGNED_URL_TTL_SECONDS,
      evidence.fileName,
    );
    return { url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }

  /**
   * `DELETE /activity-records/:recordId/evidence/:evidenceId` — take a file off
   * one record. Only that record has to be editable; the file's other records
   * keep it. When this was the last link the file is deleted, and the audit row
   * says `delete` rather than `detach`.
   */
  async detach(
    user: RequestUser,
    recordId: string,
    evidenceId: string,
  ): Promise<EvidenceDetachDTO> {
    const record = await this.loadRecordScoped(user, recordId);
    await this.assertCanMutate(user, record);
    const evidence = await this.prisma.evidence.findFirst({
      where: { id: evidenceId, links: { some: { activityRecordId: record.id } } },
      include: WITH_LINKED_RECORDS,
    });
    if (!evidence) throw new NotFoundException(EVIDENCE_NOT_FOUND);

    // The lifecycle protocol: the record's period shared, its row locked, then
    // the file's row. A submit counts this record's files under the same row
    // lock, so a detach either lands first (and the submit counts one file
    // fewer) or waits and then finds the record no longer editable — never a
    // submitted record that lost the file it was counted with (F03). The file
    // lock serialises two detaches of one shared file's last two links, or
    // each would see the other's link still there and neither would delete it.
    let gone: { id: string; storagePath: string }[];
    try {
      gone = await this.prisma.$transaction(async (tx) => {
        await lockPeriodsShared(tx, [periodOf(record)]);
        if ((await lockActivityRecordRows(tx, [record.id])).size === 0) {
          throw new NotFoundException(RECORD_NOT_FOUND);
        }
        const current = await tx.activityRecord.findUniqueOrThrow({ where: { id: record.id } });
        if (lockKey(current) !== lockKey(record)) throw new RecordChangedError();
        const locked = await this.lockedRecordIds([current], tx);
        const refusal = this.refusalFor(user, current, locked.has(current.id));
        if (refusal) throw lockedRefusal(refusal, record, current);
        await lockEvidenceRows(tx, [evidence.id]);
        // The file as it is now, under its lock — the audit row's "before".
        const file = await tx.evidence.findUnique({
          where: { id: evidence.id },
          include: WITH_LINKED_RECORDS,
        });
        if (!file) throw new NotFoundException(EVIDENCE_NOT_FOUND);

        // From here on the DATABASE's ids, never the path's: the route accepts
        // either case, and an uppercase id once made a deleted file answer
        // `fileDeleted: false` and audit as a `detach` under an id no lookup finds.
        const { count } = await tx.activityRecordEvidence.deleteMany({
          where: { activityRecordId: current.id, evidenceId: file.id },
        });
        // A concurrent detach of the same link got there first: it answers and
        // audits the change; this request changed nothing.
        if (count === 0) throw new NotFoundException(EVIDENCE_NOT_FOUND);
        const deleted = await this.deleteUnlinkedRows([file.id], tx);
        await this.audit.record(
          user,
          {
            action: deleted.length > 0 ? 'delete' : 'detach',
            entity: 'evidence',
            entityId: file.id,
            diff: { before: { ...this.auditSnapshot(file), recordId: current.id } },
          },
          tx,
        );
        return deleted;
      }, LIFECYCLE_TX);
    } catch (error) {
      throw asLostRace(error);
    }
    await this.removeBlobs(gone.map((f) => f.storagePath));
    return { evidenceId: evidence.id, recordId: record.id, fileDeleted: gone.length > 0 };
  }

  /**
   * `DELETE /evidence/:id` — delete the file from every record it backs.
   *
   * A file backing one record answers with that record's own refusal (403 not
   * the author, 400 no longer editable, 409 period locked), as it always has.
   * A SHARED file is deleted only while every record it backs is editable by
   * the caller; otherwise 409, naming the records that hold it — the way to
   * take it off the editable ones is `detach`.
   */
  async remove(
    user: RequestUser,
    id: string,
  ): Promise<{ id: string; deleted: true }> {
    const evidence = await this.loadEvidenceScoped(user, id);
    this.assertRole(user);
    const records = await this.prisma.activityRecord.findMany({
      where: { evidenceLinks: { some: { evidenceId: evidence.id } } },
    });
    const locked = await this.lockedRecordIds(records);
    const refusals = records
      .map((r) => ({ record: r, refusal: this.refusalFor(user, r, locked.has(r.id)) }))
      .filter((x): x is { record: ActivityRecord; refusal: HttpException } => x.refusal !== null);
    if (refusals.length > 0) {
      if (records.length === 1) throw refusals[0].refusal;
      throw new ConflictException(
        `This file also backs records that can no longer change, so it cannot be deleted: ${refusals
          .map(({ record, refusal }) => `${recordLabel(record)} — ${refusal.message}`)
          .join('; ')}. Remove it from each editable record instead.`,
      );
    }

    // The checks above are an early answer. The lifecycle protocol asks them
    // again with every record the file backs locked — periods shared, then
    // rows, then the file — so a record submitted meanwhile keeps its file
    // and this delete answers 409 (F03: a shared file deleted under a record
    // on its way to approval). A file never gains a record after its upload,
    // so the records read above are every record it can back now.
    //
    // The row, its links and the audit row commit together; the blob goes
    // AFTER the commit — the reverse of this method's old order, which
    // removed the blob first and so could leave a record pointing at bytes
    // that were gone if the row delete then lost a race. Now a storage
    // failure leaves an object with no row: logged, and removed by
    // `pnpm evidence:reclaim`.
    const seen = new Map(records.map((r) => [r.id, r]));
    let file: EvidenceWithLinks;
    try {
      file = await this.prisma.$transaction(async (tx) => {
        await lockPeriodsShared(tx, records.map(periodOf));
        await lockActivityRecordRows(tx, [...seen.keys()]);
        // Deleted meanwhile by another request, which audited it.
        if ((await lockEvidenceRows(tx, [evidence.id])).size === 0) {
          throw new NotFoundException(EVIDENCE_NOT_FOUND);
        }
        const current = await tx.activityRecord.findMany({
          where: { evidenceLinks: { some: { evidenceId: evidence.id } } },
        });
        if (current.some((r) => !seen.has(r.id))) throw new RecordChangedError();
        const locked = await this.lockedRecordIds(current, tx);
        for (const record of current) {
          const refusal = this.refusalFor(user, record, locked.has(record.id));
          if (refusal) throw lockedRefusal(refusal, seen.get(record.id), record);
        }
        const before = await tx.evidence.findUniqueOrThrow({
          where: { id: evidence.id },
          include: WITH_LINKED_RECORDS,
        });
        await tx.evidence.delete({ where: { id: evidence.id } });
        await this.audit.record(
          user,
          {
            action: 'delete',
            entity: 'evidence',
            entityId: evidence.id,
            diff: { before: this.auditSnapshot(before) },
          },
          tx,
        );
        return before;
      }, LIFECYCLE_TX);
    } catch (error) {
      throw asLostRace(error);
    }
    await this.removeBlobs([file.storagePath]);
    return { id: evidence.id, deleted: true };
  }

  /**
   * The files linked to a record — read BEFORE the record is deleted, for
   * `deleteUnlinkedRows` after. Takes the caller's transaction: the record delete
   * reads these under its row lock, so an upload cannot link a file in between.
   */
  async fileIdsFor(
    activityRecordId: string,
    client: Pick<Prisma.TransactionClient, 'activityRecordEvidence'> = this.prisma,
  ): Promise<string[]> {
    const links = await client.activityRecordEvidence.findMany({
      where: { activityRecordId },
      select: { evidenceId: true },
    });
    return links.map((l) => l.evidenceId);
  }

  /**
   * Delete the rows of those `evidenceIds` that no record links to any more,
   * through the caller's transaction, and return them — for `removeBlobs`
   * once that transaction has committed.
   *
   * Called after links go — a detach, or a record delete whose links went by
   * cascade — by a caller holding these files' row locks (`lockEvidenceRows`).
   * Nothing can link an existing file (a file is uploaded with every record it
   * backs), and every other unlink takes the same lock, so "no links" read
   * here is final.
   *
   * Rows in the transaction, blobs after it: the rows commit with the change
   * that unlinked them and with its audit row, or not at all; a storage
   * failure afterwards leaves an object with no row — logged by
   * `removeBlobs`, and removed by `pnpm evidence:reclaim`, which deletes
   * exactly such objects.
   */
  async deleteUnlinkedRows(
    evidenceIds: string[],
    tx: Pick<Prisma.TransactionClient, 'evidence'>,
  ): Promise<{ id: string; storagePath: string }[]> {
    if (evidenceIds.length === 0) return [];
    const unlinked = await tx.evidence.findMany({
      where: { id: { in: evidenceIds }, links: { none: {} } },
      select: { id: true, storagePath: true },
    });
    if (unlinked.length > 0) {
      await tx.evidence.deleteMany({ where: { id: { in: unlinked.map((f) => f.id) } } });
    }
    return unlinked;
  }

  /** Remove objects whose rows are gone; a failure is logged, never thrown — the row's change has already happened. */
  async removeBlobs(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      await this.storage.remove(EVIDENCE_BUCKET, paths);
    } catch (error) {
      this.logger.error(
        `Could not remove ${paths.length} evidence object(s) — run pnpm evidence:reclaim: ${paths.join(', ')}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
