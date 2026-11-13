import { describe, expect, it } from 'vitest';
import { ANOMALY_BASELINE_PERIODS } from '@/lib/types';
import { createTranslator } from 'use-intl/core';
import { MESSAGES } from '@/messages';
import type { Locale } from '@/lib/types';
import { anomalyStatement as statementIn, isFirstPeriodRecord, notEvaluatedNote as noteIn } from './anomaly-view';

const tFor = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'anomaly' });
const anomalyStatement = (record: Parameters<typeof statementIn>[0], locale: Locale = 'en') =>
  statementIn(record, tFor(locale), locale);
const notEvaluatedNote = (count: number, locale: Locale = 'en') => noteIn(count, tFor(locale));

const record = (over: Partial<Parameters<typeof statementIn>[0]> = {}) => ({
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

  // BUG-R2-07 (2026-11-11): one or two earlier periods are a verdict, on
  // limited history, and both outcomes say so.
  it('says a flag on ONE period rests on limited history, and names that period', () => {
    const s = anomalyStatement(
      record({ anomalyFlag: true, anomalyBaselinePriorCount: 1, anomalyBaselineTCo2e: 10 }),
    );
    expect(s.tone).toBe('flagged');
    expect(s.headline).toBe('Flagged as anomalous');
    expect(s.detail).toContain('10 tCO₂e');
    expect(s.detail).toContain('the only earlier period');
    expect(s.detail).toContain('more than 50%');
    expect(s.detail).toContain('limited history (1 period)');
    // Not the full-history sentence: there is no "previous 3 periods" here.
    expect(s.detail).not.toContain(`previous ${ANOMALY_BASELINE_PERIODS}`);
  });

  it('says a flag on TWO periods rests on their average and on limited history', () => {
    const s = anomalyStatement(
      record({ anomalyFlag: true, anomalyBaselinePriorCount: 2, anomalyBaselineTCo2e: 10 }),
    );
    expect(s.tone).toBe('flagged');
    expect(s.detail).toContain('the average of the 2 earlier periods');
    expect(s.detail).toContain('limited history (2 periods)');
    expect(s.detail).not.toContain(`previous ${ANOMALY_BASELINE_PERIODS}`);
  });

  it.each([
    [1, 'the only earlier period', 'limited history (1 period)'],
    [2, 'the average of the 2 earlier periods', 'limited history (2 periods)'],
  ])('does not overstate a clean verdict on %i period(s)', (priors, against, basis) => {
    const s = anomalyStatement(record({ anomalyBaselinePriorCount: priors, anomalyBaselineTCo2e: 10 }));
    expect(s.tone).toBe('clean');
    // Its own headline: the full-history one would claim a three-period check.
    expect(s.headline).toBe('Within range on limited history');
    expect(s.headline).not.toBe(anomalyStatement(record()).headline);
    expect(s.detail).toContain('10 tCO₂e');
    expect(s.detail).toContain(against);
    expect(s.detail).toContain(basis);
  });

  it('keeps the full-history wording for three periods', () => {
    expect(anomalyStatement(record()).headline).toBe('Within the expected range');
    expect(anomalyStatement(record()).detail).toContain(`previous ${ANOMALY_BASELINE_PERIODS}`);
    expect(anomalyStatement(record({ anomalyFlag: true })).detail).not.toContain('limited history');
  });

  it('does not tell a record with no history that it needs three periods', () => {
    const s = anomalyStatement(record({ anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null }));
    // The whole package exists for this line: without it an unchecked record
    // renders exactly like one that was checked and found clean.
    expect(s.tone).toBe('not_evaluated');
    // UAT round 2, K4-3a option A: named a first-period record, and told what
    // can still be checked.
    expect(s.headline).toBe('First-period record');
    expect(s.detail).toMatch(/no earlier period to compare/i);
    expect(s.detail).toMatch(/evidence document and the unit/i);
    expect(s.qualified).toBe(true);
    // One earlier period is enough now, so a number here would be wrong.
    expect(s.detail).not.toMatch(/\d/);
  });

  it('names a first-period record in Turkish, with no count of periods', () => {
    const s = anomalyStatement(record({ anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null }), 'tr');
    expect(s.tone).toBe('not_evaluated');
    expect(s.headline).toBe('İlk dönem kaydı');
    expect(s.detail).toBe('Geçmiş karşılaştırma verisi yok — lütfen kanıt dokümanını ve birimi kontrol edin.');
    expect(s.detail).not.toMatch(/\d/);
  });

  it('marks only an unflagged record with a figure and no earlier period as first-period', () => {
    expect(isFirstPeriodRecord(record({ anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null }))).toBe(true);
    expect(isFirstPeriodRecord(record({ anomalyBaselinePriorCount: null, anomalyBaselineTCo2e: null }))).toBe(false);
    expect(isFirstPeriodRecord(record({ anomalyBaselinePriorCount: 1, anomalyBaselineTCo2e: 3 }))).toBe(false);
    expect(isFirstPeriodRecord(record())).toBe(false);
    expect(isFirstPeriodRecord(record({ anomalyFlag: true, anomalyBaselinePriorCount: 0 }))).toBe(false);
  });

  it.each([1, 2])(
    'says a verdict of %i priors without an average was scored before the short-history check',
    (priors) => {
      // The old rule's "not evaluated", kept on a committed record. It says
      // what happened then — not that three periods are needed, which is no
      // longer true.
      const s = anomalyStatement(
        record({ anomalyBaselinePriorCount: priors, anomalyBaselineTCo2e: null }),
      );
      expect(s.tone).toBe('not_evaluated');
      expect(s.headline).toBe('Not checked for anomalies');
      expect(s.detail).toMatch(/was scored when the check needed 3 earlier committed periods/);
      expect(s.detail).toContain(`(${priors})`);
    },
  );

  it.each([1, 2])('treats %i period(s) averaging zero as not evaluated, not as clean', (priors) => {
    const s = anomalyStatement(record({ anomalyBaselinePriorCount: priors, anomalyBaselineTCo2e: 0 }));
    expect(s.tone).toBe('not_evaluated');
    expect(s.detail).toMatch(/average zero/i);
    expect(s.detail).not.toMatch(/was scored when/);
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
    expect(noHistory.detail).toMatch(/no earlier period to compare/i);
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

describe('which unflagged records must still be given their statement', () => {
  // Data Entry and the review sheet render a verdict only when asked to. An
  // all-clear on a full history may go unsaid; nothing else may.
  it.each([
    ['clean on a full history', record(), false],
    ['clean on one period', record({ anomalyBaselinePriorCount: 1, anomalyBaselineTCo2e: 10 }), true],
    ['clean on two periods', record({ anomalyBaselinePriorCount: 2, anomalyBaselineTCo2e: 10 }), true],
    ['no earlier period', record({ anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null }), true],
    ['no figure of its own', record({ anomalyBaselinePriorCount: null, anomalyBaselineTCo2e: null }), true],
    ['scored before the short-history check', record({ anomalyBaselinePriorCount: 2, anomalyBaselineTCo2e: null }), true],
    ['a zero average', record({ anomalyBaselineTCo2e: 0 }), true],
  ])('%s', (_name, r, qualified) => {
    expect(anomalyStatement(r).qualified).toBe(qualified);
  });

  it('never qualifies a flag — the amber banner already carries its statement', () => {
    for (const priors of [1, 2, ANOMALY_BASELINE_PERIODS]) {
      expect(
        anomalyStatement(record({ anomalyFlag: true, anomalyBaselinePriorCount: priors })).qualified,
      ).toBe(false);
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

describe('in Turkish (LP4-04)', () => {
  it('writes the baseline with the Turkish decimal mark and the same number', () => {
    const en = anomalyStatement(record({ anomalyFlag: true, anomalyBaselineTCo2e: 1234.5 }));
    const tr = anomalyStatement(record({ anomalyFlag: true, anomalyBaselineTCo2e: 1234.5 }), 'tr');
    // English as before LP4-04: no grouping, dot decimal.
    expect(en.detail).toContain('1234.5 tCO₂e');
    expect(tr.detail).toContain('1234,5 tCO₂e');
    expect(tr.headline).toBe('Anormal olarak işaretlendi');
    expect(tr.detail).toContain('%50');
  });

  it('keeps every absence distinct in Turkish too', () => {
    const details = [
      ...[null, 0, 1, 2].map((priors) => record({ anomalyBaselinePriorCount: priors, anomalyBaselineTCo2e: null })),
      record({ anomalyBaselinePriorCount: 1, anomalyBaselineTCo2e: 0 }),
      record({ anomalyBaselineTCo2e: 0 }),
    ].map((r) => anomalyStatement(r, 'tr').detail);
    expect(new Set(details).size).toBe(details.length);
    expect(notEvaluatedNote(4, 'tr')).toMatch(/^4 kayıt/);
  });

  it('states limited history in Turkish, for a flag and for a clean verdict', () => {
    const flagged = anomalyStatement(
      record({ anomalyFlag: true, anomalyBaselinePriorCount: 1, anomalyBaselineTCo2e: 12.5 }),
      'tr',
    );
    expect(flagged.headline).toBe('Anormal olarak işaretlendi');
    expect(flagged.detail).toContain('12,5 tCO₂e');
    expect(flagged.detail).toContain('önceki tek dönemin');
    expect(flagged.detail).toContain('kısıtlı geçmişe dayanıyor (1 dönem)');

    const clean = anomalyStatement(record({ anomalyBaselinePriorCount: 2, anomalyBaselineTCo2e: 12.5 }), 'tr');
    expect(clean.headline).toBe('Kısıtlı geçmişe göre beklenen aralıkta');
    expect(clean.detail).toContain('önceki 2 dönemin ortalaması');
    expect(clean.detail).toContain('kısıtlı geçmişe dayanıyor (2 dönem)');

    const before = anomalyStatement(record({ anomalyBaselinePriorCount: 2, anomalyBaselineTCo2e: null }), 'tr');
    expect(before.headline).toBe('Anormallik kontrolü yapılmadı');
    expect(before.detail).toContain('(2)');
  });
});

// BUG-R2-07 tier 3 (Decisions 2026-11-12): a first period above its typo ceiling.
describe('a first-period ceiling flag', () => {
  const ceilingFlag = (over: Partial<Parameters<typeof statementIn>[0]> = {}) =>
    record({
      anomalyFlag: true,
      anomalyBaselinePriorCount: 0,
      anomalyBaselineTCo2e: null,
      category: 'Electricity',
      activityType: null,
      activityValue: 1_500,
      activityUnit: 'MWh',
      ...over,
    });

  it('states the amount and the ceiling in the entered unit, never an average', () => {
    const s = anomalyStatement(ceilingFlag());
    expect(s.tone).toBe('flagged');
    expect(s.qualified).toBe(false);
    expect(s.headline).toBe('Above the first-period ceiling');
    expect(s.detail).toContain('1,500 MWh is above the plausibility ceiling of 1,000 MWh');
    expect(s.detail).toContain('no earlier period');
    expect(s.detail).toMatch(/evidence document and the unit/);
    expect(s.detail).not.toMatch(/historical average/);
  });

  it('names the largest equipment line for a refrigerant record', () => {
    const lines = (...c: number[]) => ({
      equipment: c.map((capacityKg) => ({ equipmentType: 'chiller', capacityKg, refillKg: 0, leakRateChoice: 'default' })),
    });
    const s = anomalyStatement(
      ceilingFlag({ category: 'Refrigerants', activityType: 'R-410A', activityValue: 770, activityUnit: 'kg', parameters: lines(120, 650) }),
    );
    expect(s.detail).toContain('An equipment line of 650 kg is above the plausibility ceiling of 500 kg');
  });

  describe('a refill above its limit', () => {
    const refill = (capacityKg: number, refillKg: number) =>
      ceilingFlag({
        category: 'Refrigerants',
        activityType: 'HFC-227ea',
        activityValue: capacityKg,
        activityUnit: 'kg',
        parameters: { equipment: [{ equipmentType: 'fire_suppression_system', capacityKg, refillKg, leakRateChoice: 'default' }] },
      });

    it('names 125% of the capacity, to the kilogram decimal', () => {
      const s = anomalyStatement(refill(10, 50_000));
      expect(s.headline).toBe('Above the first-period ceiling');
      expect(s.detail).toContain("An equipment line's refill of 50,000 kg is above its limit of 12.5 kg, 125% of the line's 10 kg capacity");
    });

    it('names the 500 kg cap for a line with no capacity', () => {
      expect(anomalyStatement(refill(0, 600)).detail).toContain("refill of 600 kg is above the 500 kg per-line limit");
    });

    it('names the 500 kg cap for a large line', () => {
      expect(anomalyStatement(refill(450, 501)).detail).toContain('above the 500 kg per-line limit');
    });

    it('is in Turkish with Turkish separators', () => {
      const s = anomalyStatement(refill(10, 50_000), 'tr');
      expect(s.detail).toContain('50.000 kg dolumu');
      expect(s.detail).toContain("10 kg kapasitesinin %125'i olan 12,5 kg");
    });
  });

  // K1 (owner, 2026-11-13): over a zero average, not a first period.
  it('says the earlier periods average zero, not that there are none', () => {
    const s = anomalyStatement(ceilingFlag({ anomalyBaselinePriorCount: 1, anomalyBaselineTCo2e: 0 }));
    expect(s.tone).toBe('flagged');
    expect(s.headline).toBe('Above the plausibility ceiling');
    expect(s.detail).toMatch(/^The earlier periods of this series average zero/);
    expect(s.detail).toContain('1,500 MWh is above the plausibility ceiling of 1,000 MWh');
    expect(s.detail).not.toMatch(/first period/);
    const tr = anomalyStatement(ceilingFlag({ anomalyBaselinePriorCount: 2, anomalyBaselineTCo2e: 0 }), 'tr');
    expect(tr.headline).toBe('Makul üst sınırın üstünde');
    expect(tr.detail).toMatch(/^Bu serinin önceki dönemlerinin ortalaması sıfır/);
  });

  // K2: metered m³ × the record's own factor, held to the Sm³ ceiling.
  it('states m³ × the volume correction factor against the Sm³ ceiling', () => {
    const s = anomalyStatement(
      ceilingFlag({ category: 'Natural Gas', activityValue: 240_000, activityUnit: 'cubic_metres', parameters: { volumeCorrectionFactor: 30 } }),
    );
    expect(s.detail).toContain('240,000 m³ × the volume correction factor 30 = 7,200,000 Sm³, above the plausibility ceiling of 250,000 Sm³');
    const tr = anomalyStatement(
      ceilingFlag({ category: 'Natural Gas', activityValue: 240_000, activityUnit: 'cubic_metres', parameters: { volumeCorrectionFactor: 30 } }),
      'tr',
    );
    expect(tr.detail).toContain('240.000 m³ × hacim düzeltme katsayısı 30 = 7.200.000 Sm³');
  });

  it('still states the flag when the screen does not hold the amount', () => {
    const s = anomalyStatement(record({ anomalyFlag: true, anomalyBaselinePriorCount: 0, anomalyBaselineTCo2e: null }));
    expect(s.tone).toBe('flagged');
    expect(s.headline).toBe('Above the first-period ceiling');
    expect(s.detail).toMatch(/above the plausibility ceiling for this category/);
    expect(s.detail).not.toMatch(/undefined|null|NaN/);
  });

  it('still states the flag, without figures, when today\'s table no longer shows the record above it', () => {
    const s = anomalyStatement(ceilingFlag({ activityValue: 900 }));
    expect(s.headline).toBe('Above the first-period ceiling');
    expect(s.detail).not.toContain('900');
  });

  it('is in Turkish with Turkish separators', () => {
    const s = anomalyStatement(ceilingFlag({ activityValue: 4_500_000, activityUnit: 'kWh' }), 'tr');
    expect(s.headline).toBe('İlk dönem tavanının üstünde');
    expect(s.detail).toContain('4.500.000 kWh');
    expect(s.detail).toContain('1.000.000 kWh');
    expect(s.detail).toContain('kanıt dokümanını ve birimi');
  });

  it('carries the flag mark in the review queue, not the first-period mark', () => {
    expect(isFirstPeriodRecord(ceilingFlag())).toBe(false);
    expect(isFirstPeriodRecord(ceilingFlag({ anomalyFlag: false }))).toBe(true);
  });

  it('reads a record scored before the ceilings, above it and unflagged, as a first-period record', () => {
    // Spec: "An approved first-period record from before the change" keeps its
    // verdict and is reported as a first-period record, not checked.
    const s = anomalyStatement(ceilingFlag({ anomalyFlag: false, activityValue: 4_500_000, activityUnit: 'kWh' }));
    expect(s.headline).toBe('First-period record');
    expect(s.tone).toBe('not_evaluated');
  });

  it('leaves a first period below its ceiling named as a first-period record', () => {
    const s = anomalyStatement(ceilingFlag({ anomalyFlag: false, activityValue: 900 }));
    expect(s.headline).toBe('First-period record');
    expect(s.tone).toBe('not_evaluated');
  });
});
