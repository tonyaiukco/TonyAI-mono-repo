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

/** A rejected record may only be resubmitted by its author — per record, so a batch keeps going. */
export class ResubmitAuthorRefusedError extends ForbiddenException {
  constructor() {
    super(RESUBMIT_AUTHOR_REFUSAL);
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
