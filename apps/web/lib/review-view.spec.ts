import { MESSAGES } from '@/messages';
import { describe, it, expect, vi } from 'vitest';
import { reviewBatchFilters, reviewCalorificBasis, reviewRecordFilters, reviewReferences, reviewReportingEntity, reviewSelfGeneration, daysSince, waitingLabel as waitingLabelWith } from './review-view';
import { copyFor } from '@/lib/i18n/testing';

const waitingLabel = (iso: string | null, now?: number) => waitingLabelWith(iso, copyFor('review'), now);

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
    // The call site passes no `now`, so the default has to work — but the
    // clock is FROZEN here rather than read. Reading it made this the only
    // spec under `lib/` whose result depended on when it ran: the floor kept
    // it stable in practice rather than by construction, and a test that
    // passes by accident says nothing on the day it stops.
    vi.useFakeTimers({ now: NOW });
    try {
      const iso = new Date(NOW - 3 * 86_400_000).toISOString();
      expect(daysSince(iso)).toBe(3);
    } finally {
      vi.useRealTimers();
    }
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

  it('reads in Turkish, its count grouped', () => {
    expect(waitingLabelWith('2026-08-26T13:00:00.000Z', copyFor('review', 'tr'), NOW)).toBe('1 g');
    expect(waitingLabelWith('2023-08-28T12:00:00.000Z', copyFor('review', 'tr'), NOW)).toBe('1.096 g');
    expect(waitingLabelWith('2023-08-28T12:00:00.000Z', copyFor('review'), NOW)).toBe('1,096d');
    expect(waitingLabelWith(null, copyFor('review', 'tr'), NOW)).toBe('—');
  });
});

/**
 * Queue order. The column and the sort have to measure the same thing: the
 * number was right and the list order argued with it, which is worse than both
 * being consistently less useful — a reviewer acts on the order.
 */

describe('the review sheet\'s calorific basis (ng-kwh-engine)', () => {
  const record = (category: string, parameters: unknown) =>
    ({ category, parameters }) as Parameters<typeof reviewCalorificBasis>[0];

  it('shows the basis a TR natural gas bill carries', () => {
    expect(reviewCalorificBasis(record('Natural Gas', { cvBasis: 'gross' }))).toBe('gross');
    expect(reviewCalorificBasis(record('Natural Gas', { cvBasis: 'net' }))).toBe('net');
  });

  it('shows nothing for a volume reading, a record without parameters, or another category', () => {
    expect(reviewCalorificBasis(record('Natural Gas', { ncvKcalPerSm3: 8100 }))).toBeNull();
    expect(reviewCalorificBasis(record('Natural Gas', null))).toBeNull();
    expect(reviewCalorificBasis(record('Natural Gas', { cvBasis: null }))).toBeNull();
    expect(reviewCalorificBasis(record('Electricity', { cvBasis: 'net' }))).toBeNull();
    // A self-generation block is no gas basis (self-gen-model).
    expect(
      reviewCalorificBasis(record('Electricity', { generationTopology: 'A', selfGenerationSource: 'solar', selfGeneratedKwh: 400_000 })),
    ).toBeNull();
  });

  it.each([
    ['en', 'Calorific basis', 'Gross'],
    ['tr', 'Isıl değer esası', 'Brüt'],
  ] as const)('names it in %s', (locale, label, gross) => {
    expect(MESSAGES[locale].review.sheet.calorificBasis).toBe(label);
    expect(MESSAGES[locale].review.sheet.calorificBasisValue.gross).toBe(gross);
  });
});


describe('the review sheet\'s invoice number and supplier (uat4-quick-fixes, BUG-16)', () => {
  const record = (category: string, input: unknown) =>
    ({ category, input }) as Parameters<typeof reviewReferences>[0];

  it('shows both when the record holds both', () => {
    expect(reviewReferences(record('Mobile Combustion', { invoice_no: 'OZK2025000011923', supplier: 'Petrol Ofisi' })))
      .toEqual({ invoiceNo: 'OZK2025000011923', supplier: 'Petrol Ofisi' });
  });

  it('shows an Electricity record\'s utility provider as its supplier', () => {
    expect(reviewReferences(record('Electricity', { utility_provider: 'Enerjisa' }))).toEqual({ invoiceNo: null, supplier: 'Enerjisa' });
    expect(reviewReferences(record('Electricity', { invoice_no: 'E-7', utility_provider: 'Enerjisa' })))
      .toEqual({ invoiceNo: 'E-7', supplier: 'Enerjisa' });
  });

  it('shows neither for a record that holds neither', () => {
    expect(reviewReferences(record('Mobile Combustion', null))).toEqual({ invoiceNo: null, supplier: null });
    expect(reviewReferences(record('Mobile Combustion', {}))).toEqual({ invoiceNo: null, supplier: null });
    expect(reviewReferences(record('Fuel', { quantity: 12, fuel_notes: 'tank 3' }))).toEqual({ invoiceNo: null, supplier: null });
    expect(reviewReferences(record('Fuel', { invoice_no: '  ', supplier: '' }))).toEqual({ invoiceNo: null, supplier: null });
  });

  it('shows one without the other', () => {
    expect(reviewReferences(record('Fuel', { supplier: 'Shell' }))).toEqual({ invoiceNo: null, supplier: 'Shell' });
    expect(reviewReferences(record('Fuel', { invoice_no: 'A-1' }))).toEqual({ invoiceNo: 'A-1', supplier: null });
  });

  it('never shows another category\'s key as this record\'s supplier', () => {
    expect(reviewReferences(record('Fuel', { utility_provider: 'Enerjisa' })).supplier).toBeNull();
    expect(reviewReferences(record('Electricity', { supplier: 'Shell' })).supplier).toBeNull();
  });

  it.each([
    ['en', 'Invoice number', 'Supplier'],
    ['tr', 'Fatura no', 'Tedarikçi'],
  ] as const)('names them in %s', (locale, invoiceNo, supplier) => {
    expect(MESSAGES[locale].review.sheet.invoiceNo).toBe(invoiceNo);
    expect(MESSAGES[locale].review.sheet.supplier).toBe(supplier);
  });
});

