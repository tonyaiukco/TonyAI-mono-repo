import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

/**
 * The refusals a caller has to tell apart, as CLASSES.
 *
 * Two failures that arrive as the same Nest exception used to be told apart
 * by their message — first a retyped substring, then an exported constant.
 * Both leave the coupling in the text: reword the sentence and every matcher
 * reads for words nobody produces any more, green all the way (the bulk
 * importer once reported every real duplicate as "the period is locked" that
 * way). The class is the contract; the sentence is what the user reads. The
 * bulk importer and the bulk submit branch with `instanceof` and never look
 * at `message`.
 *
 * Each extends the Nest exception it replaces, so the HTTP status, the
 * exception filter and every `toBeInstanceOf(ConflictException)` keep
 * working. The sentences stay exported because the web mirrors some of them
 * (`apps/web/lib/bulk-submit-view.ts`, the Data Entry page) and the e2e suite
 * asserts them — they are user-facing copy, not a matching key.
 */
export const DUPLICATE_RECORD_MESSAGE =
  'An activity record already exists for this reporting entity, period and category.';
const CREATE_ROLE_REFUSAL = 'Your role may not create activity records';
export const SUBMIT_ROLE_REFUSAL = 'Your role may not submit activity records';
export const RESUBMIT_AUTHOR_REFUSAL =
  'You may only resubmit activity records you created';
export const SUBMIT_AUTHOR_REFUSAL =
  'You may only submit activity records you created';
export const SELF_APPROVAL_REFUSAL =
  'You created this record, so someone else must approve it.';
export const RECORD_CHANGED_MESSAGE =
  'This record was changed by someone else while your request was in progress. Reload it and try again.';
export const EVIDENCE_REFUSAL_FRAGMENT =
  'requires at least one evidence file before submitting';
export const VARIANCE_REFUSAL =
  'This value deviates significantly from the historical average — add a variance comment before submitting.';

/** The uniqueness index refused the slot: one record per entity, period and category. */
export class DuplicateActivityRecordError extends ConflictException {
  constructor() {
    super(DUPLICATE_RECORD_MESSAGE);
  }
}

/** The period is locked; the sentence names which. */
export class PeriodLockedError extends ConflictException {
  constructor(message: string) {
    super(message);
  }
}

/** The caller's role may not author records — one 403 for the whole request. */
export class CreateRoleRefusedError extends ForbiddenException {
  constructor() {
    super(CREATE_ROLE_REFUSAL);
  }
}

/** The caller's role may not submit — one 403 for the whole request, never a per-record row. */
export class SubmitRoleRefusedError extends ForbiddenException {
  constructor() {
    super(SUBMIT_ROLE_REFUSAL);
  }
}

/**
 * Only a record's author submits it — a draft (decision D02, 2026-09-29) or a
 * rejected record — per record, so a batch keeps going. `super_admin` is not
 * exempt: submitting is the author's statement that the figure is ready, and
 * because no one else can make it, the submitter IS the creator, which is what
 * lets the approval gate (D01) compare against `createdBy` alone.
 */
export class SubmitAuthorRefusedError extends ForbiddenException {
  constructor(resubmission: boolean) {
    super(resubmission ? RESUBMIT_AUTHOR_REFUSAL : SUBMIT_AUTHOR_REFUSAL);
  }
}

/**
 * Segregation of duties (decision D01, 2026-09-29): the approver is neither the
 * record's creator nor its submitter, `super_admin` included. One comparison
 * covers both because only the author may submit (`SubmitAuthorRefusedError`).
 */
export class SelfApprovalRefusedError extends ForbiddenException {
  constructor() {
    super(SELF_APPROVAL_REFUSAL);
  }
}

/**
 * The lifecycle protocol's lost-race answer (`lifecycle-lock.ts`): the request
 * was valid against the record it read, but someone else changed the record
 * before this request could lock it, and against the record as it is now the
 * request no longer holds. Reload and decide again; nothing was written.
 */
export class RecordChangedError extends ConflictException {
  constructor() {
    super(RECORD_CHANGED_MESSAGE);
  }
}

/** An evidence-required category with no file attached yet. */
export class EvidenceRequiredError extends BadRequestException {
  constructor(category: string) {
    super(`Category "${category}" ${EVIDENCE_REFUSAL_FRAGMENT}.`);
  }
}

/** An anomalous figure with no variance reason. */
export class VarianceReasonRequiredError extends BadRequestException {
  constructor() {
    super(VARIANCE_REFUSAL);
  }
}
