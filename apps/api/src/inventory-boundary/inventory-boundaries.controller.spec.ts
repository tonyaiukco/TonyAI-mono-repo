import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';
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
});
