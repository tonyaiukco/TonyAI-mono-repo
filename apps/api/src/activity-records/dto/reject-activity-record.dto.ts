import { IsString, MinLength } from 'class-validator';

/**
 * Body of POST /api/v1/activity-records/:id/reject.
 * Mirrors RejectInput in @tonyai/shared-types — a reviewer must give a reason.
 */
export class RejectActivityRecordDto {
  @IsString()
  @MinLength(1)
  varianceReason!: string;
}
