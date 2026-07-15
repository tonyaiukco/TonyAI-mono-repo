import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { PeriodLocksService } from './period-locks.service';
import { CreatePeriodLockDto } from './dto/create-period-lock.dto';

@Controller('period-locks')
export class PeriodLocksController {
  constructor(private readonly service: PeriodLocksService) {}

  /** List locked periods (tenant-scoped; optional subsidiary/year filters). */
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query('subsidiaryId') subsidiaryId?: string,
    @Query('year', new ParseIntPipe({ optional: true })) year?: number,
  ) {
    return this.service.list(user, subsidiaryId, year);
  }

  /** Close a reporting period (FR §4.2) — super_admin only. */
  @Post()
  lock(@CurrentUser() user: RequestUser, @Body() dto: CreatePeriodLockDto) {
    return this.service.lock(user, dto);
  }

  /** Reopen a period — super_admin only, audited. */
  @Delete(':id')
  unlock(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.service.unlock(user, id);
  }
}
