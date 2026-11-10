import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Body of POST /api/v1/activity-records/:id/approve — mirrors ApproveInput in
 * @tonyai/shared-types (BUG-R2-03 review). Optional throughout: an approve with
 * no body still works, and the review screen sends what the reviewer saw.
 */
export class ApproveActivityRecordDto {
  // The record's `submittedAt` as the reviewer saw it; a record recalled and
  // resubmitted since then is refused as `record_changed`.
  @IsOptional()
  @IsISO8601({ strict: true })
  seenSubmittedAt?: string | null;
}
