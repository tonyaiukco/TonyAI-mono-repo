import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { EvidenceController } from './evidence.controller';
import { EVIDENCE_MULTIPART_LIMITS, SHARED_EVIDENCE_MULTIPART_LIMITS } from '../common/multipart-limits';
import { RuntimeUploadWorkInterceptor } from '../common/runtime-request';

describe('production evidence upload admission', () => {
  it.each([['upload', EVIDENCE_MULTIPART_LIMITS], ['uploadForRecords', SHARED_EVIDENCE_MULTIPART_LIMITS]] as const)(
    '%s receives bounded multipart before acquiring work permits', (method, limits) => {
      const [File, Work] = Reflect.getMetadata(INTERCEPTORS_METADATA, EvidenceController.prototype[method]);
      expect(new File().multer.limits).toEqual(limits);
      expect(Work).toBe(RuntimeUploadWorkInterceptor);
    },
  );
});
