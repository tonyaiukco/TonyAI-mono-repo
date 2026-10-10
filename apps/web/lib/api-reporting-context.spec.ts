import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportingContext, ReportingExportParams } from '@tonyai/shared-types';
import { api } from './api';

vi.mock('./supabase', () => ({
  getSupabaseBrowserClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'fixture-token' } } }) },
  }),
}));

const fetchMock = vi.fn();
const context: ReportingContext = { year: 2027, subsidiaryId: 'sub-a', scope: 2, category: 'Electricity' };
const respond = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
const requested = () => new URL(fetchMock.mock.calls[0][0]);
const intensityData = {
  selectedSubsidiaryIds: ['sub-a'],
  metrics: [{ metric: 'revenue', unit: 'M EUR', emissionsTotal: 10, denominatorTotal: 2,
    intensity: 5, contributingSubsidiaryIds: ['sub-a'], uncalculatedRecordCount: 0 }],
};
const matrixData = {
  reportingYear: 2027,
  rows: [{ subsidiaryId: 'sub-a', cells: [{ scope: 2, category: 'Electricity' }] }],
  totals: { complete: 1, incomplete: 0, missing: 0 },
};
const unsupportedNarrowings = ['locationId', 'period', 'periodValue'].flatMap((key) =>
  ['narrow-selection', '', null, false, 0].map((value) => ({ key, value })));

