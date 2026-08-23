import { describe, it, expect } from 'vitest';
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

  it('reports the real number, in the singular', () => {
    const notice = withdrawalNotice({ voidedCount: 1 })!;
    expect(notice).toContain('1 record was withdrawn');
    expect(notice).toContain('It counts towards no figure above');
    expect(notice).toContain('lists it with the reason recorded at the time');
  });

  it('reports the real number, in the plural', () => {
    // Pinned on a count that is neither 0 nor 1: a fixture of 1 lets a notice
    // built from the wrong field — the committed count, say — read correctly.
    const notice = withdrawalNotice({ voidedCount: 6 })!;
    expect(notice).toContain('6 records were withdrawn');
    expect(notice).toContain('They count towards no figure above');
    expect(notice).toContain('lists them with the reason recorded at the time');
  });

  it('states BOTH halves: excluded from the totals, and disclosed in the file', () => {
    // Either half alone is misleading. "Excluded" without "disclosed" reads as
    // data quietly dropped; "disclosed" without "excluded" leaves the reader
    // unsure whether the tonnage is still inside the figures on screen.
    const notice = withdrawalNotice({ voidedCount: 3 })!;
    expect(notice).toMatch(/no figure above/);
    expect(notice).toMatch(/every export lists/);
  });
});
