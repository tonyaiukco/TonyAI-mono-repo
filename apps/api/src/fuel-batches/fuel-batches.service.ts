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
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { errorBody, ResourceNotFoundError } from '../common/api-error';
import { actorDisplayName, resolveProfiles } from '../common/resolve-profiles';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityRecordsService } from '../activity-records/activity-records.service';
import { declareFuelBatchStep, lockPeriodsShared, periodOf } from '../activity-records/lifecycle-lock';
import { RecordChangedError } from '../activity-records/errors';
import { grantedCategories } from '../activity-records/record-scope';
import { approversFor, awaitingDecisionWhere } from '../activity-records/record-approver';
import { sumDecimals } from '../fuel-files/decimal';
import { fuelBatchVerdicts } from './fuel-batch-anomaly';

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
const LIST_LIMIT = 200;

type LiveRecord = ActivityRecord & { location: { name: string } | null };

export class FuelBatchNotOpenError extends ConflictException {
  constructor() {
    super(errorBody('fuel_batch_not_open', 'This batch is no longer a draft or returned, so it cannot be changed.'));
  }
}

/** The batches a reader may read (D14): the organisation, a granted company, a standard user's category or own batch. */
export function fuelBatchScopeWhere(user: RequestUser): Prisma.FuelBatchWhereInput {
  const organisation: Prisma.FuelBatchWhereInput = { organisationId: user.organisationId ?? '00000000-0000-0000-0000-000000000000' };
  if (can(user.role, 'scope.organisation')) return organisation;
  const companies = user.accessibleSubsidiaryIds;
  if (!can(user.role, 'scope.categories')) return { ...organisation, subsidiaryId: { in: companies } };
  const byGrant: Prisma.FuelBatchWhereInput[] = companies
    .map((subsidiaryId) => ({ subsidiaryId, category: { in: grantedCategories(user, subsidiaryId) } }))
    .filter((w) => (w.category.in as string[]).length > 0);
  return { ...organisation, OR: [...byGrant, { createdBy: user.id, subsidiaryId: { in: companies } }] };
}

