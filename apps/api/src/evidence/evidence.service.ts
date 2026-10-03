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
  type EvidenceDTO,
  type EvidenceDetachDTO,
  type EvidenceLinkRefusal,
  type EvidenceLinkRefusedDTO,
  mayAuthorRecords,
} from '@tonyai/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { StorageObjectMissingError, StorageService } from '../storage/storage.service';
import { StorageIntentsService, type ObjectRef } from '../storage/storage-intents.service';
import { EVIDENCE_BUCKET } from '../storage/buckets';
import { captureException } from '../observability/sentry';
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
import { type CheckedEvidenceFile, checkEvidenceFile, downloadName } from './file-content';

export { EVIDENCE_BUCKET };
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

/** Whether a locked re-read is still the record read before the locks: same subsidiary, same period. */
function sameRead(current: ActivityRecord, seen: ActivityRecord | undefined, subsidiaryId: string): boolean {
  return !!seen && current.subsidiaryId === subsidiaryId && lockKey(current) === lockKey(seen);
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
    private readonly intents: StorageIntentsService,
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

  /**
   * The audit trail's picture of a file: its metadata, its content hash (null
   * before LP1-02) and the ids it backs — not the record details.
   */
  private auditSnapshot(e: EvidenceWithLinks) {
    const { linkedRecords, ...file } = this.toDTO(e);
    return { ...file, sha256: e.sha256, recordIds: linkedRecords.map((r) => r.id) };
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
    const checked = checkEvidenceFile(file);
    return this.store(user, [record], file, checked);
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

    const checked = checkEvidenceFile(file);
    return this.store(user, ids.map((id) => byId.get(id)!), file, checked);
  }

  /**
   * Upload the blob, then write the file row, its links and its audit row in
   * one transaction. The caller has already checked every record; the
   * transaction checks them again under the lifecycle protocol — their
   * periods shared, their rows locked — so a record submitted, or a period
   * locked, while the blob was uploading does not gain the file.
   *
   * Storage is not in that transaction, so the object is named first: an
   * `upload` intent commits before the bytes go up, and the row's transaction
   * adopts (deletes) it. If anything fails before the commit, the intent is
   * abandoned and the object removed — and only then: a transaction that
   * committed although its acknowledgement was lost has already adopted the
   * intent, so its object stays with its row (this method used to delete the
   * bytes of a committed row in that case). A crash anywhere leaves the
   * intent for the sweeper (`StorageIntentsService`).
   */
  private async store(
    user: RequestUser,
    records: ActivityRecord[],
    file: Express.Multer.File,
    checked: CheckedEvidenceFile,
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
    const safeName = checked.fileName.replace(/[^\w.-]+/g, '_').slice(0, 120);
    const storagePath = `${subsidiaryId}/${randomUUID()}-${safeName}`;
    const ref: ObjectRef = { bucket: EVIDENCE_BUCKET, path: storagePath };
    const intentId = await this.intents.beginUpload(ref, { reason: 'evidence.upload', subsidiaryId });
    try {
      await this.storage.upload(EVIDENCE_BUCKET, storagePath, file.buffer, checked.mimeType);
    } catch (error) {
      await this.intents.abandonUpload(intentId, ref);
      throw error;
    }

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
          // The period locks above are the ones the records were in when read;
          // a record moved since is guarded by a lock this upload never took.
          if (!sameRead(record, seen.get(record.id), subsidiaryId)) throw new RecordChangedError();
          const refusal = this.refusalFor(user, record, locked.has(record.id));
          if (refusal) throw lockedRefusal(refusal, seen.get(record.id), record);
        }
        // The row takes the object over; refused if the sweeper abandoned it.
        await this.intents.adoptUpload(tx, intentId);
        const row = await tx.evidence.create({
          data: {
            subsidiaryId,
            storagePath,
            fileName: checked.fileName,
            mimeType: checked.mimeType,
            sizeBytes: file.size,
            sha256: checked.sha256,
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
      await this.intents.abandonUpload(intentId, ref);
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
    let url: string;
    try {
      url = await this.storage.createSignedUrl(
        EVIDENCE_BUCKET,
        evidence.storagePath,
        SIGNED_URL_TTL_SECONDS,
        downloadName(evidence.fileName, evidence.mimeType),
      );
    } catch (error) {
      if (!(error instanceof StorageObjectMissingError)) throw error;
      // A row whose bytes are gone: never answered as a server fault, never
      // silent. `storage:reconcile` lists every such row.
      this.logger.error(
        `Evidence ${evidence.id} has no object in Storage (${EVIDENCE_BUCKET}/${evidence.storagePath})`,
      );
      captureException(error, { userId: user.id });
      throw new NotFoundException(
        "This file's contents are missing from storage. The problem has been reported to the administrators.",
      );
    }
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
    // The row, its links, the audit row and a `delete` intent for the blob
    // commit together; the blob goes AFTER the commit — the reverse of this
    // method's old order, which removed the blob first and so could leave a
    // record pointing at bytes that were gone if the row delete then lost a
    // race. A storage failure after the commit leaves the intent, retried by
    // the sweeper until Storage confirms.
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
        // A record that is not one read above, or that moved to another period
        // since, is guarded by a lock this delete never took.
        if (current.some((r) => !sameRead(r, seen.get(r.id), evidence.subsidiaryId))) {
          throw new RecordChangedError();
        }
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
        await this.intents.enqueueDeletes(
          tx,
          [{ bucket: EVIDENCE_BUCKET, path: before.storagePath }],
          { reason: 'evidence.delete', subsidiaryId: before.subsidiaryId },
        );
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
   * through the caller's transaction, record a `delete` intent for each of
   * their blobs in it, and return them — for `removeBlobs` once that
   * transaction has committed.
   *
   * Called after links go — a detach, or a record delete whose links went by
   * cascade — by a caller holding these files' row locks (`lockEvidenceRows`).
   * Nothing can link an existing file (a file is uploaded with every record it
   * backs), and every other unlink takes the same lock, so "no links" read
   * here is final.
   *
   * Rows and intents in the transaction, blobs after it: the rows commit
   * with the change that unlinked them, its audit row and the intents to
   * remove their blobs, or none of it does; a storage failure afterwards
   * leaves the intents, retried by the sweeper.
   */
  async deleteUnlinkedRows(
    evidenceIds: string[],
    tx: Pick<Prisma.TransactionClient, 'evidence' | 'storageIntent'>,
  ): Promise<{ id: string; storagePath: string }[]> {
    if (evidenceIds.length === 0) return [];
    const unlinked = await tx.evidence.findMany({
      where: { id: { in: evidenceIds }, links: { none: {} } },
      select: { id: true, storagePath: true, subsidiaryId: true },
    });
    if (unlinked.length === 0) return [];
    await tx.evidence.deleteMany({ where: { id: { in: unlinked.map((f) => f.id) } } });
    await this.intents.enqueueDeletes(
      tx,
      unlinked.map((f) => ({ bucket: EVIDENCE_BUCKET, path: f.storagePath })),
      // One subsidiary per file; a record delete's files share its subsidiary.
      { reason: 'evidence.unlinked', subsidiaryId: unlinked[0].subsidiaryId },
    );
    return unlinked.map(({ id, storagePath }) => ({ id, storagePath }));
  }

  /**
   * After the commit: remove the blobs whose rows (and `delete` intents)
   * committed. Never throws — the row's change has already happened; a
   * failure leaves the intents to the sweeper.
   */
  async removeBlobs(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.intents.runNow(paths.map((path) => ({ bucket: EVIDENCE_BUCKET, path })));
  }
}
