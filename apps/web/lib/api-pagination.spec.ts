import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

vi.mock('./supabase', () => ({
  getSupabaseBrowserClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) },
  }),
}));

const fetchMock = vi.fn();
const respond = (body: unknown, status = 200) => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
};
const requested = () => new URL(fetchMock.mock.calls[0][0]);

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  respond({ items: [], limit: 50, nextCursor: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('LP4-05 paged client contracts', () => {
  it('omits every explicitly undefined key instead of searching for the word undefined', async () => {
    await api.listActivityRecordPage({
      subsidiaryId: undefined, year: undefined, period: undefined, category: undefined,
      status: undefined, locationId: undefined, periodValue: undefined, scope: undefined,
      search: undefined, sort: undefined, limit: undefined, cursor: undefined,
    });
    expect(requested().search).toBe('');
  });

  it('does not send page or unknown keys to metadata even when a wider object is passed', async () => {
    respond({ total: 0, latestReportingYear: null });
    const page = { search: 'Mfg', sort: 'newest' as const, limit: 25, cursor: 'abc', extra: 'ignored' };
    await api.activityRecordMetadata(page);
    expect(Object.fromEntries(requested().searchParams)).toEqual({ search: 'Mfg' });
  });

  it('reserves the null sentinel for the site filter', async () => {
    await expect(api.listActivityRecordPage({ subsidiaryId: null } as never))
      .rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 4800, 10000])('accepts legacy or server-configured report budgets: %s', async (recordLimit) => {
    respond({ recordLimit });
    expect((await api.reportMeta({ year: 2026 })).recordLimit).toBe(recordLimit);
  });

  it.each([null, 0, -1, 1.5, '5000', Number.MAX_SAFE_INTEGER + 1])('rejects invalid advertised report budgets: %s', async (recordLimit) => {
    respond({ recordLimit });
    await expect(api.reportMeta({ year: 2026 })).rejects.toMatchObject({ status: 502, code: 'internal_error' });
  });
  it('preserves all activity filters and opaque cursor bytes without draining pages', async () => {
    respond({ items: [{ id: 'record' }], limit: 25, nextCursor: 'next-page' });
    await api.listActivityRecordPage({
      subsidiaryId: 'sub', year: 2026, period: 'monthly', periodValue: 'March',
      category: 'Electricity', scope: 2, locationId: null,
      status: ['submitted', 'under_review'], sort: 'review_queue',
      search: 'A&B / 10% + meter', limit: 25, cursor: 'v1.+/= &opaque',
    });
    expect(requested().pathname).toBe('/api/v1/activity-records');
    expect(Object.fromEntries(requested().searchParams)).toEqual({
      subsidiaryId: 'sub', year: '2026', period: 'monthly', periodValue: 'March',
      category: 'Electricity', scope: '2', locationId: 'none',
      status: 'submitted,under_review', sort: 'review_queue',
      search: 'A&B / 10% + meter', limit: '25', cursor: 'v1.+/= &opaque',
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an omitted site filter from a selected site', async () => {
    await api.listActivityRecordPage({ locationId: 'site', status: [] });
    expect(requested().searchParams.get('locationId')).toBe('site');
    expect(requested().searchParams.has('status')).toBe(false);
    fetchMock.mockClear();
    respond({ items: [], limit: 50, nextCursor: null });
    await api.listActivityRecordPage();
    expect(requested().search).toBe('');
  });

  it('does not clamp invalid limits or silently reset an empty cursor', async () => {
    respond({ statusCode: 400, code: 'validation_failed', message: 'Invalid pagination.' }, 400);
    await expect(api.listActivityRecordPage({ limit: 0, cursor: '' }))
      .rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(requested().searchParams.get('limit')).toBe('0');
    expect(requested().searchParams.get('cursor')).toBe('');
  });

  it.each([
    [], [{ id: 'legacy-unbounded-record' }],
    { items: [], limit: 50 },
    { items: [], limit: 100, nextCursor: null },
    { items: Array.from({ length: 51 }, () => ({})), limit: 50, nextCursor: null },
    { items: [], limit: 50, nextCursor: 'endless' },
  ])('refuses incompatible server responses instead of silently truncating: %j', async (body) => {
    respond(body);
    await expect(api.listActivityRecordPage()).rejects.toMatchObject({
      status: 502, code: 'internal_error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a repeated cursor rather than fetching the same page forever', async () => {
    respond({ items: [{}], limit: 50, nextCursor: 'same' });
    await expect(api.listActivityRecordPage({ cursor: 'same' })).rejects.toBeInstanceOf(ApiError);
  });

  it('retains the legacy array client for the standalone PR A deployment', async () => {
    respond([{ id: 'legacy-record' }]);
    expect(await api.listActivityRecords()).toEqual([{ id: 'legacy-record' }]);
  });

  it('gets metadata using the same filter set, independently of a page', async () => {
    respond({ total: 90, latestReportingYear: 2026 });
    expect(await api.activityRecordMetadata({ status: ['submitted'], locationId: null }))
      .toEqual({ total: 90, latestReportingYear: 2026 });
    expect(requested().pathname).toBe('/api/v1/activity-records/metadata');
    expect(Object.fromEntries(requested().searchParams))
      .toEqual({ status: 'submitted', locationId: 'none' });
  });

  it('can request one exact period lock without relying on a history page', async () => {
    respond({ items: [], limit: 1, nextCursor: null });
    await api.listPeriodLockPage({
      subsidiaryId: 'sub', year: 2026, period: 'monthly', periodValue: 'March', limit: 1,
    });
    expect(requested().pathname).toBe('/api/v1/period-locks');
    expect(Object.fromEntries(requested().searchParams)).toEqual({
      subsidiaryId: 'sub', year: '2026', period: 'monthly', periodValue: 'March', limit: '1',
    });
  });

  it('pages evidence files while preserving each file’s complete linked-record metadata', async () => {
    const evidence = { id: 'evidence', linkedRecords: [{ id: 'r1' }, { id: 'r2' }] };
    respond({ items: [evidence], limit: 50, nextCursor: null });
    expect((await api.listEvidencePage('record')).items).toEqual([evidence]);
    expect(requested().pathname).toBe('/api/v1/activity-records/record/evidence');
  });

  it.each([
    [() => api.listTargetPage({ subsidiaryId: 'sub', limit: 50, cursor: 'previous' }), '/api/v1/targets',
      { subsidiaryId: 'sub', limit: '50', cursor: 'previous' }],
    [() => api.listDenominatorPage({ subsidiaryId: 'sub', year: 2026, limit: 50, cursor: 'previous' }), '/api/v1/denominators',
      { subsidiaryId: 'sub', year: '2026', limit: '50', cursor: 'previous' }],
  ] as const)('pages configuration history through %s', async (call, path, query) => {
    expect(await call()).toEqual({ items: [], limit: 50, nextCursor: null });
    expect(requested().pathname).toBe(path);
    expect(Object.fromEntries(requested().searchParams)).toEqual(query);
  });

  it('asks for progress only for explicit target ids, including an invalid empty set', async () => {
    respond([]);
    await api.targetPageProgress({ targetIds: ['t1', 't2'] });
    expect(requested().searchParams.get('targetIds')).toBe('t1,t2');
    fetchMock.mockClear();
    respond({ code: 'validation_failed', message: 'At least one target id is required.' }, 400);
    await expect(api.targetPageProgress({ targetIds: [] })).rejects.toMatchObject({ code: 'validation_failed' });
    expect(requested().searchParams.has('targetIds')).toBe(true);
    expect(requested().searchParams.get('targetIds')).toBe('');
  });

  it('accepts an ordered subset of requested progress ids', async () => {
    respond([{ targetId: 't1' }, { targetId: 't3' }]);
    expect(await api.targetPageProgress({ targetIds: ['t1', 't2', 't3'] }))
      .toEqual([{ targetId: 't1' }, { targetId: 't3' }]);
  });

  it('compares UUID identity independently of request letter case', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    respond([{ targetId: id }]);
    expect(await api.targetPageProgress({ targetIds: [id.toUpperCase()] })).toEqual([{ targetId: id }]);
  });

  it.each([
    [{ targetId: 'unrequested' }],
    [{ targetId: 't1' }, { targetId: 't1' }],
    [{ targetId: 't2' }, { targetId: 't1' }],
    [null], [{}], { items: [] },
    Array.from({ length: 500 }, (_, i) => ({ targetId: `t${i}` })),
  ])('rejects an unbounded or incompatible progress response: %j', async (body) => {
    respond(body);
    await expect(api.targetPageProgress({ targetIds: ['t1', 't2'] }))
      .rejects.toMatchObject({ status: 502, code: 'internal_error' });
  });

  it('preserves registered budget and rate refusal codes', async () => {
    for (const [status, code] of [[422, 'query_too_broad'], [429, 'rate_limited']] as const) {
      respond({ statusCode: status, code, message: 'Request refused.' }, status);
      await expect(api.listActivityRecordPage()).rejects.toMatchObject({ status, code });
    }
  });

  it('retains an exposed Retry-After without retrying the request', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'rate_limited' }), {
      status: 429, headers: { 'Retry-After': '30' },
    }));
    await expect(api.listActivityRecordPage()).rejects.toMatchObject({ retryAfter: '30' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
