import { ConflictException } from '@nestjs/common';
import { Prisma } from '@tonyai/db';
import { errorBody } from '../common/api-error';

/*
 * LP3-04's write path (W1; Decisions 2026-10-15 (fifth) E3, E4, E7, E8): the
 * refusals a boundary screen words on its own. The service checks each rule
 * before it writes — a frozen version under the header's row lock, the body
 * through the DTOs — so the guard's TA014 is a backstop: one that still
 * reaches the service is a defect, answered `internal_error` and logged,
 * never mapped to `boundary_frozen` (E7).
 */

export const BOUNDARY_FROZEN_MESSAGE =
  'This inventory boundary version is frozen and can no longer change. Copy it into a new version to make changes.';

/** A write to a frozen version, re-confirming a confirmed one included (W10). */
export class BoundaryFrozenError extends ConflictException {
  constructor() {
    super(errorBody('boundary_frozen', BOUNDARY_FROZEN_MESSAGE));
  }
}

export const BOUNDARY_DRAFT_OPEN_MESSAGE =
  "An open version of this year's inventory boundary already exists. Edit or delete it before starting another.";

/** A create while the year's newest version is open (E4). */
export class BoundaryDraftOpenError extends ConflictException {
  constructor() {
    super(errorBody('boundary_draft_open', BOUNDARY_DRAFT_OPEN_MESSAGE));
  }
}

export const BOUNDARY_CONFIRM_REQUIRES_COPY_MESSAGE =
  'This version was captured into a report without being confirmed, so it can no longer change. Copy it into a new version and confirm that one.';

/** Confirming a version that froze unconfirmed when a dataset captured it
 * (PR B's (4a), (6)). */
export class BoundaryConfirmRequiresCopyError extends ConflictException {
  constructor() {
    super(errorBody('boundary_confirm_requires_copy', BOUNDARY_CONFIRM_REQUIRES_COPY_MESSAGE));
  }
}

export const BOUNDARY_INCOMPLETE_MESSAGE =
  'This version cannot be confirmed yet: it declares no subsidiary, or it still has undetermined decisions, unsupported sources or sources outside their cells. Resolve the listed gaps first.';

/** Confirming an empty version, or one with `boundaryGaps` (E3). No params:
 * the screen reads the gaps from the version itself. */
export class BoundaryIncompleteError extends ConflictException {
  constructor() {
    super(errorBody('boundary_incomplete', BOUNDARY_INCOMPLETE_MESSAGE));
  }
}

/**
 * Did the inventory boundary's guard refuse this write (SQLSTATE TA014)? A
 * frozen version took a change, or a subsidiary or site it declares was being
 * deleted (W9). Prisma 6 reports a trigger's RAISE on a model query as an
 * unknown request error whose message carries the PostgreSQL code, and on a
 * raw query as P2010 with the code in `meta` (as `recordTriggerCode`).
 */
export function boundaryGuardRefused(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2010') {
    return (e.meta as { code?: unknown } | undefined)?.code === 'TA014';
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    // Anchored on the engine's own framing, so text inside the message cannot
    // be read as a code.
    return /PostgresError \{ code: "TA014"/.test(e.message);
  }
  return false;
}
