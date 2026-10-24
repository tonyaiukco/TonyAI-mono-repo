import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES } from '@/lib/types';
import { MESSAGES } from '@/messages';
import { withdrawalNotice } from './report-view';

/**
 * The Reports screen's restatement notice. It exists so a user knows what the
 * artifact will say BEFORE they generate it — the same disclosure the PDF,
 * Excel and CSV carry, in the place the decision to send the file is made.
 */
describe('withdrawalNotice', () => {
  it('says nothing when nothing was withdrawn', () => {
    // An empty restatement notice is a claim of its own; a clean year has to
    // read as a clean year rather than as a report with an empty disclosure.
    expect(withdrawalNotice({ voidedCount: 0 })).toBeNull();
    expect(withdrawalNotice(null)).toBeNull();
  });

  it('reports the real number', () => {
    // Pinned on a count that is neither 0 nor 1: a fixture of 1 lets a notice
    // built from the wrong field — the committed count, say — read correctly.
    expect(withdrawalNotice({ voidedCount: 6 })).toEqual({ count: 6 });
    expect(withdrawalNotice({ voidedCount: 1 })).toEqual({ count: 1 });
  });

  it('words the singular and the plural, in English exactly as before (e2e pins it)', () => {
    const en = MESSAGES.en.reports;
    expect(en.withdrawnOne).toBe(
      '1 record was withdrawn from this reporting year. It counts towards no figure above, and every export lists it with the reason recorded at the time.',
    );
    expect(en.withdrawnMany.replace('{count}', '6')).toBe(
      '6 records were withdrawn from this reporting year. They count towards no figure above, and every export lists them with the reason recorded at the time.',
    );
  });

  it.each(SUPPORTED_LOCALES)('%s states BOTH halves: excluded from the totals, and disclosed in the file', (locale) => {
    // Either half alone is misleading. "Excluded" without "disclosed" reads as
    // data quietly dropped; "disclosed" without "excluded" leaves the reader
    // unsure whether the tonnage is still inside the figures on screen.
    const { withdrawnOne, withdrawnMany } = MESSAGES[locale].reports;
    for (const notice of [withdrawnOne, withdrawnMany]) {
      expect(notice).toMatch(locale === 'en' ? /no figure above/ : /hiçbir rakama dahil değil/);
      expect(notice).toMatch(locale === 'en' ? /every export lists/ : /her dışa aktarım/);
    }
  });
});
