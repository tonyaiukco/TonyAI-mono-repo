import { Controller, Get, ParseIntPipe, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { IntensityService } from './intensity.service';

@Controller('intensity')
export class IntensityController {
  constructor(private readonly service: IntensityService) {}

  /**
   * Emissions intensity for a year (tenant-scoped): one entry per configured
   * metric. Empty `metrics` when nothing is configured → the UI keeps the
   * Intensity toggle disabled.
   */
  @Get()
  intensity(
    @CurrentUser() user: RequestUser,
    @Query('year', new ParseIntPipe({ optional: true })) year?: number,
    @Query('subsidiaryId') subsidiaryId?: string,
  ) {
    return this.service.intensity(user, year, subsidiaryId);
  }
}
