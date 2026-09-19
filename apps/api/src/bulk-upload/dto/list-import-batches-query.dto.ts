import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { IMPORT_BATCH_LIST_MAX } from '@tonyai/shared-types';

/** Query of `GET /import-batches`: how many of the newest to return. */
export class ListImportBatchesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(IMPORT_BATCH_LIST_MAX)
  limit?: number;
}
