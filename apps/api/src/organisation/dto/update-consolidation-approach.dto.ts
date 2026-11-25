import { IsIn } from 'class-validator';
import { CONSOLIDATION_APPROACHES, type ConsolidationApproach } from '@tonyai/shared-types';

/**
 * `PATCH /organisation/consolidation-approach` (inc26-group-tree, D8). Only
 * the two stored approaches: `equity_share` is announced as "coming soon" and
 * refused here as invalid, like any other value (INC-2.6 §3).
 */
export class UpdateConsolidationApproachDto {
  @IsIn(CONSOLIDATION_APPROACHES as readonly string[])
  consolidationApproach!: ConsolidationApproach;
}
