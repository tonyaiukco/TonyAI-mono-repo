import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  GUARDS_METADATA,
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { BULK_UPLOAD_MAX_SIZE_BYTES } from '@tonyai/shared-types';
import { BulkUploadController } from './bulk-upload.controller';
import { BulkUploadService } from './bulk-upload.service';
import { UserThrottlerGuard } from './user-throttler.guard';

/**
 * This controller had no spec, and a mutation sweep showed what that cost:
 * replacing `this.service.import(user, file, options)` with a hardcoded
 * `{ dryRun: false }` passed all 819 tests. The service's dry-run proof is
 * genuine, but the controller is the only thing that hands the service the
 * flag — so "show me what would happen to these 1,000 rows" could silently
 * become 1,000 irreversible audited writes with CI green. Every other
 * decorator on the route was equally deletable.
 *
 * Route metadata rather than a Nest testing module, following
 * `subsidiaries.controller.spec.ts`: vitest/esbuild emits no
 * `design:paramtypes`, so a real testing module cannot resolve this
 * controller's constructor at all. The one thing metadata cannot reach is the
 * multipart FIELD NAME, which is closed over inside the generated interceptor
 * class — that needs the real wire, and is covered by the e2e spec.
 */
function route(method: keyof BulkUploadController) {
  const handler = BulkUploadController.prototype[method];
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler) as string,
    method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
  };
}

describe('BulkUploadController — the route', () => {
  it('is POST /bulk-upload/activity-records', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BulkUploadController)).toBe(
      'bulk-upload',
    );
    expect(route('import')).toEqual({
      path: 'activity-records',
      method: RequestMethod.POST,
    });
  });

  it('passes the caller’s options through, untouched', async () => {
    // The mutation this file exists for. A hardcoded `{ dryRun: false }` here
    // turns a preview into an import, and nothing else in the suite looks.
    const service = { import: vi.fn().mockResolvedValue({ accepted: [] }) };
    const controller = new BulkUploadController(
      service as unknown as BulkUploadService,
    );
    const user = { id: 'user-1' } as never;
    const file = { originalname: 'x.csv' } as never;

    await controller.import(user, file, { dryRun: true });

    expect(service.import).toHaveBeenCalledWith(user, file, { dryRun: true });
  });

  it('is rate-limited per USER, not per socket address', () => {
    // `ThrottlerGuard`'s default tracker is `req.ip`, and this API never
    // enables `trust proxy` — behind a reverse proxy that is one bucket for
    // the whole product. Pinning the guard CLASS is what keeps the override.
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      BulkUploadController,
    ) as unknown[];
    expect(guards).toContain(UserThrottlerGuard);
  });

  it('carries a throttle limit', () => {
    const handler = BulkUploadController.prototype.import;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });

  it('bounds the upload: size, one file, and a handful of fields', () => {
    // busboy defaults `fields` and `parts` to Infinity, and
    // `forbidNonWhitelisted` only rejects extras after multer has buffered
    // every one of them.
    const [Interceptor] = Reflect.getMetadata(
      INTERCEPTORS_METADATA,
      BulkUploadController.prototype.import,
    ) as (new (...args: never[]) => { multer?: Record<string, unknown> })[];
    const options = new Interceptor().multer as {
      limits: Record<string, number>;
      defParamCharset: string;
    };

    expect(options.limits.fileSize).toBe(BULK_UPLOAD_MAX_SIZE_BYTES);
    expect(options.limits.files).toBe(1);
    expect(options.limits.fields).toBeLessThanOrEqual(4);
    // Round-1 DE-8: multer decodes filename bytes as latin1 by default, so a
    // Turkish filename arrives mangled before any of our code sees it — and
    // this one is echoed in the report AND written to the audit row.
    expect(options.defParamCharset).toBe('utf8');
  });
});
