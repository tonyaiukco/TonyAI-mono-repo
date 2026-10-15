import 'reflect-metadata';
import { resolve } from 'node:path';
import * as nest from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import * as currentUser from '../auth/current-user.decorator';
import { errorCodeOf } from '../common/api-error';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from '../common/coded-validation.pipe';
import { controllerModule } from '../common/controller-metadata.test-support';
import * as uuidPipe from '../common/parse-uuid-param.pipe';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
import * as writerGuard from './boundary-writer.guard';
import * as dto from './dto/inventory-boundary.dto';
import { BoundaryWriterGuard, DeclarationSizeGuard } from './boundary-writer.guard';
import { InventoryBoundariesController } from './inventory-boundaries.controller';

/**
 * The seven routes of the contract (E1), each at its method, path and status:
 * a create answers 201, confirm 200 (an action, not a resource), a version's
 * delete 204; every id in a path goes through the uuid pipe (`invalid_id`).
 */

const routes = [
  ['list', RequestMethod.GET, '/', undefined, []],
  ['get', RequestMethod.GET, ':id', undefined, ['id']],
  ['create', RequestMethod.POST, '/', undefined, []],
  ['putSubsidiary', RequestMethod.PUT, ':id/subsidiaries/:subsidiaryId', undefined, ['id', 'subsidiaryId']],
  ['deleteSubsidiary', RequestMethod.DELETE, ':id/subsidiaries/:subsidiaryId', undefined, ['id', 'subsidiaryId']],
  ['confirm', RequestMethod.POST, ':id/confirm', 200, ['id']],
  ['remove', RequestMethod.DELETE, ':id', 204, ['id']],
] as const;

describe('InventoryBoundariesController', () => {
  it('serves /inventory-boundaries', () => {
    expect(Reflect.getMetadata(PATH_METADATA, InventoryBoundariesController)).toBe('inventory-boundaries');
  });

  it.each(routes)('%s: method, path, status and uuid-piped ids', (name, method, path, status, ids) => {
    const handler = InventoryBoundariesController.prototype[name];
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(status);
    const args = Object.values(
      Reflect.getMetadata(ROUTE_ARGS_METADATA, InventoryBoundariesController, name) as Record<string, { data?: unknown; pipes: unknown[] }>,
    );
    const params = args.filter((a) => typeof a.data === 'string' && (ids as readonly string[]).includes(a.data));
    expect(params.map((p) => p.data).sort()).toEqual([...ids].sort());
    for (const p of params) expect(p.pipes).toContain(ParseUuidParamPipe);
  });

  it('refuses a write before its body is validated: the writer first, then the declaration\'s list sizes (security-rls P1)', () => {
    const guards = (name: keyof InventoryBoundariesController) =>
      (Reflect.getMetadata(GUARDS_METADATA, InventoryBoundariesController.prototype[name]) ?? []) as unknown[];
    expect(guards('list')).toEqual([]);
    expect(guards('get')).toEqual([]);
    for (const name of ['create', 'deleteSubsidiary', 'confirm', 'remove'] as const) expect(guards(name), name).toEqual([BoundaryWriterGuard]);
    expect(guards('putSubsidiary')).toEqual([BoundaryWriterGuard, DeclarationSizeGuard]);
  });
});

/** The controller compiled as `tsc` does — vitest's esbuild drops
 * `design:paramtypes`, the type the global pipe validates a body against
 * (`qa-auditor` P2: typed as an interface, a body went unvalidated and a
 * site outside its subsidiary's months reached the guard as a 500). */
const compiled = controllerModule<typeof import('./inventory-boundaries.controller')>(
  resolve(__dirname, './inventory-boundaries.controller.ts'), {
    '@nestjs/common': nest,
    '../auth/current-user.decorator': currentUser,
    '../common/parse-uuid-param.pipe': uuidPipe,
    './boundary-writer.guard': writerGuard,
    './dto/inventory-boundary.dto': dto,
    './inventory-boundaries.service': { InventoryBoundariesService: class {} },
  },
).InventoryBoundariesController;

describe('the compiled controller: each body and query validated by its DTO', () => {
  const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);
  const typeOf = (handler: string, index: number) =>
    (Reflect.getMetadata('design:paramtypes', compiled.prototype, handler) as unknown[])[index];

  it.each([
    ['list', 1, dto.ListInventoryBoundariesQueryDto],
    ['create', 1, dto.CreateInventoryBoundaryDto],
    ['putSubsidiary', 3, dto.PutInventoryBoundarySubsidiaryDto],
  ] as const)('%s takes its argument %i as its DTO', (handler, index, type) => {
    expect(typeOf(handler, index)).toBe(type);
  });

  it('refuses through them what the database would: a site before its subsidiary’s months, a copy of no id', async () => {
    const site = '1c000000-0000-4000-8000-000000000001';
    const put = { firstMonth: 4, lastMonth: 12, sites: [{ locationId: site, firstMonth: 1, lastMonth: 12 }], attribution: [], applicability: [], sources: [] };
    const putFailure = await pipe.transform(put, { type: 'body', metatype: typeOf('putSubsidiary', 3) as never }).catch((e: unknown) => e);
    expect(errorCodeOf(putFailure)).toBe('validation_failed');
    const createFailure = await pipe.transform({ reportingYear: 2026, copyOf: 'not-an-id' }, { type: 'body', metatype: typeOf('create', 1) as never }).catch((e: unknown) => e);
    expect(errorCodeOf(createFailure)).toBe('validation_failed');
  });
});
