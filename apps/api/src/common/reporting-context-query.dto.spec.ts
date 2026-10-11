import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from './coded-validation.pipe';
import { ReportingContextQueryDto, reportingContext } from './reporting-context-query.dto';

const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);
const parse = (value: unknown) => pipe.transform(value, { type: 'query', metatype: ReportingContextQueryDto });

describe('reporting context query validation', () => {
  it.each(['2000', '2027', '2100'])('requires and transforms the bounded year %s', async (year) => {
    expect(reportingContext(await parse({ year }))).toEqual({ year: Number(year) });
  });

  it('echoes only supplied fields without deriving scope from category', async () => {
    expect(reportingContext(await parse({ year: '2027', category: 'Fuel' }))).toEqual({ year: 2027, category: 'Fuel' });
    expect(reportingContext(await parse({ year: '2027', subsidiaryId: 'sub-1', scope: '1', category: 'Fuel' })))
      .toEqual({ year: 2027, subsidiaryId: 'sub-1', scope: 1, category: 'Fuel' });
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
  ])('refuses malformed or broadening context %j with a registered code', async (query) => {
    await expect(parse(query)).rejects.toMatchObject({ response: { code: 'validation_failed' } });
  });
});
