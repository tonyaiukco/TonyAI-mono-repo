import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { BulkSubmitFuelBatchesResultDTO, FuelBatchDetailDTO, FuelBatchDTO, FuelBatchMetadataDTO, FuelBatchRowDTO } from '@tonyai/shared-types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import { ApproveActivityRecordDto, StartReviewActivityRecordDto } from '../activity-records/dto/approve-activity-record.dto';
import { RejectActivityRecordDto } from '../activity-records/dto/reject-activity-record.dto';
import { BulkSubmitFuelBatchesDto, FuelBatchFiltersDto, FuelBatchRowsQueryDto, SubmitFuelBatchDto } from './dto/fuel-batch.dto';
import { FuelBatchesService } from './fuel-batches.service';

/** Fuel batches: the review unit (inc28-fuel-bulk D9, D10). */
@Controller('fuel-batches')
export class FuelBatchesController {
  constructor(private readonly batches: FuelBatchesService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query() filters: FuelBatchFiltersDto): Promise<FuelBatchDTO[]> {
    return this.batches.list(user, filters);
  }

  @Get('metadata')
  metadata(@CurrentUser() user: RequestUser, @Query() filters: FuelBatchFiltersDto): Promise<FuelBatchMetadataDTO> {
    return this.batches.metadata(user, filters);
  }

  @Post('bulk-submit')
  @HttpCode(200)
  bulkSubmit(@CurrentUser() user: RequestUser, @Body() body: BulkSubmitFuelBatchesDto): Promise<BulkSubmitFuelBatchesResultDTO> {
    return this.batches.bulkSubmit(user, body.batchIds);
  }

  @Get(':id')
  detail(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<FuelBatchDetailDTO> {
    return this.batches.detail(user, id);
  }

  @Get(':id/rows')
  rows(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Query() page: FuelBatchRowsQueryDto,
  ): Promise<{ rows: FuelBatchRowDTO[]; total: number }> {
    return this.batches.rows(user, id, page);
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string, @Body() body: SubmitFuelBatchDto): Promise<FuelBatchDetailDTO> {
    return this.batches.submit(user, id, body.varianceReason);
  }

  @Post(':id/recall')
  @HttpCode(200)
  recall(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<FuelBatchDetailDTO> {
    return this.batches.recall(user, id);
  }

  @Post(':id/review')
  @HttpCode(200)
  review(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string, @Body() body: StartReviewActivityRecordDto = {}): Promise<FuelBatchDetailDTO> {
    return this.batches.startReview(user, id, body?.seenSubmittedAt);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string, @Body() body: ApproveActivityRecordDto = {}): Promise<FuelBatchDetailDTO> {
    return this.batches.approve(user, id, body?.seenSubmittedAt);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string, @Body() body: RejectActivityRecordDto): Promise<FuelBatchDetailDTO> {
    return this.batches.reject(user, id, body.varianceReason, body.seenSubmittedAt);
  }
}
