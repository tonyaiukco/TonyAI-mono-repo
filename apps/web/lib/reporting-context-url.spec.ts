import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REPORTING_YEAR, type ReportingContext } from '@tonyai/shared-types';
import {
  nextReportingContext,
  parseReportingContextUrl,
  parseReportingYearParam,
  queryString,
  reportingContextKey,
  reportingContextQuery,
  resolveReportingContext,
} from './reporting-context-url';
import { forgetOnSessionChange, rememberedContextFor, useReportingContextStore } from './store';

const SUB = '22222222-2222-2222-2222-222222222201';
const OTHER = '22222222-2222-2222-2222-222222222202';
const q = (search: string) => new URLSearchParams(search);
const parse = (search: string) => parseReportingContextUrl(q(search));
/** Parse, then resolve against `remembered` — what a screen ends up using. */
const resolve = (search: string, remembered: ReportingContext | null = null) => {
  const parsed = parse(search);
  if (!parsed.ok) throw new Error(`refused: ${parsed.invalid.join(',')}`);
  return resolveReportingContext(parsed.explicit, remembered);
};

describe('reporting year link values', () => {
  it.each([['2000', 2000], ['2026', 2026], ['2027', 2027], ['2100', 2100]])('reads %s', (raw, year) => {
    expect(parseReportingYearParam(raw)).toBe(year);
  });
  it.each(['', ' 2027', '2027 ', '02027', '1999', '2101', '2026.5', '2e3', '2027junk', 'abc', '-2027', '+2027', 'all'])(
    'refuses %j instead of defaulting',
    (raw) => {
      expect(parseReportingYearParam(raw)).toBeNull();
    },
  );
});

describe('parseReportingContextUrl', () => {
  it('reads every field strictly and maps the clear value to null', () => {
    expect(parse(`year=2027&subsidiaryId=${SUB}&scope=2&category=Electricity`)).toEqual({
      ok: true,
      explicit: { year: 2027, subsidiaryId: SUB, scope: 2, category: 'Electricity' },
    });
    expect(parse('year=2027&subsidiaryId=all&scope=all&category=all')).toEqual({
      ok: true,
      explicit: { year: 2027, subsidiaryId: null, scope: null, category: null },
    });
    expect(parse('')).toEqual({ ok: true, explicit: {} });
  });

  it.each([
    ['year=', ['year']],
    ['year=02027', ['year']],
    ['year=1999', ['year']],
    ['year=2101', ['year']],
    ['year=2026.5', ['year']],
    ['year=abc', ['year']],
    ['year=all', ['year']],
    ['year=2026&year=2027', ['year']],
    ['year=2026&year=2026', ['year']],
    ['subsidiaryId=', ['subsidiaryId']],
    ['subsidiaryId=sub-1', ['subsidiaryId']],
    [`subsidiaryId=${SUB}0`, ['subsidiaryId']],
    [`subsidiaryId=${SUB}&subsidiaryId=${OTHER}`, ['subsidiaryId']],
    ['scope=', ['scope']],
    ['scope=01', ['scope']],
    ['scope=4', ['scope']],
    ['scope=1&scope=1', ['scope']],
    ['category=', ['category']],
    ['category=fuel', ['category']],
    ['category=Nonsense', ['category']],
    ['scope=2&category=Fuel', ['scope', 'category']],
    ['year=1999&scope=9', ['year', 'scope']],
    ['year=02027&scope=1&category=Electricity', ['year', 'scope', 'category']],
  ])('refuses %s, naming %j', (search, invalid) => {
    expect(parse(search)).toEqual({ ok: false, invalid });
  });

  it('lets a clear sit beside anything', () => {
    expect(parse('scope=all&category=Fuel')).toEqual({ ok: true, explicit: { scope: null, category: 'Fuel' } });
    expect(parse('scope=1&category=all')).toEqual({ ok: true, explicit: { scope: 1, category: null } });
  });

  it('keeps an uppercase id verbatim — the API answers it empty, never as all', () => {
    const upper = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAA01';
    expect(parse(`subsidiaryId=${upper}`)).toEqual({ ok: true, explicit: { subsidiaryId: upper } });
  });
});

