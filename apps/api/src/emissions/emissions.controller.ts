import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { EmissionsService } from './emissions.service';
import { EmissionsSummaryQueryDto } from './dto/emissions-summary-query.dto';

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
}
