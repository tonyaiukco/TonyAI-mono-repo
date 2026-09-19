import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BulkUploadModule } from './bulk-upload.module';
import { StorageModule } from '../storage/storage.module';

/**
 * The importer and the batch routes inject `StorageService`, and
 * `StorageModule` is not global — without this import the API does not boot
 * (measured: "Nest can't resolve dependencies of BulkUploadService"). A Nest
 * testing module cannot catch it here, because vitest's esbuild emits no
 * `design:paramtypes`; the module's own metadata can.
 */
describe('BulkUploadModule', () => {
  it('imports StorageModule, which its services inject', () => {
    expect(Reflect.getMetadata('imports', BulkUploadModule)).toContain(StorageModule);
  });
});