describe('resolveReportingContext', () => {
  const remembered: ReportingContext = { year: 2025, subsidiaryId: SUB, scope: 1, category: 'Fuel' };

  it('defaults to D06 2026, all accessible subsidiaries and no filter', () => {
    expect(resolve('')).toEqual({ year: DEFAULT_REPORTING_YEAR });
    expect(DEFAULT_REPORTING_YEAR).toBe(2026);
  });

  it('keeps D06 whatever the clock says — New Year 2027 changes no default', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2027-01-04T10:00:00Z'));
      expect(resolve('')).toEqual({ year: 2026 });
      expect(reportingContextQuery(resolveReportingContext({}, null)!)).toBe('year=2026&subsidiaryId=all&scope=all&category=all');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fills each absent field from the remembered selection', () => {
    expect(resolve('', remembered)).toEqual(remembered);
    expect(resolve('year=2027', remembered)).toEqual({ ...remembered, year: 2027 });
    expect(resolve(`subsidiaryId=${OTHER}`, remembered)).toEqual({ ...remembered, subsidiaryId: OTHER });
  });

  it('lets an explicit clear beat a remembered narrowing filter', () => {
    expect(resolve('subsidiaryId=all', remembered)).toEqual({ year: 2025, scope: 1, category: 'Fuel' });
    expect(resolve('year=2026&subsidiaryId=all&scope=all&category=all', remembered)).toEqual({ year: 2026 });
  });

  it('resolves scope and category together, so a remembered one never narrows or contradicts the link', () => {
    // The link names scope 2; the remembered Fuel (scope 1) must not survive.
    expect(resolve('scope=2', remembered)).toEqual({ year: 2025, subsidiaryId: SUB, scope: 2 });
    // The link names a category; the remembered scope does not narrow it.
    expect(resolve('category=Electricity', remembered)).toEqual({ year: 2025, subsidiaryId: SUB, category: 'Electricity' });
    expect(resolve('category=all', remembered)).toEqual({ year: 2025, subsidiaryId: SUB });
  });

  it('refuses a corrupt remembered pair rather than using it', () => {
    expect(resolveReportingContext({}, { year: 2026, scope: 2, category: 'Fuel' })).toBeNull();
  });
});

describe('canonical URL', () => {
  it('writes all four keys once, in order, with the clear spelled all', () => {
    expect(reportingContextQuery({ year: 2027 })).toBe('year=2027&subsidiaryId=all&scope=all&category=all');
    expect(reportingContextQuery({ year: 2026, subsidiaryId: SUB, scope: 2, category: 'Electricity' }))
      .toBe(`year=2026&subsidiaryId=${SUB}&scope=2&category=Electricity`);
  });

  it('keeps the page\'s own keys and drops repeated context keys', () => {
    const params = q('tab=history&year=2026&year=2027&scope=1');
    expect(reportingContextQuery({ year: 2027 }, params)).toBe('year=2027&subsidiaryId=all&scope=all&category=all&tab=history');
  });

  it('round-trips: parsing the canonical URL resolves to the same context, whatever is remembered', () => {
    const contexts: ReportingContext[] = [
      { year: 2026 },
      { year: 2027, subsidiaryId: SUB },
      { year: 2025, scope: 3 },
      { year: 2100, subsidiaryId: OTHER, scope: 2, category: 'Electricity' },
      { year: 2000, category: 'Natural Gas' },
    ];
    const remembered: ReportingContext = { year: 2030, subsidiaryId: SUB, scope: 1, category: 'Fuel' };
    for (const context of contexts) {
      const canonical = reportingContextQuery(context);
      expect(resolve(canonical, remembered)).toEqual(context);
      expect(queryString(q(canonical))).toBe(canonical);
    }
  });

  it('keys equal contexts equally and different ones differently', () => {
    expect(reportingContextKey({ year: 2026, scope: 1 })).toBe(reportingContextKey({ scope: 1, year: 2026 }));
    expect(reportingContextKey({ year: 2026 })).not.toBe(reportingContextKey({ year: 2027 }));
    expect(reportingContextKey({ year: 2026 })).not.toBe(reportingContextKey({ year: 2026, subsidiaryId: SUB }));
  });
});

