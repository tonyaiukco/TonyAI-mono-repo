import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { emissionsError, liveReportNonAuthoritative, nonAuthoritativeFigures, trendLabel } from './emissions-view';
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

describe('nonAuthoritativeFigures (QA L10)', () => {
  it('labels the figures that do not rest on authoritative releases, out of the calculated ones', () => {
    expect(nonAuthoritativeFigures({ calculatedRecordCount: 7, nonAuthoritativeRecordCount: 3 })).toEqual({ count: 3, of: 7 });
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
