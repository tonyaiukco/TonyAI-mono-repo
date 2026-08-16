import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { EmissionsService } from './emissions.service';
import { EmissionsSummaryQueryDto } from './dto/emissions-summary-query.dto';
import { TrackingMatrixQueryDto } from './dto/tracking-matrix-query.dto';
import { CompletenessQueryDto } from './dto/completeness-query.dto';

@Controller('emissions')
export class EmissionsController {
  constructor(private readonly service: EmissionsService) {}

  /** Tenant-scoped aggregation of activity records for the analytics workspace. */
  @Get('summary')
  summary(
    @CurrentUser() user: RequestUser,
    @Query() query: EmissionsSummaryQueryDto,
  ) {
    return this.service.summary(user, query);
  }

  /** Subsidiary × category completeness matrix for the dashboard (FR §2). */
  @Get('tracking-matrix')
  trackingMatrix(
    @CurrentUser() user: RequestUser,
    @Query() query: TrackingMatrixQueryDto,
  ) {
    return this.service.trackingMatrix(user, query);
  }

  /**
   * Which invoice slots are open for one subsidiary and year — the drill-down
   * behind a matrix cell (round-1 DASH-3: "reveal what is keyed in and what is
   * missing"). Read-only and tenant-scoped like everything else here.
   */
  @Get('completeness')
  completeness(
    @CurrentUser() user: RequestUser,
    @Query() query: CompletenessQueryDto,
  ) {
    return this.service.completeness(user, query);
  }
}
