import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from './coded-validation.pipe';
import { ReportingContextQueryDto, reportingContext } from './reporting-context-query.dto';

const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);
const parse = (value: unknown) => pipe.transform(value, { type: 'query', metatype: ReportingContextQueryDto });
// The seed's fixed ids are not RFC 4122 (variant nibble 2); the shape accepts them.
const SEED_ID = '22222222-2222-2222-2222-222222222201';

describe('reporting context query validation', () => {
  it.each(['2000', '2027', '2100'])('requires and transforms the bounded year %s', async (year) => {
    expect(reportingContext(await parse({ year }))).toEqual({ year: Number(year) });
  });

  it('echoes only supplied fields without deriving scope from category', async () => {
    expect(reportingContext(await parse({ year: '2027', category: 'Fuel' }))).toEqual({ year: 2027, category: 'Fuel' });
    expect(reportingContext(await parse({ year: '2027', subsidiaryId: SEED_ID, scope: '1', category: 'Fuel' })))
      .toEqual({ year: 2027, subsidiaryId: SEED_ID, scope: 1, category: 'Fuel' });
  });

  it('echoes an uppercase id verbatim instead of lowercasing it (19)', async () => {
    // Not canonicalised: the acknowledgement must equal the request, and an
    // uppercase spelling matches no stored id, so the services answer empty.
    const upper = SEED_ID.toUpperCase().replace(/2/g, 'A');
    expect(reportingContext(await parse({ year: '2027', subsidiaryId: upper }))).toEqual({ year: 2027, subsidiaryId: upper });
  });

  it.each([
    {}, { year: '' }, { year: '1999' }, { year: '2101' }, { year: '2027.5' },
    { year: '2e3' }, { year: '2027junk' }, { year: ['2027', '2028'] },
    { year: '2027', scope: ['1', '2'] }, { year: '2027', subsidiaryId: ['a', 'b'] },
    { year: '2027', category: ['Fuel', 'Electricity'] }, { year: '2027', category: 'fuel' },
    { year: '2027', scope: '4' }, { year: '2027', scope: '' },
    { year: '2027', scope: '2', category: 'Fuel' }, { year: '2027', subsidiaryId: ' ' },
    { year: '2027', status: 'approved' }, { year: '2027', locationId: 'site-1' },
    { year: '2027', scope: null }, { year: '2027', category: null }, { year: '2027', subsidiaryId: null },
    // (19): the id is bounded by its shape — free text never reaches an audit row.
    { year: '2027', subsidiaryId: 'sub-1' }, { year: '2027', subsidiaryId: `${SEED_ID}0` },
    { year: '2027', subsidiaryId: ` ${SEED_ID}` }, { year: '2027', subsidiaryId: SEED_ID.replace(/-/g, '') },
    { year: '2027', subsidiaryId: '0'.repeat(37) }, { year: '2027', subsidiaryId: `{${SEED_ID}}` },
  ])('refuses malformed or broadening context %j with a registered code', async (query) => {
    await expect(parse(query)).rejects.toMatchObject({ response: { code: 'validation_failed' } });
  });
});
