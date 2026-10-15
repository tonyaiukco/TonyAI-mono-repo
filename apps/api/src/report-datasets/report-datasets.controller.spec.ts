import 'reflect-metadata';
import { resolve } from 'node:path';
import * as nest from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HEADERS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import * as currentUser from '../auth/current-user.decorator';
import { errorCodeOf } from '../common/api-error';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from '../common/coded-validation.pipe';
import { controllerModule } from '../common/controller-metadata.test-support';
import * as uuidPipe from '../common/parse-uuid-param.pipe';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import * as roleGuard from './dataset-role.guard';
import { DatasetCapturerGuard, DatasetReaderGuard } from './dataset-role.guard';
import * as dto from './dto/report-dataset.dto';
import { ReportDatasetsController } from './report-datasets.controller';

/** The dataset routes (LP3-04 PR C, V7): method, path, roles before the body,
 * the retained text served as JSON, an id through the uuid pipe. */

describe('ReportDatasetsController', () => {
  it('serves /report-datasets', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReportDatasetsController)).toBe('report-datasets');
  });

  it.each([
    ['capture', RequestMethod.POST, '/', [DatasetCapturerGuard]],
    ['list', RequestMethod.GET, '/', [DatasetReaderGuard]],
    ['get', RequestMethod.GET, ':id', [DatasetReaderGuard]],
  ] as const)('%s: its method, path and role guard', (name, method, path, guards) => {
    const handler = ReportDatasetsController.prototype[name];
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual(guards);
  });

  it('serves one dataset as JSON text, its id through the uuid pipe', () => {
    expect(Reflect.getMetadata(HEADERS_METADATA, ReportDatasetsController.prototype.get))
      .toEqual([{ name: 'Content-Type', value: 'application/json; charset=utf-8' }]);
    const args = Object.values(Reflect.getMetadata(ROUTE_ARGS_METADATA, ReportDatasetsController, 'get') as Record<string, { data?: unknown; pipes: unknown[] }>);
    expect(args.find((a) => a.data === 'id')?.pipes).toContain(ParseUuidParamPipe);
  });
});

/** Compiled as `tsc` does: vitest's esbuild drops `design:paramtypes`. */
const compiled = controllerModule<typeof import('./report-datasets.controller')>(
  resolve(__dirname, './report-datasets.controller.ts'), {
    '@nestjs/common': nest,
    '../auth/current-user.decorator': currentUser,
    '../common/parse-uuid-param.pipe': uuidPipe,
    './dataset-role.guard': roleGuard,
    './dto/report-dataset.dto': dto,
    './report-datasets.service': { ReportDatasetsService: class {} },
  },
).ReportDatasetsController;

describe('the compiled controller: its body and query validated by their DTOs', () => {
  const typeOf = (handler: string, index: number) =>
    (Reflect.getMetadata('design:paramtypes', compiled.prototype, handler) as unknown[])[index];

  it.each([
    ['capture', 1, dto.CaptureReportDatasetDto],
    ['list', 1, dto.ListReportDatasetsQueryDto],
  ] as const)('%s takes its argument %i as its DTO', (handler, index, type) => {
    expect(typeOf(handler, index)).toBe(type);
  });

  it('refuses through it a category outside its scope', async () => {
    const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);
    const failure = await pipe.transform(
      { boundaryId: '0b1d0000-0000-4000-8000-000000000001', scope: 1, category: 'Electricity' },
      { type: 'body', metatype: typeOf('capture', 1) as never },
    ).catch((e: unknown) => e);
    expect(errorCodeOf(failure)).toBe('validation_failed');
  });
});
