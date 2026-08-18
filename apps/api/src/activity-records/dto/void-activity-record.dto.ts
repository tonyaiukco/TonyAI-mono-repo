import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The body of POST /activity-records/:id/void.
 *
 * The reason is REQUIRED, and that is FR §4.3 rather than politeness: a
 * withdrawal removes a figure a reviewer accepted from the reported inventory,
 * and an unexplained one is indistinguishable in the audit trail from a
 * mistake. `MinLength(10)` for the same reason `rejected` records carry a
 * mandatory note — "fix" is not an account of a restatement.
 */
export class VoidActivityRecordDto {
  @IsString()
  @MinLength(10, {
    message:
      'A void reason is required and must explain why the figure was withdrawn (at least 10 characters).',
  })
  @MaxLength(1000)
  voidReason!: string;
}
