import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { PeriodLocksService } from './period-locks.service';
import { CreatePeriodLockDto } from './dto/create-period-lock.dto';
import { PeriodLockPageQueryDto } from './dto/period-lock-page-query.dto';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';

@Controller('period-locks')
export class PeriodLocksController {
  constructor(private readonly service: PeriodLocksService) {}

  /** One `CursorPage` of locked periods (tenant-scoped; LP4-05 PR C). */
  @Get()
  list(@CurrentUser() user: RequestUser, @Query() query: PeriodLockPageQueryDto) {
    return this.service.listPage(user, query);
  }

  /** Close a reporting period (FR §4.2) — super_admin only. */
  @Post()
  lock(@CurrentUser() user: RequestUser, @Body() dto: CreatePeriodLockDto) {
    return this.service.lock(user, dto);
  }

  /** Reopen a period — super_admin only, audited. */
  @Delete(':id')
  unlock(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.unlock(user, id);
  }
}
