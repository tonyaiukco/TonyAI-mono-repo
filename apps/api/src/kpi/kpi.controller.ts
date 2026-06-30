import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { KpiService } from './kpi.service';

@Controller('kpi')
export class KpiController {
  constructor(private readonly service: KpiService) {}

  @Get()
  summary(@CurrentUser() user: RequestUser) {
    return this.service.summary(user);
  }
}
