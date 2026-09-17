import {
  BadRequestException,
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
  mayWriteActivityRecords,
  periodOrdinal,
} from '../activity-records/activity-records.service';
import {
  EvidenceRequiredError,
  PeriodLockedError,
  ResubmitAuthorRefusedError,
  SUBMIT_ROLE_REFUSAL,
  SubmitRoleRefusedError,
  VarianceReasonRequiredError,
} from '../activity-records/errors';
import { AuditService } from '../audit/audit.service';
import { BatchFailureLog } from '../common/batch-failure-log';
import type { RequestUser } from '../auth/auth.types';
import { canonicalUuid } from '../common/canonical-uuid';
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
    // Canonical FIRST, then de-duplicated, because everything downstream
    // compares ids as strings. A uuid has more than one spelling and the
    // database returns exactly one (`canonicalUuid` carries the measured
    // grammar), and `UUID_SHAPE` is case-insensitive — so `[id, ID]` is ONE
    // record the DTO accepts as two. Keyed raw that cost three things: the
    // pre-flight keys the rows Prisma returns, which are canonical, so an
    // uppercase id matched none of them and the caller was told their OWN
    // draft "does not exist, or it is not yours"; the `Set` kept both
    // spellings, so that id was reported as `not_found` against its own
    // success a moment earlier; and the inflated `requested` reached the
    // append-only batch row, which is the one number an auditor cannot go
    // back and correct. Rewriting the INPUT rather than each reader is what
    // keeps that list closed — a reader added later cannot forget to do it,
    // and it is where the import canonicalises its own id cells.
    //
    // `?? id` cannot fire on a validated request, and that is measured, not
    // assumed: `UUID_SHAPE` admits exactly `[0-9a-fA-F]` at the 32 nibbles
    // and `-` at the four separators, and `canonicalUuid` folds every string
    // in that language. It is here so a STRING arriving by some other path is
    // keyed as written rather than dropped. It is not a type guard — a
    // non-string id throws here rather than reaching Prisma, which the global
    // pipe makes unreachable over HTTP, and this service has no other caller.
    //
    // De-duplicated at all, or `[a, a]` reports `a` as `not_submittable`
    // against its own success a moment earlier — a failure the caller caused
    // by sending a list, not a fact about their data.
    const requestedIds = [
      ...new Set(dto.recordIds.map((id) => canonicalUuid(id) ?? id)),
    ];

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
        received: dto.recordIds.length,
      });
      throw new SubmitRoleRefusedError();
    }

    const submitted: BulkSubmitAcceptedRecord[] = [];
    const failed: BulkSubmitIssue[] = [];
    // Batch-scoped, never a field: see `BatchFailureLog`. One log line for the
    // whole call instead of one per record that fails unexpectedly.
    const unexpected = new BatchFailureLog('record');
    const { eligible, rejected } = await this.preflight(user, requestedIds);
    failed.push(...rejected);

    // In a `finally`, because `toIssue` rethrows a role refusal: without it a
    // batch that ended on one would take every unexpected failure before it
    // out of the log, silently.
    try {
      for (const candidate of eligible) {
        try {
          submitted.push(
            this.acceptedFrom(await this.records.submit(user, candidate.id)),
          );
        } catch (error) {
          failed.push(this.toIssue(candidate.id, error, unexpected));
        }
      }
    } finally {
      const failures = unexpected.entry();
      if (failures) {
        this.logger.error(`bulk submit: ${failures.message}`, failures.trace);
      }
    }

    await this.recordBatch(user, {
      requested: requestedIds.length,
      // What the caller actually typed, beside what it resolved to. The two
      // differ only when ids were repeated or respelled, and `requested`
      // alone can no longer tell one id from a thousand spellings of it —
      // a distinction an append-only row cannot be given back later.
      received: dto.recordIds.length,
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
        action: 'bulk_submit',
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
   * One issue per record, classified by the exception's CLASS.
   *
   * A role refusal is one 403 for the whole request — a role cannot change
   * mid-batch — so it is re-thrown; an author refusal is per record. Both used
   * to arrive as `ForbiddenException` and were told apart by comparing against
   * the thrower's exported sentence; now each is its own class and no sentence
   * is read here.
   */
  private toIssue(
    recordId: string,
    error: unknown,
    unexpected: BatchFailureLog,
  ): BulkSubmitIssue {
    // By CLASS, never by sentence (see `activity-records/errors.ts`). The
    // typed refusals first; then the plain Nest classes `submit` still raises
    // for a status it cannot move or an id it cannot see; everything else —
    // including a `ForbiddenException` or `ConflictException` nobody typed —
    // is unexpected and is logged as such.
    if (error instanceof SubmitRoleRefusedError) throw error;
    if (error instanceof ResubmitAuthorRefusedError) {
      return { recordId, code: 'not_author', message: error.message };
    }
    if (error instanceof PeriodLockedError) {
      return { recordId, code: 'period_locked', message: error.message };
    }
    if (error instanceof EvidenceRequiredError) {
      return {
        recordId,
        code: 'evidence_required',
        message: this.messageOf(error),
      };
    }
    if (error instanceof VarianceReasonRequiredError) {
      return {
        recordId,
        code: 'variance_reason_required',
        message: this.messageOf(error),
      };
    }
    if (error instanceof NotFoundException) {
      return {
        recordId,
        code: 'not_found',
        message: 'This record does not exist, or it is not yours.',
      };
    }
    if (error instanceof BadRequestException) {
      return {
        recordId,
        code: 'not_submittable',
        message: this.messageOf(error),
      };
    }
    return this.unexpected(recordId, error, unexpected);
  }

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
