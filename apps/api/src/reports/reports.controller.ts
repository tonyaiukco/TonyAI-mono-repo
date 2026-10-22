import type { ReportingContext, ReportingMetaResponse } from '@tonyai/shared-types';
import { ReportingContextQueryDto, reportingContext } from '../common/reporting-context-query.dto';
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ReportsService } from './reports.service';
import { ExportGetOnlyGuard } from './export-get-only.guard';
import { ReportMetaQueryDto, ReportQueryDto, ReportingExportQueryDto } from './dto/report-query.dto';

export function filename(q: ReportQueryDto & Pick<ReportingContext, 'scope' | 'category'>, ext: string): string {
  // Sanitize: a legacy subsidiaryId is only length-bounded (seed ids aren't RFC-4122
  // UUIDs), and a quote/CRLF here would corrupt the Content-Disposition header.
  const sub = q.subsidiaryId
    ? `-${q.subsidiaryId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8)}`
    : '';
  const scope = q.scope !== undefined ? `-scope${q.scope}` : '';
  const category = q.category ? `-${q.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
  return `tonyai-${q.template}-${q.year}${sub}${scope}${category}.${ext}`;
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get('context/meta')
  async contextMeta(@CurrentUser() user: RequestUser, @Query() q: ReportingContextQueryDto): Promise<ReportingMetaResponse> {
    const context = reportingContext(q);
    return { context, data: await this.service.meta(user, q.year, q.subsidiaryId, context) };
  }

  @Get('context/pdf')
  @UseGuards(ExportGetOnlyGuard)
  contextPdf(@CurrentUser() user: RequestUser, @Query() q: ReportingExportQueryDto, @Res() res: Response) {
    return this.pdf(user, q, res);
  }

  @Get('context/excel')
  @UseGuards(ExportGetOnlyGuard)
  contextExcel(@CurrentUser() user: RequestUser, @Query() q: ReportingExportQueryDto, @Res() res: Response) {
    return this.excel(user, q, res);
  }

  @Get('context/csv')
  @UseGuards(ExportGetOnlyGuard)
  contextCsv(@CurrentUser() user: RequestUser, @Query() q: ReportingExportQueryDto, @Res() res: Response) {
    return this.csv(user, q, res);
  }

  /** Completeness/status meta for the preview badge + data warning. */
  @Get('meta')
  meta(@CurrentUser() user: RequestUser, @Query() q: ReportMetaQueryDto) {
    return this.service.meta(user, q.year, q.subsidiaryId);
  }

  /** Audit-ready branded PDF (FR §5.1). Streams as a download. */
  @Get('pdf')
  @UseGuards(ExportGetOnlyGuard)
  async pdf(
    @CurrentUser() user: RequestUser,
    @Query() q: ReportQueryDto,
    @Res() res: Response,
  ) {
    const buffer = await this.service.generatePdf(user, q);
    res
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename(q, 'pdf')}"`,
        'Content-Length': buffer.length,
      })
      .send(buffer);
  }

  /** Multi-sheet Excel export: Summary / Raw Activity Data / Factors Used (FR §5.2). */
  @Get('excel')
  @UseGuards(ExportGetOnlyGuard)
  async excel(
    @CurrentUser() user: RequestUser,
    @Query() q: ReportQueryDto,
    @Res() res: Response,
  ) {
    const buffer = await this.service.generateExcel(user, q);
    res
      .set({
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename(q, 'xlsx')}"`,
        'Content-Length': buffer.length,
      })
      .send(buffer);
  }

  /** CSV export of the committed records ledger (FR §5.2). */
  @Get('csv')
  @UseGuards(ExportGetOnlyGuard)
  async csv(
    @CurrentUser() user: RequestUser,
    @Query() q: ReportQueryDto,
    @Res() res: Response,
  ) {
    const csv = await this.service.generateCsv(user, q);
    res
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename(q, 'csv')}"`,
      })
      .send(csv);
  }
}
