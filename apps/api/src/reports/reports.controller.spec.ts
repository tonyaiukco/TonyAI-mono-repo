import 'reflect-metadata';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as nest from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Response } from 'express';
import * as currentUser from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import * as contextDto from '../common/reporting-context-query.dto';
import * as reportDto from './dto/report-query.dto';
import type { ReportsService } from './reports.service';
import { controllerModule } from '../common/controller-metadata.test-support';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from '../common/coded-validation.pipe';
import { routeGroup } from '../common/runtime-limits';
import * as getOnly from './export-get-only.guard';

const { ReportsController } = controllerModule<typeof import('./reports.controller')>(
  resolve(__dirname, './reports.controller.ts'), {
    '@nestjs/common': nest, '../auth/current-user.decorator': currentUser,
    '../common/reporting-context-query.dto': contextDto, './dto/report-query.dto': reportDto,
    './reports.service': { ReportsService: class {} }, './export-get-only.guard': getOnly,
  },
);
const handlers = ['contextMeta', 'contextPdf', 'contextExcel', 'contextCsv', 'meta', 'pdf', 'excel', 'csv'];
const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);
const SUB = '22222222-2222-2222-2222-222222222201';

describe('compiled report controller routing', () => {
  it('accounts for every registered handler', () => {
    expect(Object.getOwnPropertyNames(ReportsController.prototype).filter((name) => name !== 'constructor').sort())
      .toEqual([...handlers].sort());
  });
  it.each(handlers)('%s has a route whose actual path receives the correct runtime protection', (handler) => {
    const method = ReportsController.prototype[handler];
    expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(nest.RequestMethod.GET);
    const path = `/api/v1/${Reflect.getMetadata(PATH_METADATA, ReportsController)}/${Reflect.getMetadata(PATH_METADATA, method)}`;
    const group = handler.toLowerCase().endsWith('meta') ? 'READ' : 'EXPORT';
    for (const verb of ['GET', 'HEAD']) expect(routeGroup(verb, path)).toBe(group);
    // (15): every export refuses HEAD before it assembles or audits anything.
    expect(Reflect.getMetadata(GUARDS_METADATA, method) ?? []).toEqual(group === 'EXPORT' ? [getOnly.ExportGetOnlyGuard] : []);
    if (handler.startsWith('context') && group === 'EXPORT') {
      expect(Reflect.getMetadata('design:paramtypes', ReportsController.prototype, handler)[1])
        .toBe(reportDto.ReportingExportQueryDto);
    }
  });

  it.each([
    { handler: 'contextPdf', generator: 'generatePdf', ext: 'pdf', type: 'application/pdf' },
    { handler: 'contextExcel', generator: 'generateExcel', ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    { handler: 'contextCsv', generator: 'generateCsv', ext: 'csv', type: 'text/csv; charset=utf-8' },
  ])('$handler forwards the complete DTO to the right generator and sends its correct download headers', async ({ handler, generator, ext, type }) => {
    const expected = { template: 'ghg_protocol_detail', year: 2027, subsidiaryId: SUB, scope: 1, category: 'Fuel',
      includeMethodologyNotes: false, includeEvidenceSummary: true };
    const metatype = Reflect.getMetadata('design:paramtypes', ReportsController.prototype, handler)[1];
    const query = await pipe.transform({ ...expected, year: '2027', scope: '1', includeMethodologyNotes: 'false', includeEvidenceSummary: 'true' }, { type: 'query', metatype });
    const bytes = Buffer.from('test-artifact');
    const generators = { generatePdf: vi.fn().mockResolvedValue(bytes), generateExcel: vi.fn().mockResolvedValue(bytes), generateCsv: vi.fn().mockResolvedValue('test-csv') };
    const controller = new ReportsController(generators as unknown as ReportsService);
    const user = { id: 'caller' } as RequestUser;
    const response = { set: vi.fn().mockReturnThis(), send: vi.fn() };
    await controller[handler](user, query, response as unknown as Response);
    for (const [name, call] of Object.entries(generators)) {
      if (name === generator) {
        expect(call).toHaveBeenCalledTimes(1);
        expect(call).toHaveBeenCalledWith(user, expected);
      } else expect(call).not.toHaveBeenCalled();
    }
    expect(response.set).toHaveBeenCalledWith(expect.objectContaining({
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="tonyai-ghg_protocol_detail-2027-22222222-scope1-fuel.${ext}"`,
    }));
    expect(response.send).toHaveBeenCalledWith(ext === 'csv' ? 'test-csv' : bytes);
  });

  it('bounds a legacy selector to blank or an id before any generator runs (19)', async () => {
    for (const [metatype, query] of [
      [reportDto.ReportQueryDto, { template: 'executive_summary', year: '2027' }],
      [reportDto.ReportMetaQueryDto, { year: '2027' }],
    ] as const) {
      for (const accepted of [SUB, SUB.toUpperCase(), '', ' ']) {
        // A blank legacy selector keeps its meaning (open question (2)).
        await expect(pipe.transform({ ...query, subsidiaryId: accepted }, { type: 'query', metatype }), JSON.stringify(accepted)).resolves.toBeDefined();
      }
      // A NUL reached the audit row's jsonb only after the whole artifact was built (500);
      // markup and bidi controls reached the append-only diff verbatim (`security-rls` P3-1).
      for (const refused of [`${SUB}0`, String.fromCharCode(0), '<script>', String.fromCharCode(0x202e), 'sub-1', ` ${SUB}`]) {
        await expect(pipe.transform({ ...query, subsidiaryId: refused }, { type: 'query', metatype }), JSON.stringify(refused))
          .rejects.toMatchObject({ response: { code: 'validation_failed' } });
      }
    }
    await expect(pipe.transform({ template: 'executive_summary', year: '2027', subsidiaryId: 'sub-1' },
      { type: 'query', metatype: reportDto.ReportingExportQueryDto })).rejects.toMatchObject({ response: { code: 'validation_failed' } });
  });
});

describe('ExportGetOnlyGuard (15)', () => {
  const contextFor = (method: string) => {
    const response = { setHeader: vi.fn() };
    return {
      response,
      context: { switchToHttp: () => ({ getRequest: () => ({ method }), getResponse: () => response }) } as unknown as nest.ExecutionContext,
    };
  };

  it('lets GET through untouched', () => {
    const { response, context } = contextFor('GET');
    expect(new getOnly.ExportGetOnlyGuard().canActivate(context)).toBe(true);
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('answers HEAD 405 with Allow: GET', () => {
    const { response, context } = contextFor('HEAD');
    expect(() => new getOnly.ExportGetOnlyGuard().canActivate(context)).toThrow(nest.MethodNotAllowedException);
    expect(response.setHeader).toHaveBeenCalledWith('Allow', 'GET');
  });
});
