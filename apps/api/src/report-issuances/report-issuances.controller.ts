import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { ReportIssuance, ReportIssuanceList, ReportIssuancePreview } from '@tonyai/shared-types';
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
  list(@CurrentUser() user: RequestUser, @Query() query: ListReportIssuancesQueryDto): Promise<ReportIssuanceList> {
    return this.service.list(user, query.year, query.status);
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
        // As the exports: a retained report is never cached on the way (PR D follow-up (16)).
        'Cache-Control': 'no-store',
      })
      .send(bytes);
  }

  /** The issuance's retained dataset as a workbook (K5) — written on request, the PDF's figures exactly. */
  @Get(':id/xlsx')
  @UseGuards(IssuanceReaderGuard)
  async xlsx(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { body, filename } = await this.service.tablesOf(user, id, 'xlsx');
    res
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      })
      .send(body);
  }

  /** The issuance's retained dataset as CSV (K5): identity on every row, English machine headers. */
  @Get(':id/csv')
  @UseGuards(IssuanceReaderGuard)
  async csv(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUuidParamPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { body, filename } = await this.service.tablesOf(user, id, 'csv');
    res
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      })
      .send(body);
  }
}

/**
 * `GET /report-datasets/:id/issuance-preview` (K7): what issuing a retained
 * dataset would derive, nothing written. Declared here, beside the gate it
 * runs, under the datasets' path.
 */
@Controller('report-datasets')
export class IssuancePreviewController {
  constructor(private readonly service: ReportIssuancesService) {}

  @Get(':id/issuance-preview')
  @UseGuards(IssuerGuard)
  preview(@CurrentUser() user: RequestUser, @Param('id', ParseUuidParamPipe) id: string): Promise<ReportIssuancePreview> {
    return this.service.preview(user, id);
  }
}
