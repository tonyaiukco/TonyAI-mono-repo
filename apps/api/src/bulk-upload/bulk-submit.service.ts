import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ActivityRecordStatus } from '@tonyai/db';
import {
  acceptsBulkSubmit,
  isCalculated,
  type ActivityRecordDTO,
  type BulkSubmitAcceptedRecord,
  type BulkSubmitIssue,
  type BulkSubmitReportDTO,
} from '@tonyai/shared-types';
import {
  ActivityRecordsService,
  EVIDENCE_REFUSAL_FRAGMENT,
  mayWriteActivityRecords,
  periodOrdinal,
  RESUBMIT_AUTHOR_REFUSAL,
  SUBMIT_ROLE_REFUSAL,
  VARIANCE_REFUSAL,
} from '../activity-records/activity-records.service';
import { AuditService } from '../audit/audit.service';
import { BatchFailureLog } from '../common/batch-failure-log';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { BulkSubmitActivityRecordsDto } from './dto/bulk-submit-activity-records.dto';

/** What the pre-flight needs to decide whether an id is worth submitting. */
type Candidate = {
  id: string;
  status: ActivityRecordStatus;
  createdBy: string;
  reportingYear: number;
  reportingPeriod: string;
  periodValue: string;
};

@Injectable()
export class BulkSubmitService {
  private readonly logger = new Logger(BulkSubmitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly records: ActivityRecordsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Send many drafts for review at once.
   *
   * One record at a time through `ActivityRecordsService.submit`, never a bulk
   * status update: every precondition that method enforces — the tenant scope,
   * the status gate, the author gate on a resubmission, the period lock, the
   * evidence requirement, and the anomaly verdict it RECOMPUTES — has to run
   * for each record, and each gets its own audit row. A `updateMany` would
   * write past all of them.
   *
   * **No dry run**, and not because the failures are all predictable — three
   * of the six are, not five: the anomaly refusal is not, because `submit`
   * recomputes the verdict. The reason is that a preview COULD NOT BE
   * FAITHFUL. `submitted` is in `COUNTED_STATUSES`, so record N's write enters
   * record N+1's baseline; a run that wrote nothing would green-light records
   * the real one then refuses. A preview that is wrong about the one failure
   * the batch itself creates is worse than no preview.
   *
   * What the act needs is a confirmation, and it needs one badly: there is no
   * author-side unsubmit anywhere in this API. Only a reviewer can send a
   * record back.
   *
   * **No transaction spans the batch**, so a failure part-way leaves the
   * earlier records submitted. The report lists them individually for the same
   * reason the import's does.
   */
  async submitMany(
    user: RequestUser,
    dto: BulkSubmitActivityRecordsDto,
  ): Promise<BulkSubmitReportDTO> {
    // De-duplicated first, or `[a, a]` reports `a` as `not_submittable`
    // against its own success a moment earlier — a failure the caller caused
    // by sending a list, not a fact about their data.
    const requestedIds = [...new Set(dto.recordIds)];

    // Once, before anything. A role cannot change mid-batch, so a thousand
    // identical entries would be a worse answer than one 403 — and the
    // per-record check inside `submit` still runs, so this is the loop's
    // reading of the rule, not the rule. Audited on the way out, because a
    // seat probing the write surface is the interaction most worth keeping.
    if (!mayWriteActivityRecords(user)) {
      await this.recordBatch(user, {
        refused: true,
        reason: SUBMIT_ROLE_REFUSAL,
        requested: requestedIds.length,
      });
      throw new ForbiddenException(SUBMIT_ROLE_REFUSAL);
    }

    const submitted: BulkSubmitAcceptedRecord[] = [];
    const failed: BulkSubmitIssue[] = [];
    // Batch-scoped, never a field: see `BatchFailureLog`. One log line for the
    // whole call instead of one per record that fails unexpectedly.
    const unexpected = new BatchFailureLog('record');
    const { eligible, rejected } = await this.preflight(user, requestedIds);
    failed.push(...rejected);

    for (const candidate of eligible) {
      try {
        submitted.push(
          this.acceptedFrom(await this.records.submit(user, candidate.id)),
        );
      } catch (error) {
        failed.push(this.toIssue(candidate.id, error, unexpected));
      }
    }

    const failures = unexpected.entry();
    if (failures) {
      this.logger.error(`bulk submit: ${failures.message}`, failures.trace);
    }

    await this.recordBatch(user, {
      requested: requestedIds.length,
      submittedCount: submitted.length,
      failedCount: failed.length,
      // The ids, so an auditor can tie this row to the per-record rows it
      // summarises. They are the caller's own record ids — no personal data.
      recordIds: submitted.map((r) => r.recordId),
    });

    return { requested: requestedIds.length, submitted, failed };
  }

  /**
   * One query that decides which ids are worth handing to `submit`, and in
   * what order.
   *
   * A filter, never the control — `submit` re-checks every one of these, and
   * `loadScoped` is still the tenant boundary. What it adds is three things
   * the per-record path cannot give a BATCH:
   *
   * 1. **The author gate this route needs and `submit` does not have.** That
   *    method gates only a resubmission, so a draft is submittable by any
   *    colleague who can see the subsidiary. At one click that is a curiosity;
   *    at a thousand ids it is a way to sweep someone's half-finished month
   *    into review, where they can no longer edit it.
   * 2. **`draft` only.** A `rejected` record reverses a reviewer's decision,
   *    and this route is not a mass-reversal endpoint.
   * 3. **A deterministic order.** `submitted` is in `COUNTED_STATUSES`, so
   *    record N's write enters record N+1's anomaly baseline — the verdict is
   *    order-dependent WITHIN one batch, and the order was whatever the client
   *    put in its array. Sorted chronologically the gate is strongest and the
   *    outcome is reproducible; December-first would have evaluated December
   *    against no priors at all and stored `anomalyFlag: false` for it.
   */
  private async preflight(
    user: RequestUser,
    requestedIds: string[],
  ): Promise<{ eligible: Candidate[]; rejected: BulkSubmitIssue[] }> {
    const rows = (await this.prisma.activityRecord.findMany({
      where: {
        id: { in: requestedIds },
        // Mirrors `loadScoped`, so an inaccessible id is indistinguishable
        // from an absent one here exactly as it is there.
        subsidiaryId: { in: user.accessibleSubsidiaryIds },
      },
      select: {
        id: true,
        status: true,
        createdBy: true,
        reportingYear: true,
        reportingPeriod: true,
        periodValue: true,
      },
    })) as Candidate[];

    const byId = new Map(rows.map((r) => [r.id, r]));
    const eligible: Candidate[] = [];
    const rejected: BulkSubmitIssue[] = [];

    for (const id of requestedIds) {
      const row = byId.get(id);
      if (!row) {
        rejected.push({
          recordId: id,
          code: 'not_found',
          message: 'This record does not exist, or it is not yours.',
        });
        continue;
      }
      // The shared predicate, so the checkbox the client offers and the gate
      // that answers it cannot drift apart.
      if (!acceptsBulkSubmit(row.status)) {
        rejected.push({
          recordId: id,
          code: 'not_submittable',
          message: `Only a draft can be submitted in bulk (this one is "${row.status}").`,
        });
        continue;
      }
      if (user.role !== 'super_admin' && row.createdBy !== user.id) {
        rejected.push({
          recordId: id,
          code: 'not_author',
          message: 'Someone else created this record.',
        });
        continue;
      }
      eligible.push(row);
    }

    eligible.sort(
      (a, b) =>
        a.reportingYear - b.reportingYear ||
        periodOrdinal(a.reportingPeriod, a.periodValue) -
          periodOrdinal(b.reportingPeriod, b.periodValue),
    );
    return { eligible, rejected };
  }

  /**
   * The batch row.
   *
   * Written on every outcome — a clean run, a partial one, a batch where every
   * id failed, and a request refused outright for the caller's role. The
   * import learned that one the hard way: its batch row used to be written
   * only after the loop, so the event most worth keeping left no trace.
   *
   * Caught rather than propagated once records have moved: by then they are
   * submitted with their own audit rows, and a 500 with no report is a partial
   * application nobody can enumerate.
   */
  private async recordBatch(
    user: RequestUser,
    diff: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.audit.record(user, {
        action: 'submit',
        entity: 'activity_record',
        // No single entity — the report rows set this precedent.
        entityId: null,
        diff: { bulk: true, ...diff },
      });
    } catch (error) {
      this.logger.error(
        'bulk submit batch audit row failed to write',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private acceptedFrom(record: ActivityRecordDTO): BulkSubmitAcceptedRecord {
    return {
      recordId: record.id,
      subsidiaryId: record.subsidiaryId,
      locationId: record.locationId,
      reportingYear: record.reportingYear,
      reportingPeriod: record.reportingPeriod,
      periodValue: record.periodValue,
      category: record.category,
      // `null`, never 0: a category tracked but not calculated has no figure,
      // and 0 is a reported quantity.
      tCo2e: isCalculated(record.calculation) ? record.calculation.tCo2e : null,
      // The verdict as re-derived by `submit`, not the one the import stamped.
      anomalous: record.anomalyFlag,
    };
  }

  /**
   * Map what `submit` threw onto a per-record code.
   *
   * The two `ForbiddenException`s are told apart by comparing against the
   * thrower's own exported constants, never a retyped substring — a role
   * refusal is one 403 for the request and an author refusal is one record, so
   * conflating them would either abort a batch on someone else's rejected row
   * or report a role problem a thousand times.
   *
   * The `BadRequestException`s are discriminated the same way — against the
   * fragments the thrower builds its sentences from — because getting it wrong
   * tells a user their evidence is missing when their period is closed.
   */
  private toIssue(
    recordId: string,
    error: unknown,
    unexpected: BatchFailureLog,
  ): BulkSubmitIssue {
    if (error instanceof NotFoundException) {
      return {
        recordId,
        code: 'not_found',
        message: 'This record does not exist, or it is not yours.',
      };
    }
    if (error instanceof ForbiddenException) {
      // The role refusal cannot reach here — it is checked before the loop —
      // but if a future change lets it through, reporting it as an authorship
      // problem would send the user looking for the wrong thing.
      if (error.message === SUBMIT_ROLE_REFUSAL) throw error;
      // Matched, not assumed. "Anything that is not X is Y" is the shape that
      // goes wrong silently: a Forbidden from somewhere else in the graph
      // would tell a user they do not own a record they wrote.
      if (error.message === RESUBMIT_AUTHOR_REFUSAL) {
        return { recordId, code: 'not_author', message: RESUBMIT_AUTHOR_REFUSAL };
      }
      return this.unexpected(recordId, error, unexpected);
    }
    if (error instanceof ConflictException) {
      // The only Conflict `submit` raises is the period lock; anything else
      // reaching here is something this mapper has not been taught.
      if (error.message.toLowerCase().includes('is locked')) {
        return { recordId, code: 'period_locked', message: error.message };
      }
      return this.unexpected(recordId, error, unexpected);
    }
    if (error instanceof BadRequestException) {
      // Against the thrower's own exported constants, never a retyped
      // substring. The evidence sentence interpolates the category, so the
      // stable fragment is what both sides share; the anomaly one interpolates
      // nothing and is compared whole.
      const message = this.messageOf(error);
      if (message.includes(EVIDENCE_REFUSAL_FRAGMENT)) {
        return { recordId, code: 'evidence_required', message };
      }
      if (message === VARIANCE_REFUSAL) {
        return { recordId, code: 'variance_reason_required', message };
      }
      return { recordId, code: 'not_submittable', message };
    }
    return this.unexpected(recordId, error, unexpected);
  }

  /** Never the raw error text — it can carry a query, a path or a column. */
  private unexpected(
    recordId: string,
    error: unknown,
    log: BatchFailureLog,
  ): BulkSubmitIssue {
    log.add(recordId, error);
    return {
      recordId,
      code: 'unexpected',
      message: 'This record could not be submitted. Its status is unchanged.',
    };
  }

  private messageOf(error: BadRequestException): string {
    const response = error.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : ((response as { message?: string | string[] }).message ??
          error.message);
    return Array.isArray(message) ? message.join('; ') : String(message);
  }
}
