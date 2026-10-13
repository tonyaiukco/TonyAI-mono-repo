import { describe, expect, it } from 'vitest';
import { createTranslator } from 'use-intl/core';
import type { CalculationResultV2, FactorStatus, UncalculatedSnapshot } from '@/lib/types';
import { MESSAGES } from '@/messages';
import { conversionNote } from './conversion-view';

// Synthetic display fixture only; none of these numbers is an emission factor source.
const release = {
  id: 'display-fixture', publisher: 'Display fixture publisher', title: 'Display test only',
  edition: 'test-edition', ordinal: 1, status: 'fixture' as FactorStatus,
  sourceUrl: null, licence: null, publishedAt: null, gwpSet: null,
};
const snapshot: CalculationResultV2 = {
  snapshotSchema: 2, category: 'Natural Gas', activityType: 'natural_gas',
  geographyCode: 'TR', reportingYear: 2026, scope: 1,
  inputValue: 1, inputUnit: 'cubic_metres', normalizedValue: 7.125, normalizedUnit: 'kWh',
  conversionApplied: true, kgCo2e: 1, tCo2e: 0.001,
  factorId: 'display-factor', factorValue: 1, factorUnit: 'kgCO2e/kWh',
  methodology: 'Display test only', source: 'Display test only', version: 'test',
  gas: 'CO2e', gasCoverage: 'all_ghg', calorificBasis: 'gross', scope2Method: 'not_applicable',
  dataYear: 2026, yearPolicy: 'exact', factorRelease: release,
  conversion: {
    id: 'conversion', fromUnit: 'cubic_metres', toUnit: 'kWh', multiplier: 7.125,
    calorificBasis: 'net', referenceConditions: 'Test conditions', basis: 'Test derivation',
    dataYear: 2026, release,
  },
};

describe('conversionNote', () => {
  it.each(['en', 'tr'] as const)('%s reads the conversion, not the factor or a fixed constant', (locale) => {
    const t = createTranslator({ locale, messages: MESSAGES[locale].dataEntry });
    const note = conversionNote(snapshot, false, locale, t)!;
    expect(note).toContain(locale === 'en' ? '×7.125' : '×7,125');
    expect(note).toContain('m³ → kWh');
    expect(note).toContain(MESSAGES[locale].dataEntry.conversionNote.basis.net);
    for (const field of ['Test conditions', 'Test derivation', release.publisher, release.edition]) expect(note).toContain(field);
    expect(note).not.toContain('11.36');
  });

  it.each(['authoritative', 'placeholder', 'fixture', 'withdrawn'] as const)('names the conversion release as %s independently of the factor', (status) => {
    const t = createTranslator({ locale: 'en', messages: MESSAGES.en.dataEntry });
    const changed = { ...snapshot, conversion: { ...snapshot.conversion!, referenceConditions: null, release: { ...release, status } } };
    const note = conversionNote(changed, false, 'en', t)!;
    expect(note).toContain(MESSAGES.en.dataEntry.conversionNote.status[status]);
    expect(note).toContain(MESSAGES.en.dataEntry.conversionNote.unknownConditions);
  });

  it('does not invent a sourced step for pending, absent, legacy, uncalculated or definitional-only previews', () => {
    const t = createTranslator({ locale: 'en', messages: MESSAGES.en.dataEntry });
    const { snapshotSchema: _schema, conversion: _conversion, ...legacy } = snapshot;
    const uncalculated: UncalculatedSnapshot = {
      snapshotSchema: 1, category: 'Water', geographyCode: 'TR', reportingYear: 2026,
      scope: 3, inputValue: 1, inputUnit: 'cubic_metres', reasonCode: 'no_emission_factor', reason: 'Display test',
    };
    for (const value of [null, legacy, uncalculated, { ...snapshot, conversion: null }]) {
      expect(conversionNote(value, false, 'en', t)).toBeNull();
    }
    expect(conversionNote(snapshot, true, 'en', t)).toBeNull();
  });
});
