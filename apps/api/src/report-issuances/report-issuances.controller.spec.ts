import 'reflect-metadata';
import { resolve } from 'node:path';
import * as nest from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import * as currentUser from '../auth/current-user.decorator';
import { errorCodeOf } from '../common/api-error';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from '../common/coded-validation.pipe';
import { controllerModule } from '../common/controller-metadata.test-support';
import * as uuidPipe from '../common/parse-uuid-param.pipe';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import * as dto from './dto/issue-report.dto';
import * as roleGuard from './issuance-role.guard';
import { IssuanceReaderGuard, IssuerGuard } from './issuance-role.guard';
import { IssuancePreviewController, ReportIssuancesController } from './report-issuances.controller';
import type { ReportIssuancesService } from './report-issuances.service';

/** The issuance routes (LP3-04 PR D): method, path, roles before the body,
 * ids through the uuid pipe, the PDF streamed as an attachment. */

describe('ReportIssuancesController', () => {
  it('serves /report-issuances', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReportIssuancesController)).toBe('report-issuances');
  });

  it.each([
    ['issue', RequestMethod.POST, '/', [IssuerGuard]],
    ['list', RequestMethod.GET, '/', [IssuanceReaderGuard]],
    ['get', RequestMethod.GET, ':id', [IssuanceReaderGuard]],
    ['pdf', RequestMethod.GET, ':id/pdf', [IssuanceReaderGuard]],
  ] as const)('%s: its method, path and role guard', (name, method, path, guards) => {
    const handler = ReportIssuancesController.prototype[name];
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual(guards);
  });

  it.each(['get', 'pdf'] as const)('%s takes its id through the uuid pipe', (name) => {
    const args = Object.values(Reflect.getMetadata(ROUTE_ARGS_METADATA, ReportIssuancesController, name) as Record<string, { data?: unknown; pipes: unknown[] }>);
    expect(args.find((a) => a.data === 'id')?.pipes).toContain(ParseUuidParamPipe);
  });

  it('streams the retained PDF as an attachment, with its length', async () => {
    const bytes = Buffer.from('%PDF-1.4 x');
    const pdfOf = vi.fn().mockResolvedValue({ bytes, filename: 'tonyai-report-2026-executive_summary-en-final.pdf' });
    const res = { set: vi.fn().mockReturnThis(), send: vi.fn() };
    await new ReportIssuancesController({ pdfOf } as unknown as ReportIssuancesService).pdf({} as never, 'id', res as never);
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="tonyai-report-2026-executive_summary-en-final.pdf"',
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
    });
    expect(res.send).toHaveBeenCalledWith(bytes);
  });

  it.each([
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['csv', 'text/csv; charset=utf-8'],
  ] as const)('streams the issued %s, never cached, under the issuance\'s file name', async (format, type) => {
    const body = format === 'csv' ? 'issuance_id\n' : Buffer.from('PK');
    const tablesOf = vi.fn().mockResolvedValue({ body, filename: `tonyai-report-x.${format}` });
    const res = { set: vi.fn().mockReturnThis(), send: vi.fn() };
    await new ReportIssuancesController({ tablesOf } as unknown as ReportIssuancesService)[format]({} as never, 'id', res as never);
    expect(tablesOf).toHaveBeenCalledWith({}, 'id', format);
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
      'Content-Type': type, 'Content-Disposition': `attachment; filename="tonyai-report-x.${format}"`, 'Cache-Control': 'no-store',
    }));
    expect(res.send).toHaveBeenCalledWith(body);
  });

  it.each(['xlsx', 'csv'] as const)('reads the %s route\'s id through the UUID pipe', (name) => {
    const args = Object.values(Reflect.getMetadata(ROUTE_ARGS_METADATA, ReportIssuancesController, name) as Record<string, { data?: unknown; pipes: unknown[] }>);
    expect(args.find((a) => a.data === 'id')?.pipes).toContain(ParseUuidParamPipe);
  });

  it('serves the issuance preview to issuers alone, its id through the UUID pipe', async () => {
    const preview = vi.fn().mockResolvedValue({ datasetId: 'd', status: 'partial', gaps: [], finalAllowed: false });
    expect(await new IssuancePreviewController({ preview } as unknown as ReportIssuancesService).preview({} as never, 'd')).toMatchObject({ datasetId: 'd' });
    expect(Reflect.getMetadata(GUARDS_METADATA, IssuancePreviewController.prototype.preview)).toEqual([IssuerGuard]);
    const args = Object.values(Reflect.getMetadata(ROUTE_ARGS_METADATA, IssuancePreviewController, 'preview') as Record<string, { data?: unknown; pipes: unknown[] }>);
    expect(args.find((a) => a.data === 'id')?.pipes).toContain(ParseUuidParamPipe);
  });
});

