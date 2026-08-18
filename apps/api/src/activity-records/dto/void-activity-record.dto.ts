import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The body of POST /api/v1/activity-records/:id/void.
 * Mirrors `VoidInput` in `@tonyai/shared-types`.
 *
 * The reason is REQUIRED, and that is FR §4.3 rather than politeness: a
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
 */
export class VoidActivityRecordDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10, {
    message:
      'A void reason is required and must explain why the figure was withdrawn (at least 10 characters).',
  })
  @MaxLength(2000)
  voidReason!: string;
}
