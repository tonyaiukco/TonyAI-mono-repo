// The decorators need the metadata shim that `main.ts` normally loads.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_MAX_LINKED_RECORDS } from '@tonyai/shared-types';
import { UploadEvidenceForRecordsDto } from './upload-evidence-for-records.dto';

/**
 * The one field beside the file in `POST /evidence`, as multipart delivers
 * it: a string. Driven through the options `main.ts` installs.
 */
const PIPE_OPTIONS = { whitelist: true, forbidNonWhitelisted: true } as const;

function parse(body: unknown) {
  const dto = plainToInstance(UploadEvidenceForRecordsDto, body);
  return { dto, errors: validateSync(dto as object, PIPE_OPTIONS) };
}

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = '22222222-2222-2222-2222-222222220001'; // the seed's own shape: variant nibble 2

describe('UploadEvidenceForRecordsDto', () => {
  it('reads a JSON array of ids, in either case, including the seed’s ids', () => {
    const { dto, errors } = parse({ recordIds: JSON.stringify([A, B.toUpperCase()]) });
    expect(errors).toEqual([]);
    expect(dto.recordIds).toEqual([A, B.toUpperCase()]);
  });

  it.each([
    ['an empty array', '[]'],
    ['a bare id rather than an array', A],
    ['not JSON at all', '[aaaa'],
    ['a JSON object', JSON.stringify({ ids: [A] })],
    ['a non-string element', JSON.stringify([A, 7])],
    ['an unhyphenated id', JSON.stringify([A.replaceAll('-', '')])],
    ['a braced id', JSON.stringify([`{${A}}`])],
  ])('refuses %s', (_label, value) => {
    expect(parse({ recordIds: value }).errors).toHaveLength(1);
  });

  it('refuses a missing field and an unknown one', () => {
    expect(parse({}).errors).toHaveLength(1);
    expect(parse({ recordIds: JSON.stringify([A]), dryRun: 'true' }).errors).toHaveLength(1);
  });

  it('caps the list at EVIDENCE_MAX_LINKED_RECORDS', () => {
    const ids = (n: number) =>
      JSON.stringify(Array.from({ length: n }, (_, i) => `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, '0')}`));
    expect(parse({ recordIds: ids(EVIDENCE_MAX_LINKED_RECORDS) }).errors).toEqual([]);
    expect(parse({ recordIds: ids(EVIDENCE_MAX_LINKED_RECORDS + 1) }).errors).toHaveLength(1);
  });
});