describe('remembered reporting context', () => {
  it('belongs to one user and is cleared at sign-in', () => {
    const store = useReportingContextStore.getState();
    store.remember('user-a', { year: 2027, subsidiaryId: SUB });
    const { remembered } = useReportingContextStore.getState();
    expect(rememberedContextFor(remembered, 'user-a')).toEqual({ year: 2027, subsidiaryId: SUB });
    // Another person in the same tab never inherits it, nor does an unknown one.
    expect(rememberedContextFor(remembered, 'user-b')).toBeNull();
    expect(rememberedContextFor(remembered, undefined)).toBeNull();
    useReportingContextStore.getState().clear();
    expect(useReportingContextStore.getState().remembered).toBeNull();
  });
});

describe('nextReportingContext (the selection bar)', () => {
  const base: ReportingContext = { year: 2026, subsidiaryId: SUB, scope: 1, category: 'Fuel' };

  it('changes one field and keeps the rest', () => {
    expect(nextReportingContext(base, { year: 2027 })).toEqual({ ...base, year: 2027 });
    expect(nextReportingContext(base, { subsidiaryId: OTHER })).toEqual({ ...base, subsidiaryId: OTHER });
  });

  it('clears an optional field with undefined — never to a blank', () => {
    expect(nextReportingContext(base, { subsidiaryId: undefined })).toEqual({ year: 2026, scope: 1, category: 'Fuel' });
    expect(nextReportingContext(base, { category: undefined })).toEqual({ year: 2026, subsidiaryId: SUB, scope: 1 });
  });

  it('drops a category the new scope excludes, so the bar never writes a refused link', () => {
    const next = nextReportingContext(base, { scope: 2 });
    expect(next).toEqual({ year: 2026, subsidiaryId: SUB, scope: 2 });
    expect(parse(reportingContextQuery(next))).toMatchObject({ ok: true });
    // A category of the selected scope stays.
    expect(nextReportingContext({ year: 2026, category: 'Electricity' }, { scope: 2 })).toEqual({ year: 2026, scope: 2, category: 'Electricity' });
  });

  it('keeps only values the contract knows', () => {
    expect(nextReportingContext({ year: 2026 }, { scope: 4, category: 'Nonsense' })).toEqual({ year: 2026 });
  });
});

describe('the remembered selection and the session', () => {
  afterEach(() => useReportingContextStore.getState().clear());

  it('survives its own user\'s session events', () => {
    useReportingContextStore.getState().remember('user-a', { year: 2027 });
    for (const event of ['INITIAL_SESSION', 'TOKEN_REFRESHED', 'SIGNED_IN', 'USER_UPDATED']) {
      forgetOnSessionChange(event, 'user-a');
      expect(useReportingContextStore.getState().remembered, event).not.toBeNull();
    }
  });

  it('is dropped when another user signs in — here or in another tab — or anyone signs out', () => {
    for (const [event, user] of [['SIGNED_IN', 'user-b'], ['INITIAL_SESSION', undefined], ['SIGNED_OUT', 'user-a']] as const) {
      useReportingContextStore.getState().remember('user-a', { year: 2027, subsidiaryId: SUB });
      forgetOnSessionChange(event, user);
      expect(useReportingContextStore.getState().remembered, `${event} ${user}`).toBeNull();
    }
  });
});
