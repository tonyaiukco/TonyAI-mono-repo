import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  VOID_REASON_MAX_LENGTH,
  VOID_REASON_MIN_LENGTH,
} from '@tonyai/shared-types';

/**
 * The body of POST /api/v1/activity-records/:id/void.
 * Mirrors `VoidInput` in `@tonyai/shared-types`.
 *
 * The reason is REQUIRED, and that is a compliance control rather than politeness: a
 * withdrawal removes a figure a reviewer accepted from the reported inventory,
 * and an unexplained one is indistinguishable in the audit trail from a
 * mistake. `MinLength(10)` for the same reason a rejection carries a mandatory
 * note — "fix" is not an account of a restatement.
 *
 * Trimmed BEFORE the length check, exactly as the reject DTO is. Without it
 * ten spaces satisfied `MinLength(10)`, and the consequence here is worse than
 * a blank reviewer's note: `voided` is terminal and `audit_log` is append-only,
 * so a blank justification lands in BOTH and neither copy can ever be
 * corrected through the product. This runs on the server because a compliance
 * control cannot live in the browser's disabled-button logic — curl bypasses
 * that entirely.
 *
 * The bounds come from `@tonyai/shared-types` so this and the browser cannot
 * hold different numbers — see the note on those constants for the mutation
 * that proved two independent literals were not enough.
 */
export class VoidActivityRecordDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(VOID_REASON_MIN_LENGTH, {
    message:
      `A void reason is required and must explain why the figure was withdrawn (at least ${VOID_REASON_MIN_LENGTH} characters).`,
  })
  @MaxLength(VOID_REASON_MAX_LENGTH)
  voidReason!: string;
}
