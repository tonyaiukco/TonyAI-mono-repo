import { BULK_UPLOAD_MAX_SIZE_BYTES, EVIDENCE_MAX_SIZE_BYTES } from '@tonyai/shared-types';

// Busboy refuses fileSize, fieldSize and parts at equality. Sentinels make
// the public ceilings inclusive; the services also enforce the file ceiling.
const limits = (fileBytes: number, fields: number, fieldBytes: number) => ({
  fileSize: fileBytes + 1, files: 1, fields, parts: fields + 2, fieldSize: fieldBytes + 1,
});
export const IMPORT_MULTIPART_LIMITS = limits(BULK_UPLOAD_MAX_SIZE_BYTES, 4, 16_384);
export const EVIDENCE_MULTIPART_LIMITS = limits(EVIDENCE_MAX_SIZE_BYTES, 4, 16_384);
export const SHARED_EVIDENCE_MULTIPART_LIMITS = limits(EVIDENCE_MAX_SIZE_BYTES, 2, 65_536);
