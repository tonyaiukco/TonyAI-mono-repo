import { describe, it, expect } from 'vitest';
import { daysSince, ageLabel } from './review-view';

/**
 * The review queue's age column. It is the only number on that screen a
 * reviewer uses to decide what to pick up next, and until this spec existed it
 * had no coverage at all — it lived inside `app/review/page.tsx`, which the
 * web vitest config does not collect.
 */
describe('daysSince', () => {
  // A fixed instant, so the arithmetic is pinned rather than racing the clock.
  const NOW = Date.parse('2026-08-28T12:00:00.000Z');

  it('counts whole days, floored', () => {
    // 47 hours is one whole day of waiting, not two. Rounding here would age
    // every record by up to half a day and make a same-afternoon submission
    // read as a day old.
    expect(daysSince('2026-08-26T13:00:00.000Z', NOW)).toBe(1);
    expect(daysSince('2026-08-27T12:00:00.000Z', NOW)).toBe(1);
    expect(daysSince('2026-08-28T00:00:00.000Z', NOW)).toBe(0);
  });

  it('reads a long-stale record as its real age', () => {
    // The case the column exists for: something nobody has picked up.
    expect(daysSince('2026-06-28T12:00:00.000Z', NOW)).toBe(61);
  });

  it('clamps a future instant to 0 rather than reporting negative days', () => {
    // A client clock running behind the server makes a just-created record
    // arrive with a timestamp in the browser's future. "-1d" in the queue
    // would look like a bug in the record, not in the clock.
    expect(daysSince('2026-08-29T12:00:00.000Z', NOW)).toBe(0);
  });

  it('returns null for an instant it cannot parse', () => {
    // `Math.max(0, NaN)` is `NaN`, so this used to render as "NaNd". The API
    // contract makes it unreachable; the guard is here so it stays that way if
    // the contract ever loosens.
    expect(daysSince('not a date', NOW)).toBeNull();
    expect(daysSince('', NOW)).toBeNull();
  });

  it('defaults to the current instant when none is given', () => {
    // The call site passes no `now`; that default has to work.
    const iso = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(daysSince(iso)).toBe(3);
  });
});

/**
 * What the cell actually reads. Covered separately from the arithmetic because
 * the unknown-age case is a rendering decision, not a calculation.
 */
describe('ageLabel', () => {
  const NOW = Date.parse('2026-08-28T12:00:00.000Z');

  it('renders whole days with the unit', () => {
    expect(ageLabel('2026-08-26T13:00:00.000Z', NOW)).toBe('1d');
    expect(ageLabel('2026-08-28T00:00:00.000Z', NOW)).toBe('0d');
  });

  it('renders an unknown age as an em dash, never as 0d', () => {
    // "0d" would tell a reviewer the record arrived today. An unknown age has
    // to look unknown — it is the only wrong answer here anyone would act on.
    expect(ageLabel('not a date', NOW)).toBe('—');
  });
});
