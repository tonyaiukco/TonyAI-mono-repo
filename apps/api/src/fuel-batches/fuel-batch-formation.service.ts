import { randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ActivityRecord } from '@tonyai/db';
import {
  fuelRecordTarget,
  isFileFuel,
  isFuelHoldReason,
  mayAuthorRecords,
  PERIOD_VALUES,
  type FileFuel,
  type FormFuelBatchesResultDTO,
  type FuelHoldReason,
  type FuelSource,
  type FuelUsage,
} from '@tonyai/shared-types';
import type { RequestUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { WorkDeadline } from '../common/work-deadline';
import { readRuntimeConfig } from '../common/runtime-config';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityRecordsService } from '../activity-records/activity-records.service';
import { CreateActivityRecordDto } from '../activity-records/dto/create-activity-record.dto';
import { declareFuelBatchStep, lockPeriodsShared } from '../activity-records/lifecycle-lock';
import { CategoryNotGrantedError } from '../activity-records/record-scope';
import {
  ActivityTypeSlotConflictError,
  EntityClosedToDataEntryError,
  PeriodLockedError,
} from '../activity-records/errors';
import { SingleEntryPeriodConflictError } from '../central-reporting/central-reporting-errors';
import { FactorLibraryConflictError, NoEmissionFactorError } from '../calculations/errors';
import { sumDecimals } from '../fuel-files/decimal';
import { keepReportingCompany, reportingHeaderFor } from './batch-reporting';
import { currentReader } from '../fuel-files/current-reader';
import { usageCategory } from '../fuel-files/fuel-scope';
import { FuelUploadsService } from '../fuel-files/fuel-uploads.service';

/**
 * Batches formed by their rows' holder, in bounded steps (inc28-fuel-bulk D8,
 * C8, C9). One group — an account, an invoice reference and a usage — is one
 * transaction: under an advisory lock on (account, invoice) and the account's
 * row `FOR SHARE`, the group's ready rows join the holder's open batch of that
 * invoice and usage, or a batch with the next sequence is inserted; each
 * (fuel, month) sum becomes a record through the record service's own create
 * core, so every gate a manual record meets is met here. Any refusal rolls
 * the group back and holds its rows with the reason, in a second, small
 * transaction. A step ends at its deadline; the page calls again while rows
 * are processable.
 */

/** "TFBF": the advisory-lock namespace of an invoice's batches. */
const INVOICE_LOCK_NAMESPACE = 0x54464246;
const GROUP_TX = { timeout: 30_000, maxWait: 10_000 } as const;

interface GroupKey {
  accountId: string;
  invoiceRef: string;
  usage: FuelUsage;
}

interface LockedRow {
  id: string;
  fuel: string;
  year: number;
  month: number;
  litres: string;
  subsidiary_id: string;
}

/** A record's key within a batch (D13): its fuel and calendar month. */
const keyOf = (fuel: string, year: number, month: number) => `${fuel}|${year}|${month}`;

export class GroupHeld extends Error {
  constructor(readonly reason: FuelHoldReason) {
    super(reason);
  }
}

/** A record service refusal, as the hold reason the rows keep (D8 row 6), by class. */
export function holdReasonOf(error: unknown): FuelHoldReason {
  if (error instanceof GroupHeld) return error.reason;
  if (error instanceof NoEmissionFactorError || error instanceof FactorLibraryConflictError) return 'no_factor';
  if (error instanceof PeriodLockedError) return 'period_locked';
  if (error instanceof EntityClosedToDataEntryError) return 'entity_closed_to_data_entry';
  if (error instanceof SingleEntryPeriodConflictError) return 'single_entry_period_conflict';
  if (error instanceof CategoryNotGrantedError) return 'category_not_granted';
  if (error instanceof ActivityTypeSlotConflictError) return 'slot_holds_untyped';
  // The holder's standing: a company outside its grant, a withdrawn grant, a narrowed role.
  if (error instanceof NotFoundException || error instanceof ForbiddenException) return 'fuel_out_of_scope';
  return 'unexpected';
}

/** What a group's transaction judged: its rows and their company, for a refusal's hold. */
interface JudgedGroup {
  rowIds?: string[];
  subsidiaryId?: string | null;
}

