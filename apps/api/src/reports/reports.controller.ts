import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import { ReportsService } from './reports.service';
import { ReportMetaQueryDto, ReportQueryDto } from './dto/report-query.dto';

function filename(q: ReportQueryDto, ext: string): string {
  // Sanitize: subsidiaryId is only @IsString-validated (seed ids aren't RFC-4122
  // UUIDs), and a quote/CRLF here would corrupt the Content-Disposition header.
  const sub = q.subsidiaryId
    ? `-${q.subsidiaryId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 8)}`
    : '';
  return `tonyai-${q.template}-${q.year}${sub}.${ext}`;
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  /** Completeness/status meta for the preview badge + data warning. */
  @Get('meta')
  meta(@CurrentUser() user: RequestUser, @Query() q: ReportMetaQueryDto) {
    return this.service.meta(user, q.year, q.subsidiaryId);
  }

  /** Audit-ready branded PDF (FR §5.1). Streams as a download. */
  @Get('pdf')
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
