import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { ReportIssuance } from '@tonyai/shared-types';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import { IssueReportDto, ListReportIssuancesQueryDto } from './dto/issue-report.dto';
import { IssuanceReaderGuard, IssuerGuard } from './issuance-role.guard';
import { ReportIssuancesService } from './report-issuances.service';

/** LP3-04 PR D: issue a retained dataset as a PDF, list a year's issuances, read one, download its PDF. */
@Controller('report-issuances')
export class ReportIssuancesController {
  constructor(private readonly service: ReportIssuancesService) {}

  @Post()
  @UseGuards(IssuerGuard)
  issue(@CurrentUser() user: RequestUser, @Body() dto: IssueReportDto): Promise<ReportIssuance> {
    return this.service.issue(user, dto);
  }

  @Get()
  @UseGuards(IssuanceReaderGuard)
  list(@CurrentUser() user: RequestUser, @Query() query: ListReportIssuancesQueryDto): Promise<ReportIssuance[]> {
    return this.service.list(user, query.year);
  }

  @Get(':id')
  @UseGuards(IssuanceReaderGuard)
  get(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<ReportIssuance> {
    return this.service.get(user, id);
  }

  /** The retained bytes, verified — never rendered again. */
  @Get(':id/pdf')
  @UseGuards(IssuanceReaderGuard)
  async pdf(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { bytes, filename } = await this.service.pdfOf(user, id);
    res
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': bytes.length,
      })
      .send(bytes);
  }
}
