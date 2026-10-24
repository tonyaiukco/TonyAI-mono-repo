import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ActivityRecordsService } from './activity-records.service';
import { CreateActivityRecordDto } from './dto/create-activity-record.dto';
import { UpdateActivityRecordDto } from './dto/update-activity-record.dto';
import { RejectActivityRecordDto } from './dto/reject-activity-record.dto';
import { VoidActivityRecordDto } from './dto/void-activity-record.dto';
import {
  ActivityRecordFiltersQueryDto,
  ActivityRecordPageQueryDto,
} from './dto/activity-record-page-query.dto';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';

@Controller('activity-records')
export class ActivityRecordsController {
  constructor(private readonly service: ActivityRecordsService) {}

  /** One `CursorPage` of the caller's records (LP4-05 PR C). */
  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query() query: ActivityRecordPageQueryDto,
  ) {
    return this.service.listPage(user, query);
  }

  /** The filtered set's size and newest year. Declared before `:id`, which would otherwise claim the path. */
  @Get('metadata')
  metadata(
    @CurrentUser() user: RequestUser,
    @Query() query: ActivityRecordFiltersQueryDto,
  ) {
    return this.service.metadata(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.get(user, id);
  }

  @Post()
  create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateActivityRecordDto,
  ) {
    return this.service.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() dto: UpdateActivityRecordDto,
  ) {
    return this.service.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.remove(user, id);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submit(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.submit(user, id);
  }

  /** Take a submitted record into review (FR §6.3) — reviewer roles only. */
  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  startReview(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.startReview(user, id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string) {
    return this.service.approve(user, id);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() dto: RejectActivityRecordDto,
  ) {
    return this.service.reject(user, id, dto.varianceReason);
  }

  /** Withdraw an approved figure from the inventory (the void path) — super_admin only. */
  @Post(':id/void')
  @HttpCode(HttpStatus.OK)
  void(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Body() dto: VoidActivityRecordDto,
  ) {
    return this.service.void(user, id, dto.voidReason);
  }
}
