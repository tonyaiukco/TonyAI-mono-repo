import 'reflect-metadata';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as nest from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Response } from 'express';
import * as currentUser from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/auth.types';
import * as contextDto from '../common/reporting-context-query.dto';
import * as reportDto from './dto/report-query.dto';
import type { ReportsService } from './reports.service';
import { controllerModule } from '../common/controller-metadata.test-support';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from '../common/coded-validation.pipe';
import { routeGroup } from '../common/runtime-limits';

const { ReportsController } = controllerModule<typeof import('./reports.controller')>(
  resolve(__dirname, './reports.controller.ts'), {
    '@nestjs/common': nest, '../auth/current-user.decorator': currentUser,
    '../common/reporting-context-query.dto': contextDto, './dto/report-query.dto': reportDto,
    './reports.service': { ReportsService: class {} },
  },
);
const handlers = ['contextMeta', 'contextPdf', 'contextExcel', 'contextCsv', 'meta', 'pdf', 'excel', 'csv'];
const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);

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
    const expected = { template: 'ghg_protocol_detail', year: 2027, subsidiaryId: 'sub-1', scope: 1, category: 'Fuel',
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
      'Content-Disposition': `attachment; filename="tonyai-ghg_protocol_detail-2027-sub-1-scope1-fuel.${ext}"`,
    }));
    expect(response.send).toHaveBeenCalledWith(ext === 'csv' ? 'test-csv' : bytes);
  });
});