describe('the review sheet\'s self-generation block (self-gen-form, design 7)', () => {
  type Subject = Parameters<typeof reviewSelfGeneration>[0];
  const record = (over: Partial<Subject> = {}): Subject => ({
    category: 'Electricity',
    activityValue: 600_000,
    activityUnit: 'kWh',
    generationFuelRecord: null,
    parameters: { generationTopology: 'A', selfGenerationSource: 'solar', selfGeneratedKwh: 400_000 },
    ...over,
  });

  it('shows the source and the generation, and the optional figures only when given', () => {
    expect(reviewSelfGeneration(record())).toEqual({
      source: 'solar',
      generatedKwh: 400_000,
      exportedKwh: null,
      facilityKwh: null,
      balance: null,
      fuelMissing: null,
    });
    const full = reviewSelfGeneration(
      record({
        parameters: {
          generationTopology: 'A', selfGenerationSource: 'wind', selfGeneratedKwh: 400_000,
          exportedToGridKwh: 50_000, facilityConsumptionKwh: 900_000,
        },
      }),
    );
    expect(full).toMatchObject({ source: 'wind', exportedKwh: 50_000, facilityKwh: 900_000 });
  });

  it('notes a balance gap under the Data Entry rule, in kWh whatever the unit', () => {
    const gap = (facilityConsumptionKwh: number, activityValue = 600_000, activityUnit = 'kWh') =>
      reviewSelfGeneration(
        record({
          activityValue,
          activityUnit,
          parameters: { generationTopology: 'A', selfGenerationSource: 'solar', selfGeneratedKwh: 400_000, facilityConsumptionKwh },
        }),
      )?.balance;
    expect(gap(900_000)).toEqual({ importKwh: 600_000, expectedImportKwh: 500_000, warns: true });
    expect(gap(1_000_000)?.warns).toBe(false);
    expect(gap(1_000_000, 600, 'MWh')?.warns).toBe(false);
  });

  it('notes a missing fuel record only for a fuel source the read found none for', () => {
    const fuel = (source: string, state: Subject['generationFuelRecord']) =>
      reviewSelfGeneration(
        record({
          generationFuelRecord: state,
          parameters: { generationTopology: 'A', selfGenerationSource: source, selfGeneratedKwh: 1 } as never,
        }),
      )?.fuelMissing;
    expect(fuel('natural_gas_chp', 'missing')).toBe('natural_gas_chp');
    expect(fuel('diesel_generator', 'missing')).toBe('diesel_generator');
    expect(fuel('natural_gas_chp', 'present')).toBeNull();
    // An API from before this change answers no field: no notice, never a false one.
    expect(fuel('natural_gas_chp', undefined as never)).toBeNull();
    expect(fuel('solar', 'missing')).toBeNull();
  });

  it('shows nothing for a plain record, a block of nulls, or another category', () => {
    expect(reviewSelfGeneration(record({ parameters: null }))).toBeNull();
    expect(
      reviewSelfGeneration(record({ parameters: { generationTopology: null, selfGenerationSource: null, selfGeneratedKwh: null } })),
    ).toBeNull();
    expect(
      reviewSelfGeneration(
        record({ category: 'Natural Gas', parameters: { selfGenerationSource: 'solar', selfGeneratedKwh: 1, cvBasis: 'net' } as never }),
      ),
    ).toBeNull();
  });
});

describe('reviewReportingEntity (inc26-central-reporter-onboarding, task 5.5)', () => {
  it("names the reporting company of a central reporter's record", () => {
    expect(reviewReportingEntity({ subsidiaryId: 'a', reportedBySubsidiaryId: 't', reportedBySubsidiaryName: 'Supply Co' })).toBe('Supply Co');
    expect(reviewReportingEntity({ subsidiaryId: 'a', reportedBySubsidiaryId: 't', reportedBySubsidiaryName: null })).toBe('—');
  });

  it("shows no line for a record of the company's own user, nor for an older answer without the field", () => {
    expect(reviewReportingEntity({ subsidiaryId: 'a', reportedBySubsidiaryId: 'a', reportedBySubsidiaryName: 'Alpha' })).toBeNull();
    expect(reviewReportingEntity({ subsidiaryId: 'a', reportedBySubsidiaryId: undefined as never, reportedBySubsidiaryName: null })).toBeNull();
  });
});

describe('the review queue lists (inc28-fuel-bulk D10)', () => {
  it('keeps every fuel batch record out of the Records list and its count', () => {
    expect(reviewRecordFilters({ statuses: ['submitted', 'under_review'], subsidiaryId: null, showAll: false }))
      .toEqual({ status: ['submitted', 'under_review'], awaitingMyDecision: true, inBatch: false });
    expect(reviewRecordFilters({ statuses: ['submitted'], subsidiaryId: 's1', showAll: true }))
      .toEqual({ status: ['submitted'], subsidiaryId: 's1', inBatch: false });
  });

  it('asks for the batches awaiting the viewer by default, and each pending status with "show all"', () => {
    expect(reviewBatchFilters({ subsidiaryId: null, showAll: false })).toEqual([{ awaitingMyDecision: true }]);
    // "Show all": one list over both pending statuses, in submission order (sixth review of WP9 PR B).
    expect(reviewBatchFilters({ subsidiaryId: 's1', showAll: true })).toEqual([{ subsidiaryId: 's1', inReview: true }]);
  });
});
