import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { emissionsError, trendLabel } from './emissions-view';
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
