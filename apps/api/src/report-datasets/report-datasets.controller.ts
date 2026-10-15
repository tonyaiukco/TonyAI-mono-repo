import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { ReportDatasetSummary } from '@tonyai/shared-types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import { DatasetCapturerGuard, DatasetReaderGuard } from './dataset-role.guard';
import { CaptureReportDatasetDto, ListReportDatasetsQueryDto } from './dto/report-dataset.dto';
import { ReportDatasetsService } from './report-datasets.service';

/** LP3-04 PR C (V7): capture a report dataset, list a year's, read one as retained. */
@Controller('report-datasets')
export class ReportDatasetsController {
  constructor(private readonly service: ReportDatasetsService) {}

  @Post()
  @UseGuards(DatasetCapturerGuard)
  capture(@CurrentUser() user: RequestUser, @Body() dto: CaptureReportDatasetDto): Promise<ReportDatasetSummary> {
    return this.service.capture(user, dto);
  }

  @Get()
  @UseGuards(DatasetReaderGuard)
  list(@CurrentUser() user: RequestUser, @Query() query: ListReportDatasetsQueryDto): Promise<ReportDatasetSummary[]> {
    return this.service.list(user, query.year);
  }

  /** The retained text itself, as stored — never rebuilt. Its fingerprint is
   * recomputed from it parsed and canonicalised (README "Fingerprint
   * encoding"), not from these bytes. */
  @Get(':id')
  @UseGuards(DatasetReaderGuard)
  @Header('Content-Type', 'application/json; charset=utf-8')
  get(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<string> {
    return this.service.get(user, id);
  }
}
