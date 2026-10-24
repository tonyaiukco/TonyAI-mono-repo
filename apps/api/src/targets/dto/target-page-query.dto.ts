import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, Matches } from 'class-validator';
import { TARGET_PROGRESS_MAX_IDS, type TargetPageParams, type TargetProgressParams } from '@tonyai/shared-types';
import { CursorPageQueryDto } from '../../common/cursor-page-query.dto';
import { IdFilter } from '../../common/page-filters';
import { canonicalUuid, ID_SHAPE_MESSAGE, UUID_SHAPE } from '../../common/parse-uuid-param.pipe';

/** GET /targets (LP4-05's `TargetPageParams`). */
export class TargetPageQueryDto extends CursorPageQueryDto implements TargetPageParams {
  @IdFilter()
  subsidiaryId?: string;
}

/**
 * GET /targets/progress?targetIds=<comma-separated ids>: one page of ids at
 * most, at least one, none twice once lowercased. Only the comma-separated
 * spelling is read — a repeated key is refused, not merged.
 */
export class TargetProgressQueryDto implements TargetProgressParams {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map((id) => canonicalUuid(id) ?? id) : null,
  )
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(TARGET_PROGRESS_MAX_IDS)
  @ArrayUnique()
  @Matches(UUID_SHAPE, { each: true, message: ID_SHAPE_MESSAGE })
  targetIds!: string[];
}

const _noMissingPageParams: never = null as unknown as Exclude<keyof TargetPageParams, keyof TargetPageQueryDto>;
const _noMissingProgressParams: never = null as unknown as Exclude<keyof TargetProgressParams, keyof TargetProgressQueryDto>;
void _noMissingPageParams;
void _noMissingProgressParams;
