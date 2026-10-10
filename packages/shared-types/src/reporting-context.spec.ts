import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORTING_YEAR, GROUP_INTENSITY_METRICS, REPORTING_CONTEXT_API_PATHS,
  REPORTING_YEARS, REPORTING_YEAR_MIN, REPORTING_YEAR_MAX,
  isReportingContext, isReportingYear, matchesReportingContext,
  type EmissionsSummaryParams, type ReportingContext, type ReportingExportParams,
  type ReportingIntensityResponse,
} from './index';

describe('LP3-02 supported reporting years', () => {
  it('keeps the existing inclusive API range, including backfill and 2027', () => {
    expect([REPORTING_YEAR_MIN, REPORTING_YEAR_MAX]).toEqual([2000, 2100]);
    expect(REPORTING_YEARS).toHaveLength(101);
    expect(new Set(REPORTING_YEARS).size).toBe(101);
    for (let year = 2000; year <= 2100; year++) {
      expect(REPORTING_YEARS).toContain(year);
      expect(isReportingYear(year)).toBe(true);
    }
    expect(REPORTING_YEARS[0]).toBe(2100);
    expect(REPORTING_YEARS[100]).toBe(2000);
    expect(Object.isFrozen(REPORTING_YEARS)).toBe(true);
  });

  it('keeps D06 first close independent of selectable future years', () => {
    expect(DEFAULT_REPORTING_YEAR).toBe(2026);
    expect(DEFAULT_REPORTING_YEAR).not.toBe(REPORTING_YEARS[0]);
    // Acceptance says nothing about a factor release or its coverage.
    expect(isReportingContext({ year: 2027 })).toBe(true);
    expect(isReportingContext({ year: 2025 })).toBe(true);
  });

  it.each([1999, 2101, 2026.5, NaN, Infinity, -Infinity, '2027', '', null, undefined, true])(
    'refuses an invalid wire year: %s', (year) => expect(isReportingYear(year)).toBe(false),
  );
});

describe('one explicit annual context', () => {
  it.each([
    { year: 2027 },
    { year: 2025, subsidiaryId: 'seed-compatible-id' },
    { year: 2026, scope: 1, category: 'Fuel' },
    { year: 2026, scope: 2, category: 'Electricity' },
    { year: 2026, scope: 3, category: 'Water' },
    { year: 2026, subsidiaryId: undefined, scope: undefined, category: undefined },
  ])('accepts a complete selection without inferring factor availability: %j', (context) => {
    expect(isReportingContext(context)).toBe(true);
  });

  it.each([
    null, [], '2027', {}, { year: undefined }, { year: '2027' },
    { year: 2026, subsidiaryId: '' }, { year: 2026, subsidiaryId: '  ' },
    { year: 2026, subsidiaryId: null }, { year: 2026, subsidiaryId: 123 },
    { year: 2026, scope: 0 }, { year: 2026, scope: 4 }, { year: 2026, scope: '2' },
    { year: 2026, scope: null }, { year: 2026, category: null },
    { year: 2026, category: '' }, { year: 2026, category: 'not-a-category' },
    { year: 2026, scope: 1, category: 'Electricity' },
    { year: 2026, locationId: 'site' }, { year: 2026, status: 'draft' },
    { year: 2026, factorYear: 2025 },
  ])('refuses malformed or unsupported context instead of widening it: %j', (context) => {
    expect(isReportingContext(context)).toBe(false);
  });

  const selected: ReportingContext = { year: 2027, subsidiaryId: 'sub-a', scope: 2, category: 'Electricity' };
  it('acknowledges every requested field, independent of object key order', () => {
    expect(matchesReportingContext({ category: 'Electricity', scope: 2, subsidiaryId: 'sub-a', year: 2027 }, selected)).toBe(true);
    expect(matchesReportingContext({ year: 2027, scope: undefined }, { year: 2027 })).toBe(true);
  });
  it.each([
    undefined, {}, { ...selected, year: 2026 }, { ...selected, subsidiaryId: 'sub-b' },
    { ...selected, subsidiaryId: undefined }, { ...selected, scope: undefined },
    { ...selected, category: undefined }, { ...selected, scope: 1 },
  ])('rejects absent or mismatched context: %j', (returned) => {
    expect(matchesReportingContext(returned, selected)).toBe(false);
  });
  it('also refuses a narrower response for an all-accessible request', () => {
    expect(matchesReportingContext({ year: 2027, subsidiaryId: 'sub-a' }, { year: 2027 })).toBe(false);
  });
});

describe('additive reporting contracts', () => {
  it('uses distinct paths so old APIs cannot silently ignore the new filters', () => {
    expect(REPORTING_CONTEXT_API_PATHS).toEqual({
      summary: '/emissions/context/summary', matrix: '/emissions/context/tracking-matrix',
      intensity: '/intensity/context', meta: '/reports/context/meta',
      pdf: '/reports/context/pdf', excel: '/reports/context/excel', csv: '/reports/context/csv',
    });
    expect(GROUP_INTENSITY_METRICS).toEqual(['revenue']);
  });

  it('requires annual context and metric coverage while preserving explicit history queries', () => {
    const history: EmissionsSummaryParams = { subsidiaryId: 'sub-a' };
    const report: ReportingExportParams = {
      year: 2027, subsidiaryId: 'sub-a', scope: 2, category: 'Electricity', template: 'executive_summary',
    };
    // These are compile-time regressions; tsc must reject them.
    // @ts-expect-error Annual context must not become an all-year request.
    const missingYear: ReportingContext = { subsidiaryId: 'sub-a' };
    // @ts-expect-error No site/company-only selector is part of LP3-02.
    const site: ReportingContext = { year: 2027, locationId: 'site' };
    // @ts-expect-error Exports require a year too.
    const allYears: ReportingExportParams = { template: 'executive_summary' };
    // @ts-expect-error The new intensity response must acknowledge the context.
    const legacyIntensity: ReportingIntensityResponse = { year: 2027, metrics: [] };
    expect(history.year).toBeUndefined();
    expect(report.year).toBe(2027);
    void [missingYear, site, allYears, legacyIntensity];
  });
});