describe('the role guards — before any body is read', () => {
  const context = (role?: string) => ({ switchToHttp: () => ({ getRequest: () => ({ user: role === undefined ? undefined : { role } }) }) }) as never;

  it.each([
    ['super_admin', true, true], ['consultant', true, true], ['executive_viewer', false, true], ['data_entry', false, false],
  ] as const)('%s: issues %s, reads %s', (role, issues, reads) => {
    const outcome = (guard: { canActivate(c: never): boolean }) => { try { return guard.canActivate(context(role)); } catch { return false; } };
    expect(outcome(new IssuerGuard())).toBe(issues);
    expect(outcome(new IssuanceReaderGuard())).toBe(reads);
  });

  it('refuses a request without a user', () => {
    expect(() => new IssuerGuard().canActivate(context())).toThrow(nest.ForbiddenException);
  });
});

/** Compiled as `tsc` does: vitest's esbuild drops `design:paramtypes`. */
const compiled = controllerModule<typeof import('./report-issuances.controller')>(
  resolve(__dirname, './report-issuances.controller.ts'), {
    '@nestjs/common': nest,
    '../auth/current-user.decorator': currentUser,
    '../common/parse-uuid-param.pipe': uuidPipe,
    './dto/issue-report.dto': dto,
    './issuance-role.guard': roleGuard,
    './report-issuances.service': { ReportIssuancesService: class {} },
  },
).ReportIssuancesController;

describe('the compiled controller: its body and query validated by their DTOs', () => {
  const typeOf = (handler: string, index: number) =>
    (Reflect.getMetadata('design:paramtypes', compiled.prototype, handler) as unknown[])[index];
  const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);
  const body = (value: unknown) => pipe.transform(value, { type: 'body', metatype: typeOf('issue', 1) as never });
  const ID = '0D5E0000-0000-4000-8000-000000000001';

  it.each([
    ['issue', 1, dto.IssueReportDto],
    ['list', 1, dto.ListReportIssuancesQueryDto],
  ] as const)('%s takes its argument %i as its DTO', (handler, index, type) => {
    expect(typeOf(handler, index)).toBe(type);
  });

  it('accepts a dataset, a template and the optional language and options — the id lower-cased', async () => {
    await expect(body({ datasetId: ID, template: 'executive_summary' })).resolves.toMatchObject({ datasetId: ID.toLowerCase() });
    await expect(body({ datasetId: ID, template: 'ghg_protocol_detail', language: 'tr', includeMethodologyNotes: true, includeEvidenceSummary: false }))
      .resolves.toMatchObject({ language: 'tr', includeMethodologyNotes: true });
  });

  it.each([
    ['no dataset', { template: 'executive_summary' }],
    ['a dataset that is not an id', { datasetId: 'x', template: 'executive_summary' }],
    ['an unknown template', { datasetId: ID, template: 'glossy' }],
    ['an unsupported language', { datasetId: ID, template: 'executive_summary', language: 'de' }],
    ['a null language', { datasetId: ID, template: 'executive_summary', language: null }],
    ['an option that is not a boolean', { datasetId: ID, template: 'executive_summary', includeEvidenceSummary: 'yes' }],
    ['a status sent by the caller', { datasetId: ID, template: 'executive_summary', status: 'final' }],
  ])('refuses %s', async (_what, value) => {
    expect(errorCodeOf(await body(value).catch((e: unknown) => e))).toBe('validation_failed');
  });
});
