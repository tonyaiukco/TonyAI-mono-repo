import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { CodedValidationPipe, GLOBAL_VALIDATION_OPTIONS } from '../../common/coded-validation.pipe';
import { selectionOf } from '../report-datasets.service';
import { CaptureReportDatasetDto, ListReportDatasetsQueryDto } from './report-dataset.dto';

/** The capture body and the list query through the real global pipe (LP3-04 PR C, V3). */

const pipe = new CodedValidationPipe(GLOBAL_VALIDATION_OPTIONS);
const ID = '0B1D0000-0000-4000-8000-000000000001';

async function through(metatype: unknown, body: unknown, type: 'body' | 'query' = 'body') {
  try {
    return { value: await pipe.transform(body, { type, metatype: metatype as never }) };
  } catch (e) {
    return { refused: (e as { getResponse(): { code: string; message: string[] } }).getResponse() };
  }
}

describe('CaptureReportDatasetDto', () => {
  it('admits a version alone — an inventory — its id lower-cased', async () => {
    const { value } = await through(CaptureReportDatasetDto, { boundaryId: ID });
    expect(value).toEqual(expect.objectContaining({ boundaryId: ID.toLowerCase() }));
    // class-transformer creates the absent keys as undefined; the selection
    // drops them, so no `undefined` reaches the fingerprinted context.
    expect(selectionOf(value as CaptureReportDatasetDto)).toEqual({});
  });

  it('admits an extract — a subsidiary, a scope and one of its categories', async () => {
    const { value } = await through(CaptureReportDatasetDto, { boundaryId: ID, subsidiaryId: ID, scope: 2, category: 'Electricity' });
    expect(value).toMatchObject({ subsidiaryId: ID.toLowerCase(), scope: 2, category: 'Electricity' });
  });

  it.each([
    ['no version', {}],
    ['a version that is no id', { boundaryId: 'b-1' }],
    ['a null filter', { boundaryId: ID, subsidiaryId: null }],
    ['a null scope', { boundaryId: ID, scope: null }],
    ['a scope beyond three', { boundaryId: ID, scope: 4 }],
    ['a scope as text', { boundaryId: ID, scope: '2' }],
    ['an unknown category', { boundaryId: ID, category: 'Steam' }],
    ['a null category', { boundaryId: ID, category: null }],
    ["a category outside the scope's", { boundaryId: ID, scope: 1, category: 'Electricity' }],
    ['a field the request has not', { boundaryId: ID, year: 2026 }],
    ['a selection sent', { boundaryId: ID, selection: 'inventory' }],
  ])('refuses %s', async (_case, body) => {
    const { refused } = await through(CaptureReportDatasetDto, body);
    expect(refused?.code).toBe('validation_failed');
  });
});

describe('ListReportDatasetsQueryDto', () => {
  it('reads the year from the query string', async () => {
    expect((await through(ListReportDatasetsQueryDto, { year: '2026' }, 'query')).value).toMatchObject({ year: 2026 });
  });
  it.each([{}, { year: 'x' }, { year: '1999' }, { year: ['2026', '2027'] }])('refuses %j', async (query) => {
    expect((await through(ListReportDatasetsQueryDto, query, 'query')).refused?.code).toBe('validation_failed');
  });
});
