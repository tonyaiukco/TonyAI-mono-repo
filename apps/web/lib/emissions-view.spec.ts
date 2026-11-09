import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { emissionsError, intensityFigureGap, liveReportNonAuthoritative, nonAuthoritativeFigures, trendChangePercent, trendLabel } from './emissions-view';
import { copyFor, describeFor, recordWordsFor } from '@/lib/i18n/testing';
import type { Locale } from '@/lib/types';

const copy = (locale: Locale = 'en') => copyFor('emissions', locale);
const errorFor = (error: unknown, locale: Locale = 'en') => emissionsError(error, copy(locale), describeFor(locale));
const label = (period: string, locale: Locale = 'en') => trendLabel(period, copy(locale), recordWordsFor(locale));

describe('emissionsError', () => {
  it('explains the three statuses the screen always has, in English as before', () => {
    expect(errorFor(new ApiError('x', 401)).title).toBe('Your session has expired — please sign in again.');
    expect(errorFor(new ApiError('x', 403)).title).toBe('You do not have access to this data.');
    expect(errorFor(new ApiError('x', 503)).title).toBe('The analytics service is unavailable right now.');
    expect(errorFor(new ApiError('x', 500)).title).toBe('The analytics service is unavailable right now.');
  });

  it('words them in Turkish for a Turkish user', () => {
    expect(errorFor(new ApiError('x', 403), 'tr').title).toBe('Bu verilere erişiminiz yok.');
  });

  it("never shows the server's sentence for a code the catalogue knows", () => {
    const refused = new ApiError('Subsidiary not found', 404, 'subsidiary_not_found');
    expect(errorFor(refused, 'tr').title).toBe(describeFor('tr')(refused).title);
    expect(errorFor(refused, 'tr').title).not.toBe('Subsidiary not found');
  });
});

describe('trendLabel', () => {
  it('reads as the API wrote it in English', () => {
    expect(label('2024')).toBe('2024');
    expect(label('2024-Q1')).toBe('2024-Q1');
    expect(label('January 2024')).toBe('January 2024');
  });

  it('re-words the parts in Turkish', () => {
    expect(label('2024-Q3', 'tr')).toBe('2024 3. çeyrek');
    expect(label('February 2024', 'tr')).toBe('Şubat 2024');
    expect(label('2024', 'tr')).toBe('2024');
  });

  it('shows anything it does not recognise as sent', () => {
    expect(label('Smarch 2024', 'tr')).toBe('Smarch 2024');
    expect(label('2024-Q5', 'tr')).toBe('2024-Q5');
    expect(label('constructor 2024', 'tr')).toBe('constructor 2024');
  });
});

describe('intensityFigureGap (D14)', () => {
  const ids = ['a', 'b'];
  it('states how many contributors have a figure when some do not', () => {
    expect(intensityFigureGap({ contributingSubsidiaryIds: ids, contributingWithFigureCount: 1 })).toEqual({ withFigure: 1, contributing: 2 });
    expect(intensityFigureGap({ contributingSubsidiaryIds: ids, contributingWithFigureCount: 0 })).toEqual({ withFigure: 0, contributing: 2 });
  });
  it('says nothing when all have one, or when an older server does not say', () => {
    expect(intensityFigureGap({ contributingSubsidiaryIds: ids, contributingWithFigureCount: 2 })).toBeNull();
    expect(intensityFigureGap({ contributingSubsidiaryIds: ids } as never)).toBeNull();
  });
});

