import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, type ActivityRecord, type FuelBatch } from '@tonyai/db';
import {
  can,
  isCalculated,
  type ActivityCalculationSnapshot,
  type FuelBatchDTO,
  type FuelBatchDetailDTO,
  type FuelBatchFilters,
  type FuelBatchRecordDTO,
  type FuelBatchRowDTO,
  type FuelBatchStatus,
  type FuelSource,
  type FuelUsage,
  type FuelRowState,
  type FileFuel,
  PERIOD_VALUES,
  fuelRecordTarget,
  mayAuthorRecords,
  FUEL_BATCH_PAGE,
  parseFuelBatchCursor,
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { errorBody, ResourceNotFoundError } from '../common/api-error';
import { actorDisplayName, resolveProfiles } from '../common/resolve-profiles';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityRecordsService } from '../activity-records/activity-records.service';
import { declareFuelBatchStep, lockPeriodsShared, periodOf } from '../activity-records/lifecycle-lock';
import { AuthorOnlyRefusedError, RecordChangedError, SubmitRoleRefusedError } from '../activity-records/errors';
import { lockAuthorAccess } from '../central-reporting/record-entities';
import { approversFor, awaitingDecisionWhere, deciderFor } from '../activity-records/record-approver';
import { sumDecimals } from '../fuel-files/decimal';
import { fuelBatchVerdicts } from './fuel-batch-anomaly';
import { keepReportingCompany } from './batch-reporting';
import { EvidenceService } from '../evidence/evidence.service';
import { CreateActivityRecordDto } from '../activity-records/dto/create-activity-record.dto';
import { usageCategory } from '../fuel-files/fuel-scope';
import { fuelBatchScopeWhere } from './fuel-batch-scope';

export { fuelBatchScopeWhere };

/**
 * A fuel batch's reads and its lifecycle (inc28-fuel-bulk D9, D10, D14). A
 * step is ONE transaction: the batch row `FOR UPDATE`, the submission the
 * caller saw, the shared locks of every period of its records in sorted order,
 * then each live record by id through the record service's own lifted core —
 * row lock, company, role and approver, evidence, anomaly, staleness,
 * compare-and-set — the batch declared for TA029, its status and one audit
 * row. Any refusal rolls the whole step back.
 */

const STEP_TX = { timeout: 60_000, maxWait: 10_000 } as const;
const ROW_PAGE_MAX = 200;

type LiveRecord = ActivityRecord & { location: { name: string } | null };

export class FuelBatchNotOpenError extends ConflictException {
  constructor() {
    super(errorBody('fuel_batch_not_open', 'This batch is no longer a draft or returned, so it cannot be changed.'));
  }
}

/** As a record's own edit refuses a role that may not author records. */
const ROLE_REFUSAL = 'Your role may not modify activity records';

