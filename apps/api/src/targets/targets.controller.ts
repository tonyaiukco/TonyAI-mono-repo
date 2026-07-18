import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { TargetsService } from './targets.service';
import { CreateTargetDto } from './dto/create-target.dto';
import { UpdateTargetDto } from './dto/update-target.dto';

@Controller('targets')
export class TargetsController {
  constructor(private readonly service: TargetsService) {}

  /** List targets (tenant-scoped; optional subsidiary filter). */
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query('subsidiaryId') subsidiaryId?: string,
  ) {
    return this.service.list(user, subsidiaryId);
  }

  /** Live progress for the caller's targets. Declared before any `:id` route. */
  @Get('progress')
  progress(
    @CurrentUser() user: RequestUser,
    @Query('subsidiaryId') subsidiaryId?: string,
  ) {
    return this.service.progress(user, subsidiaryId);
  }

  /** Create a target — super_admin only, audited. */
  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateTargetDto) {
    return this.service.create(user, dto);
  }

  /** Update a target — super_admin only, audited. */
  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateTargetDto,
  ) {
    return this.service.update(user, id, dto);
  }

  /** Delete a target — super_admin only, audited. */
  @Delete(':id')
  remove(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.service.remove(user, id);
  }
}