describe('trendChangePercent', () => {
  // [Scope 1 + 2 tonnes, its records, Scope 3 tonnes, its records]
  const at = (...points: [number, number, number, number][]) =>
    points.map(([total, scope12RecordCount, scope3, scope3RecordCount]) => ({ total, scope12RecordCount, scope3, scope3RecordCount }));

  it('reads the main total first to last', () => {
    expect(trendChangePercent(at([100, 2, 0, 0], [80, 2, 0, 0]), false)).toBe(-20);
    expect(trendChangePercent(at([100, 1, 9, 1], [50, 1, 0, 0], [150, 1, 9, 1]), false)).toBe(50);
  });
  it('invents no reduction or stillness from a bucket of Scope 3 alone', () => {
    expect(trendChangePercent(at([30, 1, 0, 0], [0, 0, 5, 1]), false)).toBe(0);
    expect(trendChangePercent(at([0, 0, 5, 1], [30, 1, 0, 0]), false)).toBe(0);
    expect(trendChangePercent(at([20, 1, 0, 0], [0, 0, 5, 1], [30, 1, 0, 0]), false)).toBe(50);
  });
  it('keeps a measured zero, with Scope 3 beside it or not (Codex review of #292)', () => {
    expect(trendChangePercent(at([100, 1, 0, 0], [0, 1, 5, 1]), false)).toBe(-100);
    expect(trendChangePercent(at([100, 1, 0, 0], [0, 1, 0, 0]), false)).toBe(-100);
    expect(trendChangePercent(at([100, 1, 0, 0], [50, 1, 0, 0], [0, 1, 0, 0]), false)).toBe(-100);
  });
  it('reads Scope 3 for a Scope 3 selection, by its own records', () => {
    expect(trendChangePercent(at([0, 0, 10, 1], [0, 0, 15, 1]), true)).toBe(50);
    expect(trendChangePercent(at([0, 0, 10, 1], [7, 1, 0, 0], [0, 0, 5, 1]), true)).toBe(-50);
    expect(trendChangePercent(at([0, 0, 10, 1], [7, 1, 0, 1]), true)).toBe(-100);
  });
  it('says nothing with fewer than two figures, or from a zero start', () => {
    expect(trendChangePercent([], false)).toBe(0);
    expect(trendChangePercent(at([5, 1, 0, 0]), false)).toBe(0);
    expect(trendChangePercent(at([0, 1, 0, 0], [5, 1, 0, 0]), false)).toBe(0);
  });
});

describe('nonAuthoritativeFigures (QA L10)', () => {
  it('labels the figures that do not rest on authoritative releases, out of the calculated ones', () => {
    expect(nonAuthoritativeFigures({ calculatedRecordCount: 7, nonAuthoritativeRecordCount: 3 })).toEqual({ count: 3, of: 7 });
  });
  it('reads a target row or an intensity card by its own numerator, so another year or Scope 3 cannot trip it', () => {
    expect(nonAuthoritativeFigures({ calculatedRecordCount: 3, nonAuthoritativeRecordCount: 1 })).toEqual({ count: 1, of: 3 });
    expect(nonAuthoritativeFigures({ calculatedRecordCount: 0, nonAuthoritativeRecordCount: 0 })).toBeNull();
  });
  it('says nothing when every figure is authoritative, when there is no summary, or when an older server omits the count', () => {
    expect(nonAuthoritativeFigures({ calculatedRecordCount: 7, nonAuthoritativeRecordCount: 0 })).toBeNull();
    expect(nonAuthoritativeFigures(null)).toBeNull();
    expect(nonAuthoritativeFigures({ calculatedRecordCount: 7 } as never)).toBeNull();
  });
  it.each(['en', 'tr'] as const)('%s: the warning renders its count and total, formatted by the screen', (locale) => {
    const { t } = copyFor('emissions', locale);
    const markup = (t as unknown as { markup: (k: string, v: Record<string, unknown>) => string }).markup;
    const text = markup('nonAuthoritative', { count: '3', of: locale === 'en' ? '1,200' : '1.200', strong: (c: string) => c });
    expect(text).toContain(locale === 'en' ? '3 of 1,200' : '3 / 1.200');
  });
});

describe('liveReportNonAuthoritative (QA L10)', () => {
  it('adds the Scope 3 tonnes the preview discloses to its Scope 1/2 figures', () => {
    const summary = { calculatedRecordCount: 10, nonAuthoritativeRecordCount: 0 };
    // 4 Scope 3 records, 1 with no figure: 3 calculated, 2 of them not authoritative.
    expect(liveReportNonAuthoritative(summary, { recordCount: 4, uncalculatedRecordCount: 1, nonAuthoritativeRecordCount: 2 })).toEqual({ count: 2, of: 13 });
    expect(liveReportNonAuthoritative({ calculatedRecordCount: 10, nonAuthoritativeRecordCount: 1 }, null)).toEqual({ count: 1, of: 10 });
  });
  it('says nothing when every figure is authoritative, or before the preview has loaded', () => {
    expect(liveReportNonAuthoritative({ calculatedRecordCount: 10, nonAuthoritativeRecordCount: 0 }, { recordCount: 2, uncalculatedRecordCount: 0, nonAuthoritativeRecordCount: 0 })).toBeNull();
    expect(liveReportNonAuthoritative(null, { recordCount: 2, uncalculatedRecordCount: 0, nonAuthoritativeRecordCount: 2 })).toBeNull();
  });
});
