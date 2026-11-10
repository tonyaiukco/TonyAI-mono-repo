import { Transform } from 'class-transformer';
import { trimmed } from '../../common/trimmed';
import { IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { EXPLANATION_MAX_LENGTH } from '@tonyai/shared-types';

/**
 * Body of POST /api/v1/activity-records/:id/reject.
 * Mirrors RejectInput in @tonyai/shared-types — a reviewer must give a reason.
 *
 * Trimmed BEFORE the length check: `MinLength(1)` alone accepted "   ", which
 * stored a blank note and rendered an empty "Reviewer's Note" panel to the
 * submitter. FR §6.5 is a compliance control, so it cannot live in the browser's
 * disabled-button logic — a second client, or curl, bypasses that entirely.
 * Bounded too: the field is unbounded `text` in Postgres and is now rendered
 * verbatim on the submitter's screen.
 */
export class RejectActivityRecordDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(EXPLANATION_MAX_LENGTH)
  varianceReason!: string;

  // BUG-R2-03 review: the record's `submittedAt` as the reviewer saw it (see
  // ApproveActivityRecordDto). Optional, as on approve.
  @IsOptional()
  @IsISO8601({ strict: true })
  seenSubmittedAt?: string | null;
}
