import {
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { CATEGORIES } from '@tonyai/shared-types';
import type {
  Category,
  ReportingPeriod,
} from '@tonyai/shared-types';

const REPORTING_PERIODS: ReportingPeriod[] = ['monthly', 'quarterly', 'annual'];

/**
 * Body of POST /api/v1/activity-records.
 * Mirrors CreateActivityRecordInput in @tonyai/shared-types. `scope` and the
 * calculation snapshot are derived server-side, never accepted from the client.
 */
export class CreateActivityRecordDto {
  // NB: a plain string, not @IsUUID — the tenant-access check + the FK
  // constraint enforce a valid, accessible subsidiary. (Seed ids are not
  // RFC-4122-conformant, so strict UUID validation would reject them.)
  @IsString()
  @MinLength(1)
  subsidiaryId!: string;

  // Optional operational location within the subsidiary; drives factor geography
  // when set. The service verifies it belongs to `subsidiaryId`.
  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string | null;

  @IsInt()
  @Min(2000)
  @Max(2100)
  reportingYear!: number;

  @IsString()
  @IsIn(REPORTING_PERIODS)
  reportingPeriod!: ReportingPeriod;

  @IsString()
  @MinLength(1)
  periodValue!: string;

  @IsString()
  @IsIn(CATEGORIES as readonly string[])
  category!: Category;

  @IsNumber()
  @Min(0)
  activityValue!: number;

  @IsString()
  @MinLength(1)
  activityUnit!: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown> | null;

  @IsOptional()
  @IsString()
  varianceReason?: string | null;
}
