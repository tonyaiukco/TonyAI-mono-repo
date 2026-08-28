import { describe, it, expect } from 'vitest';
import { byLongestWait, daysSince, waitingLabel } from './review-view';

/**
 * The review queue's waiting column. It is the only number on that screen a
 * reviewer uses to decide what to pick up next, and until this spec existed it
 * had no coverage at all — it lived inside `app/review/page.tsx`, which the
 * web vitest config does not collect.
 */
describe('daysSince', () => {
  // A fixed instant, so the arithmetic is pinned rather than racing the clock.
  const NOW = Date.parse('2026-08-28T12:00:00.000Z');

  it('reads null for a record that was never submitted', () => {
    // Not 0, and never a silent fallback to `createdAt`: an absent submission
    // time is the honest answer for every record the backfill could not reach.
    expect(daysSince(null, NOW)).toBeNull();
  });

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
 * the unknown-wait case is a rendering decision, not a calculation.
 */
describe('waitingLabel', () => {
  const NOW = Date.parse('2026-08-28T12:00:00.000Z');

  it('renders whole days with the unit', () => {
    expect(waitingLabel('2026-08-26T13:00:00.000Z', NOW)).toBe('1d');
    expect(waitingLabel('2026-08-28T00:00:00.000Z', NOW)).toBe('0d');
  });

  it('renders an unknown wait as an em dash, never as 0d', () => {
    // "0d" would tell a reviewer the record arrived today. An unknown wait has
    // to look unknown — it is the only wrong answer here anyone would act on,
    // and on a freshly seeded database EVERY record is in this state, because
    // the seed writes records straight to `approved` without submitting them.
    expect(waitingLabel(null, NOW)).toBe('—');
    expect(waitingLabel('not a date', NOW)).toBe('—');
  });
});

/**
 * Queue order. The column and the sort have to measure the same thing: the
 * number was right and the list order argued with it, which is worse than both
 * being consistently less useful — a reviewer acts on the order.
 */
describe('byLongestWait', () => {
  const rec = (id: string, submittedAt: string | null) => ({ id, submittedAt });

  it('puts the longest wait first', () => {
    const rows = [
      rec('recent', '2026-08-27T10:00:00.000Z'),
      rec('oldest', '2026-07-01T10:00:00.000Z'),
      rec('middle', '2026-08-01T10:00:00.000Z'),
    ].sort(byLongestWait);
    expect(rows.map((r) => r.id)).toEqual(['oldest', 'middle', 'recent']);
  });

  it('orders by SUBMISSION, not by when the draft was started', () => {
    // The case the whole column exists for: a record drafted in January and
    // submitted this morning has waited hours, not eight months, and must not
    // sit at the top of a queue that means "deal with the oldest first".
    const rows = [
      { id: 'old-draft', createdAt: '2026-01-05T09:00:00.000Z', submittedAt: '2026-08-28T09:00:00.000Z' },
      { id: 'waited', createdAt: '2026-08-01T09:00:00.000Z', submittedAt: '2026-08-05T09:00:00.000Z' },
    ].sort(byLongestWait);
    expect(rows.map((r) => r.id)).toEqual(['waited', 'old-draft']);
  });

  it('sorts an unknown wait LAST, never by falling back to createdAt', () => {
    // Falling back for the sort key would smuggle the discarded field back in
    // through the ordering after taking it out of the number. An unknown wait
    // has no claim on the top of the queue.
    const rows = [
      rec('unknown', null),
      rec('waited', '2026-07-01T10:00:00.000Z'),
      rec('also-unknown', null),
    ].sort(byLongestWait);
    expect(rows[0].id).toBe('waited');
    expect(rows.slice(1).map((r) => r.id).sort()).toEqual(['also-unknown', 'unknown']);
  });
});
