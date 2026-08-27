import { describe, expect, it } from 'vitest';
import { ANOMALY_BASELINE_PERIODS } from '@/lib/types';
import { anomalyStatement, notEvaluatedNote } from './anomaly-view';

const record = (over: Partial<Parameters<typeof anomalyStatement>[0]> = {}) => ({
  anomalyFlag: false,
  anomalyBaselinePriorCount: ANOMALY_BASELINE_PERIODS,
  anomalyBaselineTCo2e: 41.2,
  ...over,
});

describe('anomalyStatement', () => {
  it('names the average a flagged value deviates from', () => {
    const s = anomalyStatement(record({ anomalyFlag: true }));
    expect(s.tone).toBe('flagged');
    // The number is the point. The banner asserted a deviation from "the
    // historical average" for a year without ever printing it, so the one
    // figure that lets an author judge the warning was the one missing.
    // VAR §4.3 prescribes the sentence; WP21 only appends the number it never
    // named. Both halves are asserted so neither can be lost to a reword.
    expect(s.detail).toMatch(/deviates significantly from the historical average/i);
    expect(s.detail).toContain('41.2 tCO₂e');
    expect(s.detail).toContain('50%');
  });

  it('still states the rule when a flag somehow arrives without its baseline', () => {
    const s = anomalyStatement(record({ anomalyFlag: true, anomalyBaselineTCo2e: null }));
    expect(s.tone).toBe('flagged');
    expect(s.detail).toMatch(/deviates significantly from the historical average/i);
    expect(s.detail).not.toContain('null');
    expect(s.detail).not.toContain('undefined');
  });

  it('says what a clean record was actually compared against', () => {
    const s = anomalyStatement(record());
    expect(s.tone).toBe('clean');
    expect(s.detail).toContain('41.2 tCO₂e');
  });

  it.each([0, 1, 2])('reports a short window of %i priors as NOT evaluated', (priors) => {
    const s = anomalyStatement(
      record({ anomalyBaselinePriorCount: priors, anomalyBaselineTCo2e: null }),
    );
    // The whole package exists for this line: without it a short window renders
    // exactly like a record that was checked and found clean.
    expect(s.tone).toBe('not_evaluated');
    expect(s.headline).toBe('Not checked for anomalies');
    expect(s.detail).toContain(String(ANOMALY_BASELINE_PERIODS));
  });

  it('distinguishes a record with no figure from one with no history', () => {
    const noFigure = anomalyStatement(
      record({ anomalyBaselinePriorCount: null, anomalyBaselineTCo2e: null }),
    );
    const noHistory = anomalyStatement(
      record({ anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null }),
    );
    expect(noFigure.tone).toBe('not_evaluated');
    expect(noHistory.tone).toBe('not_evaluated');
    // Same tone, different remedy: one needs a factor, the other needs time.
    expect(noFigure.detail).not.toBe(noHistory.detail);
    expect(noFigure.detail).toMatch(/no calculated figure/i);
    expect(noHistory.detail).toMatch(/no earlier committed period/i);
  });

  it('treats a full window that averages zero as not evaluated, not as clean', () => {
    const s = anomalyStatement(
      record({ anomalyBaselinePriorCount: ANOMALY_BASELINE_PERIODS, anomalyBaselineTCo2e: 0 }),
    );
    // The subtlest of the four absences: three priors, an average, and still no
    // ratio — 500 tCO₂e against three zero priors would otherwise read exactly
    // like a value in line with its history.
    expect(s.tone).toBe('not_evaluated');
    expect(s.detail).toMatch(/average zero/i);
  });

  it('never renders a flagged record as clean, whatever the window says', () => {
    for (const priors of [null, 0, 1, 2, ANOMALY_BASELINE_PERIODS]) {
      const s = anomalyStatement(
        record({ anomalyFlag: true, anomalyBaselinePriorCount: priors }),
      );
      expect(s.tone).toBe('flagged');
    }
  });
});

describe('notEvaluatedNote', () => {
  it('says nothing when every record in the cell was checked', () => {
    expect(notEvaluatedNote(0)).toBeNull();
    expect(notEvaluatedNote(-1)).toBeNull();
  });

  it('is singular for one and plural beyond it', () => {
    expect(notEvaluatedNote(1)).toMatch(/^1 entry was/);
    expect(notEvaluatedNote(4)).toMatch(/^4 entries were/);
  });
});
