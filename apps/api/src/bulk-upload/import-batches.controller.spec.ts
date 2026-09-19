import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ImportBatchesController } from './import-batches.controller';
import { UserThrottlerGuard } from './user-throttler.guard';
import { ParseUuidParamPipe } from '../common/parse-uuid-param.pipe';

/** Route metadata, as `bulk-submit.controller.spec.ts` does it (no testing module). */
describe('ImportBatchesController — the routes', () => {
  const proto = ImportBatchesController.prototype;

  it.each([
    ['list', RequestMethod.GET, '/'],
    ['detail', RequestMethod.GET, ':id'],
    ['sourceUrl', RequestMethod.GET, ':id/source-url'],
    ['submit', RequestMethod.POST, ':id/submit'],
  ] as const)('%s is %s /import-batches%s', (name, method, path) => {
    expect(Reflect.getMetadata(PATH_METADATA, ImportBatchesController)).toBe('import-batches');
    const handler = proto[name];
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
  });

  it.each(['detail', 'sourceUrl', 'submit'] as const)(
    '%s validates its :id as a uuid before any query',
    (name) => {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, ImportBatchesController, name) as Record<
        string,
        { data?: string; pipes?: unknown[] }
      >;
      const idArg = Object.values(args).find((a) => a.data === 'id');
      expect(idArg?.pipes).toContain(ParseUuidParamPipe);
    },
  );

  it('is throttled per user, and a batch submit has the bulk submit budget', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ImportBatchesController)).toContain(
      UserThrottlerGuard,
    );
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.submit)).toBe(10);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto.submit)).toBe(60_000);
  });
});
