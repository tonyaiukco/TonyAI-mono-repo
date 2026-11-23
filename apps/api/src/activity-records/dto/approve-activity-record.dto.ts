import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Body of POST /api/v1/activity-records/:id/approve — mirrors ApproveInput in
 * @tonyai/shared-types (BUG-R2-03 review). `seenSubmittedAt` is REQUIRED over
 * HTTP: the controller refuses its absence as `record_changed`, so an old
 * client is told to reload (validation alone would answer an unworded 400).
 * It is `@IsOptional` here only so that absence reaches that refusal.
 */
export class ApproveActivityRecordDto {
  // The record's `submittedAt` as the reviewer saw it; a record recalled and
  // resubmitted since then is refused as `record_changed`.
  @IsOptional()
  @IsISO8601({ strict: true })
  seenSubmittedAt?: string | null;
}

/**
 * Body of POST /api/v1/activity-records/:id/review — mirrors StartReviewInput
 * in @tonyai/shared-types (self-gen-form). `seenSubmittedAt` is optional here:
 * named, a record resubmitted since is refused as `record_changed`; absent,
 * nothing is compared, since taking a record into review decides nothing.
 */
export class StartReviewActivityRecordDto {
  @IsOptional()
  @IsISO8601({ strict: true })
  seenSubmittedAt?: string | null;
}