@Injectable()
export class FuelBatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly records: ActivityRecordsService,
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
    const where = await this.filterWhere(user, filters);
    if (where === null) return [];
    const reviewOrder = filters.awaitingMyDecision || filters.status === 'submitted' || filters.status === 'under_review';
    const batches = await this.prisma.fuelBatch.findMany({
      where,
      orderBy: reviewOrder ? [{ submittedAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
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
          litres: String(r.activityValue),
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
        litres: r.litres.toString(),
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
    const reporting = [...new Set(recordSums.map((r) => r.reportedBySubsidiaryId).filter((id): id is string => !!id))];
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
      const reportedBy = records.find((r) => r.reportedBySubsidiaryId && r.reportedBySubsidiaryId !== b.subsidiaryId)?.reportedBySubsidiaryId ?? null;
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
   * one audit row. Answers the batch as it is now.
   */
  private async step(
    user: RequestUser,
    id: string,
    action: 'submit' | 'recall' | 'review' | 'approve' | 'reject',
    gate: (batch: FuelBatch) => void,
    perRecord: (tx: Prisma.TransactionClient, seen: ActivityRecord, current: LiveRecord, batch: FuelBatch) => Promise<unknown>,
    after: (batch: FuelBatch) => Prisma.FuelBatchUpdateInput,
    prepare?: (records: ActivityRecord[]) => Promise<void>,
  ): Promise<FuelBatchDetailDTO> {
    const seenBatch = await this.visible(user, id);
    const seenRecords = await this.prisma.activityRecord.findMany({ where: { fuelBatchId: id, status: { not: 'voided' } }, orderBy: { id: 'asc' } });
    if (prepare) await prepare(seenRecords);
    try {
      await this.prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM fuel_batches WHERE id = ${id}::uuid FOR UPDATE`;
        if (!locked) throw new ResourceNotFoundError('fuel_batch_not_found');
        const batch = await tx.fuelBatch.findUniqueOrThrow({ where: { id } });
        if (batch.status !== seenBatch.status || batch.submissionCount !== seenBatch.submissionCount) throw new RecordChangedError();
        gate(batch);
        await declareFuelBatchStep(tx, id);
        await lockPeriodsShared(tx, seenRecords.map(periodOf));
        const now = await tx.activityRecord.findMany({ where: { fuelBatchId: id, status: { not: 'voided' } }, select: { id: true }, orderBy: { id: 'asc' } });
        // A record added or removed since the read: the caller acts on a batch it did not see.
        if (now.map((r) => r.id).join() !== seenRecords.map((r) => r.id).join()) throw new RecordChangedError();
        for (const seen of seenRecords) {
          const current = await this.records.lockSeenRecord(tx, seen, user.organisationId);
          await perRecord(tx, seen, current, batch);
        }
        const updated = await tx.fuelBatch.update({ where: { id }, data: after(batch) });
        await this.audit.record(
          user,
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
    return this.detail(user, id);
  }

  /** A decision names the batch's submission its reviewer saw; a review may name none (D9). */
  private assertSubmission(batch: FuelBatch, seenSubmittedAt: string | null | undefined, required: boolean): void {
    if (seenSubmittedAt === undefined) {
      if (required) throw new RecordChangedError();
      return;
    }
    const seen = seenSubmittedAt === null ? null : Date.parse(seenSubmittedAt);
    if (seen !== (batch.submittedAt?.getTime() ?? null)) throw new RecordChangedError();
  }

  async submit(user: RequestUser, id: string, varianceReason?: string): Promise<FuelBatchDetailDTO> {
    const recomputed = new Map<string, Awaited<ReturnType<ActivityRecordsService['recomputeFor']>>>();
    let verdicts: Awaited<ReturnType<typeof fuelBatchVerdicts>> = {};
    return this.step(
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
    return this.step(
      user, id, 'recall',
      (batch) => {
        if (batch.status !== 'submitted') throw new ConflictException(errorBody('record_changed', 'Only a submitted batch nobody has opened can be recalled.'));
      },
      (tx, seen, current) => this.records.recallLocked(tx, user, seen, current),
      () => ({ status: 'draft', submittedAt: null }),
    );
  }

  async startReview(user: RequestUser, id: string, seenSubmittedAt?: string | null): Promise<FuelBatchDetailDTO> {
    if (!can(user.role, 'record.decide')) throw new ForbiddenException();
    return this.step(
      user, id, 'review',
      (batch) => this.assertSubmission(batch, seenSubmittedAt, false),
      (tx, seen, current) => this.records.startReviewLocked(tx, user, seen, current, current.submittedAt?.toISOString() ?? null),
      () => ({ status: 'under_review', reviewedBy: user.id, reviewedAt: new Date() }),
    );
  }

  async approve(user: RequestUser, id: string, seenSubmittedAt?: string | null): Promise<FuelBatchDetailDTO> {
    if (!can(user.role, 'record.decide')) throw new ForbiddenException();
    const recomputed = new Map<string, Awaited<ReturnType<ActivityRecordsService['recomputeFor']>>>();
    return this.step(
      user, id, 'approve',
      (batch) => this.assertSubmission(batch, seenSubmittedAt, true),
      (tx, seen, current) =>
        this.records.approveLocked(tx, user, seen, current, current.submittedAt?.toISOString() ?? null, recomputed.get(seen.id)!),
      () => ({ status: 'approved', reviewedBy: user.id, reviewedAt: new Date(), reviewNote: null }),
      async (records) => {
        for (const r of records) recomputed.set(r.id, await this.records.recomputeFor(user, r));
      },
    );
  }

  async reject(user: RequestUser, id: string, reason: string, seenSubmittedAt?: string | null): Promise<FuelBatchDetailDTO> {
    if (!can(user.role, 'record.decide')) throw new ForbiddenException();
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new BadRequestException(errorBody('validation_failed', 'A return needs a reason.'));
    }
    return this.step(
      user, id, 'reject',
      (batch) => this.assertSubmission(batch, seenSubmittedAt, true),
      (tx, seen, current) => this.records.rejectLocked(tx, user, seen, current, reason, current.submittedAt?.toISOString() ?? null),
      () => ({ status: 'rejected', reviewedBy: user.id, reviewedAt: new Date(), reviewNote: reason }),
    );
  }

  /** `POST /fuel-batches/bulk-submit`: each batch its own step; each refusal named. */
  async bulkSubmit(user: RequestUser, batchIds: readonly string[]): Promise<{ submitted: string[]; failed: Array<{ batchId: string; code: string }> }> {
    const submitted: string[] = [];
    const failed: Array<{ batchId: string; code: string }> = [];
    for (const batchId of [...new Set(batchIds)]) {
      try {
        await this.submit(user, batchId);
        submitted.push(batchId);
      } catch (error) {
        const body = (error as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
        failed.push({ batchId, code: body?.code ?? 'unexpected' });
      }
    }
    return { submitted, failed };
  }
}