@Injectable()
export class FuelBatchFormationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly records: ActivityRecordsService,
    private readonly uploads: FuelUploadsService,
  ) {}

  async formBatches(user: RequestUser, importId: string, options: { retryHeld?: boolean } = {}): Promise<FormFuelBatchesResultDTO> {
    const upload = await this.uploads.visibleUpload(user, importId, { asHolder: true });
    // Only the rows' holder forms their batches (C8): another user, a super_admin included, is refused.
    // A holder since made a read-only role forms nothing (WP9 PR B review, P1); the record cores refuse it again under lock.
    if (!mayAuthorRecords(user)) throw new ForbiddenException();
    if (!(await this.holdsAny(user, upload.id))) throw new ForbiddenException();

    if (options.retryHeld) {
      await this.prisma.fuelRow.updateMany({
        where: { importBatchId: upload.id, holderId: user.id, fuelBatchId: null, state: 'held' },
        data: { state: 'ready', holdReason: null },
      });
    }

    const deadline = new WorkDeadline(readRuntimeConfig().BULK_DEADLINE_MS);
    const groups = await this.prisma.$queryRaw<Array<{ account_id: string; invoice_ref: string; usage: string }>>`
      SELECT fuel_account_id::text AS account_id, invoice_ref, usage FROM fuel_rows
      WHERE import_batch_id = ${upload.id}::uuid AND holder_id = ${user.id}::uuid AND state = 'ready'
      GROUP BY fuel_account_id, invoice_ref, usage
      ORDER BY fuel_account_id, invoice_ref, usage`;

    let formedBatches = 0;
    let joinedBatches = 0;
    for (const group of groups) {
      if (deadline.expired) break;
      const key: GroupKey = { accountId: group.account_id, invoiceRef: group.invoice_ref, usage: group.usage as FuelUsage };
      const judged: JudgedGroup = {};
      try {
        const outcome = await this.formGroup(user, upload.id, upload.source as FuelSource, key, judged);
        if (outcome === 'formed') formedBatches += 1;
        if (outcome === 'joined') joinedBatches += 1;
      } catch (error) {
        await this.holdGroup(upload.id, user.id, holdReasonOf(error), judged);
      }
    }

    // The upload as the holder reads it now, after a long step: a company or
    // category withdrawn meanwhile is not counted (sixth review of the branch, P2).
    // A holder that cannot be re-read gets no scoped count, and no further step.
    const reader = await currentReader(this.prisma, user).catch(() => null);
    const summary = reader ? await this.uploads.detail(reader, upload.id) : null;
    // The holder's own held rows, by reason — as `processableRows` counts its
    // own ready rows — so a holder is told how many of its rows a step held,
    // a company outside its scope included, though the summary's row scope
    // (RLS's) no longer shows a super_admin those rows: counts and litres
    // only, no company or fuel (WP9 PR B review).
    const held = await this.prisma.$queryRaw<Array<{ reason: string; rows: number; litres: string }>>`
      SELECT hold_reason AS reason, count(*)::int AS rows, sum(litres)::text AS litres FROM fuel_rows
      WHERE import_batch_id = ${upload.id}::uuid AND holder_id = ${user.id}::uuid AND fuel_batch_id IS NULL
        AND state = 'held' AND hold_reason IS NOT NULL
      GROUP BY hold_reason ORDER BY hold_reason`;
    return {
      formedBatches,
      joinedBatches,
      processableRows: summary?.processableRows ?? 0,
      held: held.filter((h) => isFuelHoldReason(h.reason)).map((h) => ({ reason: h.reason as FuelHoldReason, rows: h.rows, litres: sumDecimals([h.litres]) })),
      waiting: summary
        ? [
            { reason: 'fuel_account_unmatched' as const, ...summary.rows.waiting_account },
            { reason: 'fuel_name_unmatched' as const, ...summary.rows.waiting_fuel },
          ].filter((w) => w.rows > 0)
        : [],
    };
  }

  private async holdsAny(user: RequestUser, importId: string): Promise<boolean> {
    return (await this.prisma.fuelRow.count({ where: { importBatchId: importId, holderId: user.id, fuelBatchId: null } })) > 0;
  }

  /** The group's rows held with the reason, in a small transaction of their own (D8). */
  private async holdGroup(importId: string, holderId: string, reason: FuelHoldReason, judged: JudgedGroup): Promise<void> {
    // A refusal before any row was read (a lock or connection timed out) judged
    // nothing: the rows stay ready for the next step (fifth review, P2).
    if (!judged.rowIds || judged.rowIds.length === 0) return;
    // Only the rows the refused transaction judged, and only while still ready
    // under the company it judged them under: a mapping changed since
    // re-stated them itself and they are not this refusal's to hold (fourth
    // review). One uuid[] parameter, so an invoice of any size is one statement
    // (fifth review: 44,902 ids as one parameter each passed PostgreSQL's
    // 32,767-parameter limit).
    await this.prisma.$executeRaw`
      UPDATE fuel_rows SET state = 'held', hold_reason = ${reason}, updated_at = now()
       WHERE id = ANY(${judged.rowIds}::uuid[]) AND import_batch_id = ${importId}::uuid AND holder_id = ${holderId}::uuid
         AND state = 'ready' AND subsidiary_id IS NOT DISTINCT FROM ${judged.subsidiaryId ?? null}::uuid`;
  }

  /** One group, whole or not at all; `judged` names the rows it judged and their company. */
  private async formGroup(
    user: RequestUser,
    importId: string,
    source: FuelSource,
    key: GroupKey,
    judged: JudgedGroup,
  ): Promise<'formed' | 'joined' | 'none'> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${INVOICE_LOCK_NAMESPACE}::int4, hashtext(${key.accountId} || '|' || ${key.invoiceRef}))`;
      const [account] = await tx.$queryRaw<Array<{ state: string; subsidiary_id: string | null }>>`
        SELECT state, subsidiary_id::text FROM fuel_accounts WHERE id = ${key.accountId}::uuid FOR SHARE`;
      const rows = await tx.$queryRaw<LockedRow[]>`
        SELECT id::text, fuel, year, month, litres::text, subsidiary_id::text FROM fuel_rows
        WHERE import_batch_id = ${importId}::uuid AND holder_id = ${user.id}::uuid AND state = 'ready'
          AND fuel_account_id = ${key.accountId}::uuid AND invoice_ref = ${key.invoiceRef} AND usage = ${key.usage}
        ORDER BY id FOR UPDATE`;
      if (rows.length === 0) return 'none';
      const subsidiaryId = rows[0]!.subsidiary_id;
      judged.rowIds = rows.map((r) => r.id);
      judged.subsidiaryId = subsidiaryId;
      // A mapping changed since the rows were stated re-stated them itself (D7); never form under an old company.
      if (account?.state !== 'confirmed' || rows.some((r) => r.subsidiary_id !== account.subsidiary_id)) return 'none';
      // B4: a company outside the holder's current scope is held, never tried.
      if (!user.accessibleSubsidiaryIds.includes(subsidiaryId)) throw new GroupHeld('fuel_out_of_scope');

      const [candidate] = await tx.$queryRaw<Array<{ id: string; status: string; reported_by_subsidiary_id: string | null }>>`
        SELECT id::text, status, reported_by_subsidiary_id::text FROM fuel_batches
        WHERE fuel_account_id = ${key.accountId}::uuid AND invoice_ref = ${key.invoiceRef}
          AND usage = ${key.usage} AND created_by = ${user.id}::uuid AND status IN ('draft', 'rejected')
        ORDER BY sequence DESC LIMIT 1 FOR UPDATE`;
      // Joined only when its records would carry the batch's reporting company:
      // a central reporter whose main company moved forms a further batch of the
      // invoice, so no batch holds records of two (TA025 fixes each; sixth review, P2).
      const open = candidate && candidate.reported_by_subsidiary_id === reportingHeaderFor(user, subsidiaryId) ? candidate : undefined;
      const batchId = open?.id ?? randomUUID();
      await declareFuelBatchStep(tx, batchId);
      if (!open) {
        const [{ next }] = await tx.$queryRaw<Array<{ next: number }>>`
          SELECT COALESCE(max(sequence), 0)::int + 1 AS next FROM fuel_batches
          WHERE fuel_account_id = ${key.accountId}::uuid AND invoice_ref = ${key.invoiceRef}`;
        await tx.fuelBatch.create({
          data: {
            id: batchId,
            organisationId: user.organisationId!,
            subsidiaryId,
            fuelAccountId: key.accountId,
            source,
            invoiceRef: key.invoiceRef,
            sequence: next!,
            usage: key.usage,
            category: usageCategory(key.usage),
            createdBy: user.id,
          },
        });
      }

      // The batch's records by key, from all its live rows: those it holds and those joining now (D13).
      const existingRows = open
        ? await tx.$queryRaw<Array<{ fuel: string; year: number; month: number; litres: string }>>`
            SELECT fuel, year, month, litres::text FROM fuel_rows WHERE fuel_batch_id = ${batchId}::uuid AND state = 'assigned'`
        : [];
      const sums = new Map<string, { fuel: FileFuel; year: number; month: number; litres: string[] }>();
      for (const row of [...existingRows, ...rows]) {
        if (!isFileFuel(row.fuel)) throw new GroupHeld('unexpected');
        const k = keyOf(row.fuel, row.year, row.month);
        const sum = sums.get(k) ?? { fuel: row.fuel, year: row.year, month: row.month, litres: [] };
        sums.set(k, sum);
        sum.litres.push(row.litres);
      }
      const existingRecords: ActivityRecord[] = open
        ? await tx.activityRecord.findMany({ where: { fuelBatchId: batchId, status: { not: 'voided' } }, orderBy: { id: 'asc' } })
        : [];
      const recordByKey = new Map(
        existingRecords.map((r) => [keyOf(fuelOfActivityType(r.activityType), r.reportingYear, monthOf(r.periodValue)), r]),
      );

      // Every period this group writes, locked shared and in sorted order BEFORE
      // any record row is locked (lifecycle-lock.ts: a writer never waits on a
      // period lock while holding a row lock). The create core takes the same
      // shared lock again for a new key; a transaction re-taking a shared
      // advisory lock it holds does not wait.
      await lockPeriodsShared(
        tx,
        [...sums.values()].map((sum) => ({
          subsidiaryId,
          reportingYear: sum.year,
          reportingPeriod: 'monthly',
          periodValue: PERIOD_VALUES.monthly[sum.month - 1]!,
        })),
      );
      // An open batch's files back every record it holds: a record this step
      // adds to it (a new fuel or month of the invoice) is given them too, as
      // the declarations' rebuild does, under the batch's row lock (WP9 PR B review, P1).
      const files = open
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT DISTINCT l.evidence_id::text AS id FROM activity_record_evidence l
            JOIN activity_records a ON a.id = l.activity_record_id
            WHERE a.fuel_batch_id = ${batchId}::uuid AND a.status <> 'voided'
            ORDER BY 1`
        : [];
      let filesLinked = 0;
      for (const [k, sum] of [...sums.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const target = fuelRecordTarget(sum.fuel, key.usage)!;
        const quantity = Number(sumDecimals(sum.litres));
        const existing = recordByKey.get(k);
        if (existing) {
          const locked = await this.records.lockSeenRecord(tx, existing, user.organisationId);
          await this.records.updateBatchQuantityLocked(tx, user, locked, quantity);
          continue;
        }
        const dto = Object.assign(new CreateActivityRecordDto(), {
          subsidiaryId,
          locationId: null,
          reportingYear: sum.year,
          reportingPeriod: 'monthly',
          periodValue: PERIOD_VALUES.monthly[sum.month - 1],
          category: target.category,
          activityType: target.activityType,
          activityValue: quantity,
          activityUnit: target.units[0]!,
          // C17: the invoice number when the source has one; Shell's half-month is not one.
          ...(source === 'shell' ? {} : { input: { invoice_no: key.invoiceRef } }),
        }) as CreateActivityRecordDto;
        const prepared = await this.records.previewCreate(user, dto, { fuelBatchId: batchId });
        let created: { id: string };
        try {
          created = await this.records.createInTransaction(tx, user, dto, prepared, { fuelBatchId: batchId });
        } catch (error) {
          throw this.records.createRefusal(error, dto, prepared);
        }
        if (files.length) {
          await tx.activityRecordEvidence.createMany({
            data: files.map((f) => ({ activityRecordId: created.id, evidenceId: f.id, subsidiaryId, linkedBy: user.id })),
          });
          filesLinked += files.length;
        }
      }

      await keepReportingCompany(tx, batchId);
      await tx.$executeRaw`
        UPDATE fuel_rows SET fuel_batch_id = ${batchId}::uuid, state = 'assigned', updated_at = now()
        WHERE id = ANY(${rows.map((r) => r.id)}::uuid[])`;
      await this.audit.record(
        user,
        {
          action: open ? 'update' : 'create',
          entity: 'fuel_batch',
          entityId: batchId,
          diff: {
            fuelBatch: {
              importId,
              accountId: key.accountId,
              invoiceRef: key.invoiceRef,
              usage: key.usage,
              rowsAdded: rows.length,
              litresAdded: sumDecimals(rows.map((r) => r.litres)),
              ...(filesLinked ? { filesLinked } : {}),
            },
          },
        },
        tx,
      );
      return open ? 'joined' : 'formed';
    }, GROUP_TX);
  }
}

/** The fuel a batch record's activity type names (D6's table, read back). */
function fuelOfActivityType(activityType: string | null): string {
  if (!activityType) return '';
  if (activityType.endsWith('diesel')) return 'diesel';
  if (activityType.endsWith('petrol')) return 'petrol';
  return activityType;
}

function monthOf(periodValue: string): number {
  return (PERIOD_VALUES.monthly as readonly string[]).indexOf(periodValue) + 1;
}

