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
import { routeGroup } from '../common/runtime-limits';

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

  it('offers the template at GET /bulk-upload/template', () => {
    expect(route('template')).toEqual({
      path: 'template',
      method: RequestMethod.GET,
    });
  });

  it('gives the template its own, looser limit', () => {
    // NOT because a tighter one would eat the import budget — throttler keys
    // include the handler name, so the two routes could never share a bucket,
    // and an earlier version of this test was named for that false premise.
    // The reason is cost: this workbook is tens of milliseconds against an
    // import's thousands.
    const handler = BulkUploadController.prototype.template;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBeUndefined();
    expect(routeGroup('POST', '/api/v1/bulk-upload/activity-records')).toBe('IMPORT');
  });

  it('hands the template route the caller, and the download headers', async () => {
    // Metadata alone left five mutations alive, every one of them shipping:
    // passing `{...user, accessibleSubsidiaryIds: []}` (an entity-less
    // template for everyone, forever), returning an empty buffer, mislabelling
    // it `text/csv`, renaming the file, and dropping `Content-Disposition`
    // entirely so an XLSX renders as binary garbage in the tab. This is the
    // same gap the header comment on this file exists to record.
    const buffer = Buffer.from('PK-not-really-a-workbook');
    const service = { template: vi.fn().mockResolvedValue(buffer) };
    const controller = new BulkUploadController(
      service as unknown as BulkUploadService,
    );
    const sent: unknown[] = [];
    const headers: Record<string, unknown>[] = [];
    const res = {
      set: vi.fn((h: Record<string, unknown>) => {
        headers.push(h);
        return res;
      }),
      send: vi.fn((b: unknown) => sent.push(b)),
    };
    const user = { id: 'user-1', accessibleSubsidiaryIds: ['sub-1'] } as never;

    await controller.template(user, res as never);

    // The caller, untouched — not a copy with an emptied access set.
    expect(service.template).toHaveBeenCalledWith(user);
    expect(sent).toEqual([buffer]);
    expect(headers[0]).toMatchObject({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':
        'attachment; filename="tonyai-bulk-upload-template.xlsx"',
      'Content-Length': buffer.length,
      // The body is this caller's own entity register and the response
      // carries no `Vary: Authorization`.
      'Cache-Control': 'no-store',
    });
  });

  it('delegates admission to the global runtime guard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      BulkUploadController,
    ) as unknown[];
    expect(guards).toBeUndefined();
  });

  it('has no competing per-handler throttle', () => {
    const handler = BulkUploadController.prototype.import;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBeUndefined();
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

    expect(options.limits.fileSize).toBe(BULK_UPLOAD_MAX_SIZE_BYTES + 1);
    expect(options.limits.files).toBe(1);
    expect(options.limits.fields).toBeLessThanOrEqual(4);
    // Round-1 DE-8: multer decodes filename bytes as latin1 by default, so a
    // Turkish filename arrives mangled before any of our code sees it — and
    // this one is echoed in the report AND written to the audit row.
    expect(options.defParamCharset).toBe('utf8');
  });
});

it('uses the global grouped runtime policy', () => { expect(routeGroup('POST', '/api/v1/bulk-upload/activity-records')).toBe('IMPORT'); });
