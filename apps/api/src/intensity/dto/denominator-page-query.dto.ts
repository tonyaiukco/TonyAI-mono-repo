import type { DenominatorPageParams } from '@tonyai/shared-types';
import { CursorPageQueryDto } from '../../common/cursor-page-query.dto';
import { IdFilter, YearFilter } from '../../common/page-filters';

/** GET /denominators (LP4-05's `DenominatorPageParams`). */
export class DenominatorPageQueryDto extends CursorPageQueryDto implements DenominatorPageParams {
  @IdFilter()
  subsidiaryId?: string;

  @YearFilter()
  year?: number;
}

const _noMissingParams: never = null as unknown as Exclude<keyof DenominatorPageParams, keyof DenominatorPageQueryDto>;
void _noMissingParams;