@Injectable()
export class FuelBatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly records: ActivityRecordsService,
    private readonly evidence: EvidenceService,
  ) {}

  // ── Reads (D10) ────────────────────────────────────────────────────────────

  private async filterWhere(user: RequestUser, filters: FuelBatchFilters): Promise<Prisma.FuelBatchWhereInput | null> {
    const and: Prisma.FuelBatchWhereInput[] = [fuelBatchScopeWhere(user)];
    if (filters.status) and.push({ status: filters.status });
    if (filters.subsidiaryId) and.push({ subsidiaryId: filters.subsidiaryId });
    if (filters.mine) and.push({ createdBy: user.id });
    if (filters.awaitingMyDecision) {
      // The record rule's own filter: a batch carries the fields it reads.
      const awaiting = await awaitingDecisionWhere(this.prisma, user);
      if (awaiting === null) return null;
      and.push(awaiting as unknown as Prisma.FuelBatchWhereInput);
    }
    return { AND: and };
  }

  async list(user: RequestUser, filters: FuelBatchFilters): Promise<FuelBatchDTO[]> {
    const filtered = await this.filterWhere(user, filters);
    if (filtered === null) return [];
    const reviewOrder = filters.awaitingMyDecision || filters.status === 'submitted' || filters.status === 'under_review';
    let where: Prisma.FuelBatchWhereInput = filtered;
    const cursor = filters.after ? parseFuelBatchCursor(filters.after) : null;
    // A cursor this list did not give (a date no calendar has, a malformed id) is refused before any query.
    if (filters.after && !cursor) throw new BadRequestException(errorBody('validation_failed', 'Not a cursor this list gave.'));
    if (cursor) {
      // After the cursor in this list's own total order (the id breaks ties),
      // by the sort values the page showed — in the same query as the scope
      // and the page limit. Every batch time is written by the API at
      // millisecond precision, so these compare exactly.
      if (reviewOrder) {
        if (cursor.submittedAt === null) return [];
        where = { AND: [filtered, { OR: [{ submittedAt: { gt: cursor.submittedAt } }, { submittedAt: cursor.submittedAt, id: { gt: cursor.id } }] }] };
      } else {
        where = { AND: [filtered, { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] };
      }
    }
    const batches = await this.prisma.fuelBatch.findMany({
      where,
      orderBy: reviewOrder ? [{ submittedAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
      take: FUEL_BATCH_PAGE,
    });
    return this.dtos(user, batches);
  }

  async metadata(user: RequestUser, filters: FuelBatchFilters): Promise<{ total: number }> {
    const where = await this.filterWhere(user, filters);
    return { total: where === null ? 0 : await this.prisma.fuelBatch.count({ where }) };
  }

  async detail(user: RequestUser, id: string): Promise<FuelBatchDetailDTO> {
    const batch = await this.visible(user, id);
    const [dto] = await this.dtos(user, [batch]);
    const records = await this.prisma.activityRecord.findMany({ where: { fuelBatchId: id }, orderBy: [{ reportingYear: 'asc' }, { id: 'asc' }] });
    const files = await this.prisma.$queryRaw<Array<{ id: string; fileName: string }>>`
      SELECT DISTINCT e.id::text, e.file_name AS "fileName", e.created_at FROM evidence e
      JOIN activity_record_evidence l ON l.evidence_id = e.id
      JOIN activity_records a ON a.id = l.activity_record_id
      WHERE a.fuel_batch_id = ${id}::uuid ORDER BY e.created_at`;
    return {
      ...dto!,
      records: records.map((r): FuelBatchRecordDTO => {
        const calc = r.calculation as unknown as ActivityCalculationSnapshot | null;
        return {
          id: r.id,
          reportingYear: r.reportingYear,
          month: (PERIOD_VALUES.monthly as readonly string[]).indexOf(r.periodValue) + 1,
          activityType: r.activityType ?? '',
          status: r.status,
          litres: new Prisma.Decimal(r.activityValue).toFixed(),
          tCo2e: isCalculated(calc) ? calc.tCo2e : null,
        };
      }),
      evidence: files.map((f) => ({ id: f.id, fileName: f.fileName })),
    };
  }

  async rows(user: RequestUser, id: string, page: { offset?: number; limit?: number }): Promise<{ rows: FuelBatchRowDTO[]; total: number }> {
    await this.visible(user, id);
    const take = Math.min(Math.max(page.limit ?? 50, 1), ROW_PAGE_MAX);
    const skip = Math.max(page.offset ?? 0, 0);
    const [rows, total] = await Promise.all([
      this.prisma.fuelRow.findMany({ where: { fuelBatchId: id }, orderBy: [{ transactionAt: 'asc' }, { id: 'asc' }], skip, take }),
      this.prisma.fuelRow.count({ where: { fuelBatchId: id } }),
    ]);
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        importId: r.importBatchId,
        row: r.fileRow,
        transactionAt: r.transactionAt ? r.transactionAt.toISOString().slice(0, 19) : null,
        year: r.year,
        month: r.month,
        rawFuel: r.rawFuel,
        fuel: (r.fuel as FileFuel | null) ?? null,
        // Plain decimal text: `toString()` writes 0.0000001 as 1e-7 (WP9 PR B review, P2).
        litres: r.litres.toFixed(),
        state: r.state as FuelRowState,
      })),
    };
  }

  async visible(user: RequestUser, id: string): Promise<FuelBatch> {
    const batch = await this.prisma.fuelBatch.findFirst({ where: { AND: [{ id }, fuelBatchScopeWhere(user)] } });
    if (!batch) throw new ResourceNotFoundError('fuel_batch_not_found');
    return batch;
  }

  async dtos(user: RequestUser, batches: readonly FuelBatch[]): Promise<FuelBatchDTO[]> {
    if (batches.length === 0) return [];
    const ids = batches.map((b) => b.id);
    const [companies, accounts, rowSums, recordSums, siblings, uploaders, evidence, approvers] = await Promise.all([
      this.prisma.subsidiary.findMany({ where: { id: { in: batches.map((b) => b.subsidiaryId) } }, select: { id: true, legalName: true, tradingName: true } }),
      this.prisma.fuelAccount.findMany({ where: { id: { in: batches.map((b) => b.fuelAccountId) } }, select: { id: true, code: true, name: true } }),
      this.prisma.$queryRaw<Array<{ id: string; rows: number; litres: string }>>`
        SELECT fuel_batch_id::text AS id, count(*)::int AS rows, sum(litres)::text AS litres
        FROM fuel_rows WHERE fuel_batch_id = ANY(${ids}::uuid[]) GROUP BY fuel_batch_id`,
      this.prisma.activityRecord.findMany({
        where: { fuelBatchId: { in: ids }, status: { not: 'voided' } },
        select: { fuelBatchId: true, calculation: true, reportedBySubsidiaryId: true, createdBy: true, subsidiaryId: true, status: true, id: true },
      }),
      this.prisma.$queryRaw<Array<{ id: string; others: number }>>`
        SELECT b.id::text, count(o.id)::int AS others FROM fuel_batches b
        JOIN fuel_batches o ON o.fuel_account_id = b.fuel_account_id AND o.invoice_ref = b.invoice_ref
          AND o.id <> b.id AND o.status <> 'withdrawn'
        WHERE b.id = ANY(${ids}::uuid[]) GROUP BY b.id`,
      this.prisma.$queryRaw<Array<{ id: string; uploader: string }>>`
        SELECT DISTINCT r.fuel_batch_id::text AS id, i.uploaded_by::text AS uploader
        FROM fuel_rows r JOIN import_batches i ON i.id = r.import_batch_id
        WHERE r.fuel_batch_id = ANY(${ids}::uuid[])`,
      this.prisma.$queryRaw<Array<{ id: string; files: number }>>`
        SELECT a.fuel_batch_id::text AS id, count(DISTINCT l.evidence_id)::int AS files
        FROM activity_records a JOIN activity_record_evidence l ON l.activity_record_id = a.id
        WHERE a.fuel_batch_id = ANY(${ids}::uuid[]) GROUP BY a.fuel_batch_id`,
      approversFor(this.prisma, batches.map((b) => ({ id: b.id, status: b.status, createdBy: b.createdBy, subsidiaryId: b.subsidiaryId }))),
    ]);
    const reporting = [
      ...new Set([...recordSums.map((r) => r.reportedBySubsidiaryId), ...batches.map((b) => b.reportedBySubsidiaryId)].filter((id): id is string => !!id)),
    ];
    const reportingNames = reporting.length
      ? await this.prisma.subsidiary.findMany({ where: { id: { in: reporting }, organisationId: user.organisationId! }, select: { id: true, legalName: true, tradingName: true } })
      : [];
    const people = await resolveProfiles(this.prisma, [
      ...batches.flatMap((b) => [b.createdBy, b.reviewedBy, b.withdrawnBy]),
      ...uploaders.map((u) => u.uploader),
    ]);
    const nameOf = (c?: { legalName: string; tradingName: string | null }) => (c ? c.tradingName || c.legalName : '');
    return batches.map((b) => {
      const records = recordSums.filter((r) => r.fuelBatchId === b.id);
      const figures = records.map((r) => r.calculation as unknown as ActivityCalculationSnapshot | null).filter(isCalculated);
      // The batch's own record of it first (kept when its records are gone or voided), then its live records'.
      const reportedBy =
        b.reportedBySubsidiaryId ??
        records.find((r) => r.reportedBySubsidiaryId && r.reportedBySubsidiaryId !== b.subsidiaryId)?.reportedBySubsidiaryId ??
        null;
      const account = accounts.find((a) => a.id === b.fuelAccountId);
      const sums = rowSums.find((r) => r.id === b.id);
      return {
        id: b.id,
        source: b.source as FuelSource,
        subsidiaryId: b.subsidiaryId,
        subsidiaryName: nameOf(companies.find((c) => c.id === b.subsidiaryId)),
        accountId: b.fuelAccountId,
        accountCode: account?.code ?? '',
        accountName: account?.name ?? '',
        invoiceRef: b.invoiceRef,
        sequence: b.sequence,
        hasSiblings: (siblings.find((s) => s.id === b.id)?.others ?? 0) > 0,
        usage: b.usage as FuelUsage,
        category: b.category as FuelBatchDTO['category'],
        status: b.status as FuelBatchStatus,
        createdBy: b.createdBy,
        createdByName: actorDisplayName(b.createdBy, people),
        uploaders: uploaders.filter((u) => u.id === b.id).map((u) => ({ id: u.uploader, name: actorDisplayName(u.uploader, people) })),
        reportingSubsidiaryId: reportedBy,
        reportingSubsidiaryName: reportedBy ? nameOf(reportingNames.find((c) => c.id === reportedBy)) || null : null,
        approver: approvers.get(b.id) ?? null,
        submittedAt: b.submittedAt?.toISOString() ?? null,
        submissionCount: b.submissionCount,
        reviewedBy: b.reviewedBy,
        reviewedByName: actorDisplayName(b.reviewedBy, people),
        reviewedAt: b.reviewedAt?.toISOString() ?? null,
        reviewNote: b.reviewNote,
        varianceReason: b.varianceReason,
        withdrawnBy: b.withdrawnBy,
        withdrawnAt: b.withdrawnAt?.toISOString() ?? null,
        withdrawnReason: b.withdrawnReason,
        rowCount: sums?.rows ?? 0,
        litres: sums ? sumDecimals([sums.litres]) : '0',
        tCo2e: figures.length ? figures.reduce((s, c) => s + c.tCo2e, 0) : null,
        evidenceCount: evidence.find((e) => e.id === b.id)?.files ?? 0,
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
      };
    });
  }

  // ── The lifecycle (D9) ─────────────────────────────────────────────────────

  /**
   * One step: the batch locked, its live records locked under their periods'
   * shared locks (sorted), `perRecord` run on each, the batch's own row and
   * one audit row. Answers nothing: the step is done once it commits, and
   * each caller reads the batch afterwards (a bulk submit does not — a read
   * failing after the commit must never report a submitted batch as failed;
   * fourth review of the branch, P2).
   */
  private async step(
    user: RequestUser,
    id: string,
    action: 'submit' | 'recall' | 'review' | 'approve' | 'reject',
    gate: (batch: FuelBatch) => void,
    perRecord: (tx: Prisma.TransactionClient, seen: ActivityRecord, current: LiveRecord, batch: FuelBatch) => Promise<unknown>,
    after: (batch: FuelBatch) => Prisma.FuelBatchUpdateInput,
    prepare?: (records: ActivityRecord[]) => Promise<void>,
  ): Promise<void> {
    const seenBatch = await this.visible(user, id);
    const seenRecords = await this.prisma.activityRecord.findMany({ where: { fuelBatchId: id, status: { not: 'voided' } }, orderBy: { id: 'asc' } });
    if (prepare) await prepare(seenRecords);
    try {
      await this.prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM fuel_batches WHERE id = ${id}::uuid FOR UPDATE`;
        if (!locked) throw new ResourceNotFoundError('fuel_batch_not_found');
        const batch = await tx.fuelBatch.findUniqueOrThrow({ where: { id } });
        if (batch.status !== seenBatch.status || batch.submissionCount !== seenBatch.submissionCount) throw new RecordChangedError();
        // A batch is never moved past its records: with none live (each voided)
        // no record's own status or approver gate would run (QA review of PR B).
        if (seenRecords.length === 0) throw new FuelBatchNotOpenError();
        gate(batch);
        await declareFuelBatchStep(tx, id);
        await lockPeriodsShared(tx, seenRecords.map(periodOf));
        // The author's own steps: its role and its access to the batch's
        // company and category re-read at the write — after the periods, as
        // the record cores do it, so no step waits on a period while holding
        // the author's rows (D14; WP9 PR B review, P1; lock order: QA review).
        if (action === 'submit' || action === 'recall') await lockAuthorAccess(tx, user, batch.subsidiaryId, batch.category, 'edit');
        // A decision holds its decider's profile row for the whole step, so the
        // role and grants every record's approver check reads, and the batch's
        // audit row names, are one and the same: a role or grant change (which
        // takes that row first) waits for the decision (third review, P2).
        if (action === 'review' || action === 'approve' || action === 'reject') {
          await tx.$queryRaw`SELECT 1 FROM profiles WHERE id = ${user.id}::uuid FOR SHARE`;
        }
        const now = await tx.activityRecord.findMany({ where: { fuelBatchId: id, status: { not: 'voided' } }, select: { id: true }, orderBy: { id: 'asc' } });
        // A record added or removed since the read: the caller acts on a batch it did not see.
        if (now.map((r) => r.id).join() !== seenRecords.map((r) => r.id).join()) throw new RecordChangedError();
        for (const seen of seenRecords) {
          const current = await this.records.lockSeenRecord(tx, seen, user.organisationId);
          await perRecord(tx, seen, current, batch);
        }
        const updated = await tx.fuelBatch.update({ where: { id }, data: after(batch) });
        // A decision's batch row names the decider as the record cores just
        // verified it (`deciderFor`: the role re-read in this transaction), so
        // the batch's audit row and its records' agree on the role that
        // authorised the step (second review of the branch, P2).
        const actor =
          action === 'review' || action === 'approve' || action === 'reject'
            ? await deciderFor(tx, user, { createdBy: batch.createdBy, subsidiaryId: batch.subsidiaryId }, action)
            : user;
        await this.audit.record(
          actor,
          {
            action: action === 'approve' && batch.createdBy === user.id ? 'self_approve' : action,
            entity: 'fuel_batch',
            entityId: id,
            diff: { transition: { from: batch.status, to: updated.status }, records: seenRecords.length, ...(updated.reviewNote && action === 'reject' ? { reviewNote: updated.reviewNote } : {}) },
          },
          tx,
        );
      }, STEP_TX);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') throw new RecordChangedError();
      throw error;
    }
  }

  /** A review or a decision names the batch's submission its reviewer saw (D9). */
  private assertSubmission(batch: FuelBatch, seenSubmittedAt: string | null | undefined, required: boolean): void {
    if (seenSubmittedAt === undefined) {
      if (required) throw new RecordChangedError();
      return;
    }
    const seen = seenSubmittedAt === null ? null : Date.parse(seenSubmittedAt);
    if (seen !== (batch.submittedAt?.getTime() ?? null)) throw new RecordChangedError();
  }

  async submit(user: RequestUser, id: string, varianceReason?: string): Promise<FuelBatchDetailDTO> {
    await this.submitStep(user, id, varianceReason);
    return this.detail(user, id);
  }

  /** The submit itself; done once it commits. */
  private async submitStep(user: RequestUser, id: string, varianceReason?: string): Promise<void> {
    // As a record's submit: a role that may not author records submits nothing, its own old batch included.
    if (!mayAuthorRecords(user)) throw new SubmitRoleRefusedError();
    const recomputed = new Map<string, Awaited<ReturnType<ActivityRecordsService['recomputeFor']>>>();
    let verdicts: Awaited<ReturnType<typeof fuelBatchVerdicts>> = {};
    await this.step(
      user, id, 'submit',
      (batch) => {
        if (batch.status !== 'draft' && batch.status !== 'rejected') throw new FuelBatchNotOpenError();
        if (batch.createdBy !== user.id) throw new ForbiddenException(errorBody('record_submit_forbidden', 'Only the batch’s author submits it.'));
      },
      async (tx, seen, current) => {
        if (Object.keys(verdicts).length === 0) verdicts = await fuelBatchVerdicts(tx, id);
        await this.records.submitLocked(tx, user, seen, current, recomputed.get(seen.id)!, {
          verdict: verdicts[seen.id] ?? { anomalous: false, priorCount: null, baseline: null },
          varianceReason: varianceReason?.trim() || null,
        });
      },
      (batch) => ({
        status: 'submitted', submittedAt: new Date(), submissionCount: batch.submissionCount + 1,
        varianceReason: varianceReason?.trim() || null,
      }),
      async (records) => {
        for (const r of records) recomputed.set(r.id, await this.records.recomputeFor(user, r));
      },
    );
  }

  async recall(user: RequestUser, id: string): Promise<FuelBatchDetailDTO> {
    if (!mayAuthorRecords(user)) throw new ForbiddenException(ROLE_REFUSAL);
    await this.step(
      user, id, 'recall',
      (batch) => {
        if (batch.status !== 'submitted') throw new ConflictException(errorBody('record_changed', 'Only a submitted batch nobody has opened can be recalled.'));
        // The author's own step, at the batch as for each record (security review of PR B).
        if (batch.createdBy !== user.id) throw new AuthorOnlyRefusedError('recall');
      },
      (tx, seen, current) => this.records.recallLocked(tx, user, seen, current),
      () => ({ status: 'draft', submittedAt: null }),
    );
    return this.detail(user, id);
  }

  async startReview(user: RequestUser, id: string, seenSubmittedAt?: string | null): Promise<FuelBatchDetailDTO> {
    if (!can(user.role, 'record.decide')) throw new ForbiddenException();
    await this.step(
      user, id, 'review',
      (batch) => {
        // The batch's own status, as each record's: only a submitted batch is taken into review.
        if (batch.status !== 'submitted') throw new RecordChangedError();
        // Required, as for a decision: taking a batch into review closes its
        // author's recall, so it is taken only at the submission the reviewer
        // was shown (D9; WP9 PR B review, P2).
        this.assertSubmission(batch, seenSubmittedAt, true);
      },
      (tx, seen, current) => this.records.startReviewLocked(tx, user, seen, current, current.submittedAt?.toISOString() ?? null),
      () => ({ status: 'under_review', reviewedBy: user.id, reviewedAt: new Date() }),
    );
    return this.detail(user, id);
  }

  async approve(user: RequestUser, id: string, seenSubmittedAt?: string | null): Promise<FuelBatchDetailDTO> {
    if (!can(user.role, 'record.decide')) throw new ForbiddenException();
    const recomputed = new Map<string, Awaited<ReturnType<ActivityRecordsService['recomputeFor']>>>();
    await this.step(
      user, id, 'approve',
      (batch) => {
        if (batch.status !== 'submitted' && batch.status !== 'under_review') throw new RecordChangedError();
        this.assertSubmission(batch, seenSubmittedAt, true);
      },
      (tx, seen, current) =>
        this.records.approveLocked(tx, user, seen, current, current.submittedAt?.toISOString() ?? null, recomputed.get(seen.id)!),
      () => ({ status: 'approved', reviewedBy: user.id, reviewedAt: new Date(), reviewNote: null }),
      async (records) => {
        for (const r of records) recomputed.set(r.id, await this.records.recomputeFor(user, r));
      },
    );
    return this.detail(user, id);
  }

  async reject(user: RequestUser, id: string, reason: string, seenSubmittedAt?: string | null): Promise<FuelBatchDetailDTO> {
    if (!can(user.role, 'record.decide')) throw new ForbiddenException();
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new BadRequestException(errorBody('validation_failed', 'A return needs a reason.'));
    }
    await this.step(
      user, id, 'reject',
      (batch) => {
        if (batch.status !== 'submitted' && batch.status !== 'under_review') throw new RecordChangedError();
        this.assertSubmission(batch, seenSubmittedAt, true);
      },
      (tx, seen, current) => this.records.rejectLocked(tx, user, seen, current, reason, current.submittedAt?.toISOString() ?? null),
      () => ({ status: 'rejected', reviewedBy: user.id, reviewedAt: new Date(), reviewNote: reason }),
    );
    return this.detail(user, id);
  }

  /** `POST /fuel-batches/bulk-submit`: each batch its own step; each refusal named. */
  async bulkSubmit(user: RequestUser, batchIds: readonly string[]): Promise<{ submitted: string[]; failed: Array<{ batchId: string; code: string }> }> {
    const submitted: string[] = [];
    const failed: Array<{ batchId: string; code: string }> = [];
    for (const batchId of [...new Set(batchIds)]) {
      try {
        // Its outcome is the step's commit; the batch is not read again (fourth review, P2).
        await this.submitStep(user, batchId);
        submitted.push(batchId);
      } catch (error) {
        const body = (error as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
        failed.push({ batchId, code: body?.code ?? 'unexpected' });
      }
    }
    return { submitted, failed };
  }

  // ── Declarations and withdrawal (D13) ─────────────────────────────────────

  /**
   * `PATCH /fuel-batches/:id/declarations` (author; draft or returned): the
   * usage, and for a tanker batch its fuel, year and month, rewritten on the
   * batch and its rows; then the records rebuilt by key (year, month,
   * category, activity type) in the same transaction — a key in both sets
   * keeps its record and id, a new key is created and given the batch's
   * files, an old key is removed. A refusal leaves everything as it was.
   */
  async changeDeclarations(
    user: RequestUser,
    id: string,
    change: { usage: FuelUsage; fuel?: FileFuel; year?: number; month?: number },
  ): Promise<FuelBatchDetailDTO> {
    if (!mayAuthorRecords(user)) throw new ForbiddenException(ROLE_REFUSAL);
    const seenBatch = await this.visible(user, id);
    const tanker = seenBatch.source === 'tanker';
    if (!tanker && (change.fuel !== undefined || change.year !== undefined || change.month !== undefined)) {
      throw new BadRequestException(errorBody('validation_failed', 'Only a tanker delivery declares its fuel and period.'));
    }
    const removed: Array<{ id: string; storagePath: string }> = [];
    try {
      await this.prisma.$transaction(async (tx) => {
        const batch = await this.lockOpen(tx, user, id, false);
        await declareFuelBatchStep(tx, id);
        // The declaration as it stood and as it now stands, whole: a tanker
        // batch is one delivery, whose rows share one fuel and period — so the
        // trail alone rebuilds both (WP9 PR B review, P2).
        const declaredBefore = tanker
          ? await tx.$queryRaw<Array<{ fuel: FileFuel | null; year: number; month: number }>>`
              SELECT DISTINCT fuel, year, month FROM fuel_rows WHERE fuel_batch_id = ${id}::uuid AND state = 'assigned' ORDER BY 1, 2, 3`
          : [];
        const was = declaredBefore[0];
        const before = tanker && was ? { usage: batch.usage, fuel: was.fuel, year: was.year, month: was.month } : { usage: batch.usage };
        const after = tanker && was
          ? { usage: change.usage, fuel: change.fuel ?? was.fuel, year: change.year ?? was.year, month: change.month ?? was.month }
          : { usage: change.usage };
        await tx.fuelBatch.update({ where: { id }, data: { usage: change.usage, category: usageCategory(change.usage) } });
        await tx.fuelRow.updateMany({
          where: { fuelBatchId: id, state: 'assigned' },
          data: {
            usage: change.usage,
            ...(tanker && change.fuel ? { fuel: change.fuel } : {}),
            ...(tanker && change.year ? { year: change.year } : {}),
            ...(tanker && change.month ? { month: change.month } : {}),
          },
        });
        removed.push(...(await this.rebuild(tx, user, { ...batch, usage: change.usage })));
        await keepReportingCompany(tx, id);
        // The author's standing at the write, after the rebuild's periods (the
        // record cores it ran re-read it per record too): a refusal rolls all back.
        await lockAuthorAccess(tx, user, batch.subsidiaryId, batch.category, 'edit');
        await this.audit.record(
          user,
          { action: 'update', entity: 'fuel_batch', entityId: id, diff: { declarations: { before, after } } },
          tx,
        );
      }, STEP_TX);
    } catch (error) {
      throw this.stepRefusal(error);
    }
    await this.evidenceBlobs(removed);
    return this.detail(user, id);
  }

  /**
   * `POST /fuel-batches/:id/withdraw` (author or masterkey; draft or returned):
   * its records removed as a draft's are, the batch and its rows kept as
   * withdrawn with who, when and why, out of every sum (C14).
   */
  async withdraw(user: RequestUser, id: string, reason: string): Promise<FuelBatchDetailDTO> {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new BadRequestException(errorBody('validation_failed', 'A withdrawal needs a reason.'));
    }
    if (!mayAuthorRecords(user)) throw new ForbiddenException(ROLE_REFUSAL);
    await this.visible(user, id);
    const removed: Array<{ id: string; storagePath: string }> = [];
    try {
      await this.prisma.$transaction(async (tx) => {
        const batch = await this.lockOpen(tx, user, id, can(user.role, 'fuel_rows.take_over'));
        await declareFuelBatchStep(tx, id);
        const records = await tx.activityRecord.findMany({ where: { fuelBatchId: id, status: { not: 'voided' } }, orderBy: { id: 'asc' } });
        await lockPeriodsShared(tx, records.map(periodOf));
        await lockAuthorAccess(tx, user, batch.subsidiaryId, batch.category, 'edit');
        for (const record of records) {
          const current = await this.records.lockSeenRecord(tx, record, user.organisationId);
          removed.push(...(await this.records.removeLocked(tx, user, current)));
        }
        const [rows] = await tx.$queryRaw<Array<{ rows: number; litres: string | null }>>`
          WITH w AS (
            UPDATE fuel_rows SET withdrawn_state = state, state = 'withdrawn', withdrawn_by = ${user.id}::uuid,
              withdrawn_at = now(), withdrawn_reason = ${reason.trim()}, updated_at = now()
            WHERE fuel_batch_id = ${id}::uuid AND state = 'assigned' RETURNING litres
          ) SELECT count(*)::int AS rows, sum(litres)::text AS litres FROM w`;
        await tx.fuelBatch.update({
          where: { id },
          data: { status: 'withdrawn', withdrawnBy: user.id, withdrawnAt: new Date(), withdrawnReason: reason.trim() },
        });
        await this.audit.record(
          user,
          { action: 'retract', entity: 'fuel_batch', entityId: id, diff: { reason: reason.trim(), rows: rows?.rows ?? 0, litres: rows?.litres ?? '0', records: records.length } },
          tx,
        );
      }, STEP_TX);
    } catch (error) {
      throw this.stepRefusal(error);
    }
    await this.evidenceBlobs(removed);
    return this.detail(user, id);
  }

  /** The batch row locked, open, and the caller's (or, for a withdrawal, a masterkey's). */
  private async lockOpen(tx: Prisma.TransactionClient, user: RequestUser, id: string, anyAuthor: boolean): Promise<FuelBatch> {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM fuel_batches WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked) throw new ResourceNotFoundError('fuel_batch_not_found');
    const batch = await tx.fuelBatch.findUniqueOrThrow({ where: { id } });
    if (batch.status !== 'draft' && batch.status !== 'rejected') throw new FuelBatchNotOpenError();
    if (!anyAuthor && batch.createdBy !== user.id) {
      throw new ForbiddenException(errorBody('record_author_forbidden', 'Only the batch’s author changes it.'));
    }
    return batch;
  }

  /** D13's rebuild by key, from the batch's assigned rows as they now stand. */
  private async rebuild(tx: Prisma.TransactionClient, user: RequestUser, batch: FuelBatch): Promise<Array<{ id: string; storagePath: string }>> {
    const rows = await tx.fuelRow.findMany({ where: { fuelBatchId: batch.id, state: 'assigned' }, select: { fuel: true, year: true, month: true, litres: true } });
    const usage = batch.usage as FuelUsage;
    const wanted = new Map<string, { fuel: FileFuel; year: number; month: number; litres: string[] }>();
    for (const r of rows) {
      const target = fuelRecordTarget(r.fuel as FileFuel, usage)!;
      const key = `${r.year}|${r.month}|${target.category}|${target.activityType}`;
      const entry = wanted.get(key) ?? { fuel: r.fuel as FileFuel, year: r.year, month: r.month, litres: [] };
      wanted.set(key, entry);
      entry.litres.push(r.litres.toFixed());
    }
    const existing = await tx.activityRecord.findMany({ where: { fuelBatchId: batch.id, status: { not: 'voided' } }, orderBy: { id: 'asc' } });
    const keyOfRecord = (r: ActivityRecord) =>
      `${r.reportingYear}|${(PERIOD_VALUES.monthly as readonly string[]).indexOf(r.periodValue) + 1}|${r.category}|${r.activityType}`;
    const files = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT l.evidence_id::text AS id FROM activity_record_evidence l
      JOIN activity_records a ON a.id = l.activity_record_id WHERE a.fuel_batch_id = ${batch.id}::uuid`;
    const periods = [
      ...existing.map(periodOf),
      ...[...wanted.values()].map((w) => ({
        subsidiaryId: batch.subsidiaryId, reportingYear: w.year, reportingPeriod: 'monthly', periodValue: PERIOD_VALUES.monthly[w.month - 1]!,
      })),
    ];
    await lockPeriodsShared(tx, periods as never);
    const locked = new Map<string, LiveRecord>();
    for (const record of existing) locked.set(record.id, await this.records.lockSeenRecord(tx, record, user.organisationId));
    // New keys first, given the batch's files, so no file loses its last link to a removed record.
    for (const [key, w] of wanted) {
      if (existing.some((r) => keyOfRecord(r) === key)) continue;
      const target = fuelRecordTarget(w.fuel, usage)!;
      const dto = Object.assign(new CreateActivityRecordDto(), {
        subsidiaryId: batch.subsidiaryId, locationId: null, reportingYear: w.year, reportingPeriod: 'monthly',
        periodValue: PERIOD_VALUES.monthly[w.month - 1], category: target.category, activityType: target.activityType,
        activityValue: Number(sumDecimals(w.litres)), activityUnit: target.units[0]!,
        ...(batch.source === 'shell' ? {} : { input: { invoice_no: batch.invoiceRef } }),
      }) as CreateActivityRecordDto;
      const prepared = await this.records.previewCreate(user, dto, { fuelBatchId: batch.id });
      let created: { id: string };
      try {
        created = await this.records.createInTransaction(tx, user, dto, prepared, { fuelBatchId: batch.id });
      } catch (error) {
        throw this.records.createRefusal(error, dto, prepared);
      }
      if (files.length) {
        await tx.activityRecordEvidence.createMany({
          data: files.map((f) => ({ activityRecordId: created.id, evidenceId: f.id, subsidiaryId: batch.subsidiaryId, linkedBy: user.id })),
        });
      }
    }
    const removed: Array<{ id: string; storagePath: string }> = [];
    for (const record of existing) {
      const w = wanted.get(keyOfRecord(record));
      if (w) {
        await this.records.updateBatchQuantityLocked(tx, user, locked.get(record.id)!, Number(sumDecimals(w.litres)));
      } else {
        removed.push(...(await this.records.removeLocked(tx, user, locked.get(record.id)!)));
      }
    }
    return removed;
  }

  private stepRefusal(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return new RecordChangedError();
    return error;
  }

  private async evidenceBlobs(files: Array<{ storagePath: string }>): Promise<void> {
    if (files.length) await this.evidence.removeBlobs(files.map((f) => f.storagePath));
  }

}