beforeEach(() => { vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

const reads = [
  { name: 'summary', call: api.reportingSummary, path: '/api/v1/emissions/context/summary', data: {} },
  { name: 'matrix', call: api.reportingMatrix, path: '/api/v1/emissions/context/tracking-matrix', data: matrixData },
  { name: 'meta', call: api.reportingMeta, path: '/api/v1/reports/context/meta', data: { recordLimit: 5000 } },
  { name: 'intensity', call: api.reportingIntensity, path: '/api/v1/intensity/context', data: intensityData },
];

describe.each(reads)('annual $name client', ({ call, path, data }) => {
  it('carries one context on the new route and authenticates the request', async () => {
    respond({ context, data });
    expect(await call(context)).toEqual({ context, data });
    expect(requested().pathname).toBe(path);
    expect(Object.fromEntries(requested().searchParams)).toEqual({
      year: '2027', subsidiaryId: 'sub-a', scope: '2', category: 'Electricity',
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows empty authorized results without converting a selected entity to all', async () => {
    const absent = { year: 2027, subsidiaryId: 'inaccessible-or-missing' };
    const empty = path.includes('intensity') ? { selectedSubsidiaryIds: [], metrics: [] }
      : path.includes('matrix') ? { ...matrixData, rows: [] } : {};
    respond({ context: absent, data: empty });
    await call(absent);
    expect(requested().searchParams.get('subsidiaryId')).toBe('inaccessible-or-missing');
  });

  it('omits absent filters and excludes view-local keys', async () => {
    const annual = { year: 2025, scope: undefined, subsidiaryId: undefined, category: undefined,
      status: ['draft'], search: 'search only', sort: 'newest', limit: 10, cursor: 'next',
      locationId: undefined, period: undefined, periodValue: undefined };
    respond({ context: { year: 2025 }, data: path.includes('matrix') ? { ...matrixData, reportingYear: 2025 } : data });
    await call(annual);
    expect(Object.fromEntries(requested().searchParams)).toEqual({ year: '2025' });
  });

  it.each(unsupportedNarrowings)('F2 refuses unsupported narrowing $key=$value before fetching', async ({ key, value }) => {
    respond({ context, data });
    await expect(call({ ...context, [key]: value })).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { year: 2027, metrics: [] }, null, [], { context, data: null }, { context },
    { context: { ...context, year: 2026 }, data },
    { context: { ...context, subsidiaryId: 'sub-b' }, data },
    { context: { ...context, subsidiaryId: undefined }, data },
    { context: { ...context, scope: undefined }, data },
    { context: { ...context, category: undefined }, data },
  ])('rejects legacy, absent or mismatched acknowledgements: %j', async (body) => {
    respond(body);
    await expect(call(context)).rejects.toMatchObject({ status: 502, code: 'internal_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 429, 500])('preserves a %s refusal without retrying a legacy endpoint', async (status) => {
    respond({ message: 'Fixture refusal', code: status === 401 ? 'unauthorized' : 'bad_request' }, status);
    await expect(call(context)).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requested().pathname).toBe(path);
  });

  it.each([
    null, [], {}, { year: 1999 }, { year: 2101 }, { year: '2027' },
    { year: 2027, subsidiaryId: '' }, { year: 2027, subsidiaryId: null },
    { year: 2027, scope: 1, category: 'Electricity' },
    { year: 2027, scope: 4 }, { year: 2027, category: 'typo' },
  ])('refuses invalid selection before any network call: %j', async (params) => {
    await expect(call(params as never)).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks the captured request even if the caller mutates its selection while waiting', async () => {
    const mutable = { ...context };
    respond({ context, data });
    const result = call(mutable);
    mutable.year = 2025;
    await expect(result).resolves.toMatchObject({ context: { year: 2027 } });
    expect(requested().searchParams.get('year')).toBe('2027');
  });
});

describe('D14 and denominator coverage', () => {
  it.each([undefined, null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1])(
    'F3 rejects invalid numerator coverage count %s', async (uncalculatedRecordCount) => {
      respond({ context, data: { ...intensityData, metrics: [{ ...intensityData.metrics[0], uncalculatedRecordCount }] } });
      await expect(api.reportingIntensity(context)).rejects.toMatchObject({ status: 502, code: 'internal_error' });
    },
  );

  it.each([0, 3, Number.MAX_SAFE_INTEGER])('preserves numerator coverage count %s', async (uncalculatedRecordCount) => {
    respond({ context, data: { ...intensityData, metrics: [{ ...intensityData.metrics[0], uncalculatedRecordCount }] } });
    expect((await api.reportingIntensity(context)).data.metrics[0].uncalculatedRecordCount).toBe(uncalculatedRecordCount);
  });

  it('F6 rejects duplicate metric/unit groups', async () => {
    const metric = intensityData.metrics[0];
    respond({ context: { year: 2027 }, data: { selectedSubsidiaryIds: ['sub-a', 'sub-b'],
      metrics: [metric, { ...metric, contributingSubsidiaryIds: ['sub-b'] }] } });
    await expect(api.reportingIntensity({ year: 2027 })).rejects.toMatchObject({ status: 502, code: 'internal_error' });
  });

  it('F6 rejects contributors overlapping across units of the same metric', async () => {
    const metric = intensityData.metrics[0];
    respond({ context, data: { ...intensityData, metrics: [metric, { ...metric, unit: 'M USD' }] } });
    await expect(api.reportingIntensity(context)).rejects.toMatchObject({ status: 502, code: 'internal_error' });
  });

  it('permits disjoint units for one metric and shared contributors for different metrics', async () => {
    const metric = intensityData.metrics[0];
    const group = { year: 2027 };
    const separateUnits = { selectedSubsidiaryIds: ['sub-a', 'sub-b'], metrics: [metric,
      { ...metric, unit: 'M USD', contributingSubsidiaryIds: ['sub-b'] }] };
    respond({ context: group, data: separateUnits });
    await expect(api.reportingIntensity(group)).resolves.toMatchObject({ data: separateUnits });
    const differentMetrics = { ...intensityData, metrics: [metric, { ...metric, metric: 'area', unit: 'm²' }] };
    respond({ context, data: differentMetrics });
    await expect(api.reportingIntensity(context)).resolves.toMatchObject({ data: differentMetrics });
  });
  it('permits partial coverage of the selected accessible group', async () => {
    const group = { year: 2027 };
    const data = { ...intensityData, selectedSubsidiaryIds: ['sub-a', 'sub-b'] };
    respond({ context: group, data });
    expect((await api.reportingIntensity(group)).data).toEqual(data);
  });

  it('permits a physical metric only for an explicitly selected subsidiary', async () => {
    const data = { ...intensityData, metrics: [{ ...intensityData.metrics[0], metric: 'area', unit: 'm²' }] };
    respond({ context, data });
    await expect(api.reportingIntensity(context)).resolves.toMatchObject({ data });
    const group = { year: 2027 };
    respond({ context: group, data });
    await expect(api.reportingIntensity(group)).rejects.toMatchObject({ status: 502 });
  });

  it.each([
    {}, { ...intensityData, selectedSubsidiaryIds: ['sub-b'] },
    { ...intensityData, selectedSubsidiaryIds: ['sub-a', 'sub-a'] },
    { ...intensityData, selectedSubsidiaryIds: [''] },
    { ...intensityData, metrics: null },
    ...[undefined, [], ['sub-b'], ['sub-a', 'sub-a']].map((contributingSubsidiaryIds) => ({
      ...intensityData, metrics: [{ ...intensityData.metrics[0], contributingSubsidiaryIds }],
    })),
  ])('rejects incompatible coverage: %j', async (data) => {
    respond({ context, data });
    await expect(api.reportingIntensity(context)).rejects.toMatchObject({ status: 502, code: 'internal_error' });
  });
});

describe('returned matrix selection', () => {
  it.each([
    { name: 'year', data: { ...matrixData, reportingYear: 2026 } },
    { name: 'subsidiary', data: { ...matrixData, rows: [{ ...matrixData.rows[0], subsidiaryId: 'sub-b' }] } },
    { name: 'scope', data: { ...matrixData, rows: [{ ...matrixData.rows[0], cells: [{ category: 'Electricity', scope: 1 }] }] } },
    { name: 'category', data: { ...matrixData, rows: [{ ...matrixData.rows[0], cells: [{ category: 'Natural Gas', scope: 2 }] }] } },
  ])('F6 rejects a matrix with the wrong $name despite a matching acknowledgement', async ({ data }) => {
    respond({ context, data });
    await expect(api.reportingMatrix(context)).rejects.toMatchObject({ status: 502, code: 'internal_error' });
  });

  it('permits multiple subsidiaries and categories when those filters are absent', async () => {
    const group = { year: 2027 };
    const data = { ...matrixData, rows: [...matrixData.rows,
      { subsidiaryId: 'sub-b', cells: [{ scope: 1, category: 'Natural Gas' }] }] };
    respond({ context: group, data });
    await expect(api.reportingMatrix(group)).resolves.toMatchObject({ data });
  });
});

describe('report metadata retains LP4-05 row budgets', () => {
  it.each([0, -1, 1.5, '5000', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid limit %s', async (recordLimit) => {
    respond({ context, data: { recordLimit } });
    await expect(api.reportingMeta(context)).rejects.toMatchObject({ status: 502 });
  });
});

describe('context exports', () => {
  const click = vi.fn();
  const createObjectURL = vi.fn(() => 'blob:report');
  const revokeObjectURL = vi.fn();
  const anchor = { href: '', download: '', click };
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL);
  });
  const params: ReportingExportParams = {
    ...context, template: 'ghg_protocol_detail', includeMethodologyNotes: false, includeEvidenceSummary: true,
  };
  it.each(['pdf', 'excel', 'csv'] as const)('downloads %s with exactly the preview context', async (kind) => {
    fetchMock.mockResolvedValue(new Response('fixture export', {
      headers: { 'Content-Disposition': 'attachment; filename="fixture-export"' },
    }));
    await api.downloadReportingReport(kind, { ...params, search: 'local', status: ['draft'], sort: 'newest',
      limit: 10, cursor: 'next', locationId: undefined, period: undefined, periodValue: undefined } as ReportingExportParams);
    expect(requested().pathname).toBe(`/api/v1/reports/context/${kind}`);
    expect(Object.fromEntries(requested().searchParams)).toEqual({
      year: '2027', subsidiaryId: 'sub-a', scope: '2', category: 'Electricity',
      template: 'ghg_protocol_detail', includeMethodologyNotes: 'false', includeEvidenceSummary: 'true',
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture-token');
    expect(anchor.download).toBe('fixture-export');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');
  });

  it.each(unsupportedNarrowings)('F2 refuses export narrowing $key=$value before fetching', async ({ key, value }) => {
    fetchMock.mockResolvedValue(new Response('fixture export'));
    await expect(api.downloadReportingReport('pdf', { ...params, [key]: value }))
      .rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 422, 429, 500])('does not download or fall back after %s', async (status) => {
    respond({ message: 'Fixture refusal' }, status);
    await expect(api.downloadReportingReport('pdf', params)).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('refuses invalid context before downloading', async () => {
    await expect(api.downloadReportingReport('pdf', { ...params, year: 2101 }))
      .rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it('preserves the legacy optional-year intensity client until implementation', async () => {
  respond({ year: null, metrics: [] });
  expect(await api.intensity()).toEqual({ year: null, metrics: [] });
  expect(requested().pathname).toBe('/api/v1/intensity');
  expect(requested().search).toBe('');
});
