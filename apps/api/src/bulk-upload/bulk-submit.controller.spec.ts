import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { BulkSubmitController } from './bulk-submit.controller';
import { BulkSubmitService } from './bulk-submit.service';
import { routeGroup } from '../common/runtime-limits';

/**
 * Route metadata rather than a Nest testing module, following
 * `subsidiaries.controller.spec.ts`: vitest/esbuild emits no
 * `design:paramtypes`, so a real testing module cannot resolve this
 * controller's constructor at all.
 *
 * What metadata CANNOT reach — that the global ValidationPipe actually binds
 * the DTO to this route — is e2e's, and PR 4 owns it. Without that binding the
 * id cap and the UUID shape are both unenforced.
 */
describe('BulkSubmitController — the route', () => {
  it('is POST /activity-records/bulk-submit, not a bulk-upload path', () => {
    // The resource is a record. The very next change extends this to drafts
    // nobody imported, at which point an upload-prefixed path would be a lie
    // and moving it would be a breaking change.
    expect(Reflect.getMetadata(PATH_METADATA, BulkSubmitController)).toBe(
      'activity-records',
    );
    const handler = BulkSubmitController.prototype.submitMany;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('bulk-submit');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
  });

  it('delegates admission to the global runtime guard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, BulkSubmitController),
    ).toBeUndefined();
    const handler = BulkSubmitController.prototype.submitMany;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBeUndefined();
  });

  it('hands the service the caller and the body, untouched', async () => {
    const service = { submitMany: vi.fn().mockResolvedValue({ submitted: [] }) };
    const controller = new BulkSubmitController(
      service as unknown as BulkSubmitService,
    );
    const user = { id: 'user-1' } as never;

    await controller.submitMany(user, { recordIds: ['a', 'b'] } as never);

    // A LITERAL, not the same object reference: vitest stores the reference,
    // so `dto.recordIds.splice(1)` before passing it along is invisible to an
    // assertion against the same object — the handler could drop every id but
    // the first and it would stay green.
    expect(service.submitMany).toHaveBeenCalledWith(user, {
      recordIds: ['a', 'b'],
    });
  });
});

it('uses the global grouped runtime policy', () => { expect(routeGroup('POST', '/api/v1/activity-records/bulk-submit')).toBe('SUBMIT'); });
