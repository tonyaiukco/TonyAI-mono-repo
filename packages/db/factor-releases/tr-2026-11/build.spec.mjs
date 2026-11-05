import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EQUIPMENT_TYPES, EQUIPMENT_TYPES_WITH_ALTERNATIVE, validateFactorReleaseImport } from '@tonyai/shared-types';
import { buildTrReleases, EDITION, RELEASE_FILES } from './build.mjs';

/**
 * LP4-02 PR5, task 5.1: the TR release files against the design's D6 table,
 * the package's own figures, the contract's validator and the committed JSON.
 */
const { ipcc, etkb } = buildTrReleases();
const six = (n) => Number(n.toFixed(6));
const total = (release, category, activityType, year = 2025) =>
  release.factors.find((f) => f.category === category && f.activityType === activityType && f.reportingYear === year && f.gas === 'CO2e');

describe('the TR release files (LP4-02 PR5, task 5.1)', () => {
  it('are what the build writes, byte for byte', () => {
    for (const [name, path] of Object.entries(RELEASE_FILES)) {
      expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(buildTrReleases()[name], null, 2)}\n`);
    }
  });

  it('hold every number as the database stores it, so a re-run is a no-op', () => {
    const numbers = [
      ...ipcc.factors.map((f) => f.factorValue), ...etkb.factors.map((f) => f.factorValue),
      ...ipcc.conversions.map((c) => c.multiplier), ...ipcc.parameters.map((p) => p.value),
    ];
    for (const n of numbers) expect(Number(n.toPrecision(16))).toBe(n);
  });

  it('pass the import contract with no issue', () => {
    expect(validateFactorReleaseImport(ipcc)).toEqual([]);
    expect(validateFactorReleaseImport(etkb)).toEqual([]);
  });

  it('are one edition under two publishers, authoritative, on AR6 (D1; owner decision 2026-11-05 (8))', () => {
    for (const [release, publisher] of [[ipcc, 'IPCC'], [etkb, 'ETKB']]) {
      expect(release.release).toMatchObject({
        publisher, edition: EDITION, ordinal: 1, status: 'authoritative', gwpSet: 'AR6',
        reviewedBy: 'TonyAI Sustainability Team', publishedAt: '2026-11-04', reviewedAt: '2026-11-05',
      });
    }
  });

  // Design D6's table, to six decimals: the per-unit factors computed from
  // the package's densities, NCVs and per-TJ factors at AR6.
  it.each([
    ['Fuel', 'diesel', 2.633422],
    ['Fuel', 'petrol', 2.224216],
    ['Fuel', 'lpg', 2.88019],
    ['Fuel', 'coal', 2.526194],
    ['Fuel', 'lng', 2.224506],
    ['Fuel', 'fuel_oil', 3.118712],
    ['Mobile Combustion', 'on_road_petrol', 2.307825],
    ['Mobile Combustion', 'on_road_diesel', 2.666195],
    ['Mobile Combustion', 'on_road_lpg', 1.655666],
    ['Mobile Combustion', 'off_road_petrol', 2.277026],
    ['Mobile Combustion', 'off_road_diesel', 2.905286],
    ['Fugitive Gas', 'gas_network_leakage', 19.254571],
  ])('prices %s / %s as D6 states', (category, activityType, expected) => {
    for (const year of [2024, 2025, 2026]) {
      expect(six(total(ipcc, category, activityType, year).factorValue)).toBe(expected);
    }
  });

  it('prices natural gas per net kWh, and converts Sm³ at the reference NCV (D5)', () => {
    const gas = total(ipcc, 'Natural Gas', 'natural_gas');
    expect(gas).toMatchObject({ normalizedUnit: 'kWh', calorificBasis: 'net' });
    expect(Number(gas.factorValue.toFixed(8))).toBe(0.20215548);
    expect(ipcc.conversions).toHaveLength(3);
    for (const c of ipcc.conversions) {
      expect(c).toMatchObject({ fromUnit: 'standard_cubic_metres', toUnit: 'kWh', calorificBasis: 'net', geographyCode: 'TR' });
      expect(six(c.multiplier)).toBe(9.588333);
    }
  });

  it('carries per-gas rows that sum to each combustion total, and only methane for leakage', () => {
    const groups = new Map();
    for (const f of ipcc.factors.filter((f) => f.category !== 'Refrigerants')) {
      const key = [f.category, f.activityType, f.reportingYear].join('|');
      const g = groups.get(key) ?? { total: 0, parts: {} };
      if (f.gas === 'CO2e') g.total = f.factorValue;
      else g.parts[f.gas] = f.factorValue;
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      const sum = Object.values(g.parts).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - g.total) / g.total, key).toBeLessThan(1e-12);
      if (key.startsWith('Fugitive Gas')) expect(Object.keys(g.parts)).toEqual(['CH4']);
      else expect(Object.keys(g.parts).sort()).toEqual(['CH4', 'CO2', 'N2O']);
    }
    expect(six(total(ipcc, 'Fugitive Gas', 'gas_network_leakage').factorValue / 29.8)).toBe(0.646127);
  });

  it('prices each gas at its AR6 GWP, and no other gas', () => {
    const gwps = Object.fromEntries(ipcc.factors.filter((f) => f.category === 'Refrigerants' && f.reportingYear === 2025)
      .map((f) => [f.activityType, f.factorValue]));
    expect(gwps).toEqual({ 'HFC-227ea': 3600, 'R-410A': 2256, 'R-134a': 1530, 'R-32': 771, 'R-404A': 4728, 'R-22': 1960, SF6: 25200 });
  });

  // A right number in a wrong unit prices wrongly, so the whole identity is
  // pinned, not only the value (qa-auditor's review of PR5).
  it('quotes every factor in its unit, basis and scope, the IPCC ones in their own year', () => {
    const expected = {
      'Natural Gas|natural_gas': ['kWh', 'net', 1],
      'Fuel|diesel': ['litres', 'not_applicable', 1], 'Fuel|petrol': ['litres', 'not_applicable', 1],
      'Fuel|lpg': ['kg', 'not_applicable', 1], 'Fuel|coal': ['kg', 'not_applicable', 1],
      'Fuel|lng': ['kg', 'not_applicable', 1], 'Fuel|fuel_oil': ['kg', 'not_applicable', 1],
      ...Object.fromEntries(['on_road_petrol', 'on_road_diesel', 'on_road_lpg', 'off_road_petrol', 'off_road_diesel']
        .map((t) => [`Mobile Combustion|${t}`, ['litres', 'not_applicable', 1]])),
      'Fugitive Gas|gas_network_leakage': ['standard_cubic_metres', 'not_applicable', 1],
      ...Object.fromEntries(['HFC-227ea', 'R-410A', 'R-134a', 'R-32', 'R-404A', 'R-22', 'SF6']
        .map((t) => [`Refrigerants|${t}`, ['kg', 'not_applicable', 1]])),
    };
    const seen = new Set();
    for (const f of ipcc.factors) {
      const key = `${f.category}|${f.activityType}`;
      seen.add(key);
      expect([f.normalizedUnit, f.calorificBasis, f.scope], key).toEqual(expected[key]);
      expect([f.scope2Method, f.geographyCode, f.dataYear], key).toEqual(['not_applicable', 'TR', f.reportingYear]);
      expect(f.gasCoverage, key).toBe(f.gas === 'CO2e' ? 'all_ghg' : null);
    }
    expect([...seen].sort()).toEqual(Object.keys(expected).sort());
    for (const f of etkb.factors) {
      expect([f.category, f.activityType, f.normalizedUnit, f.scope, f.gasCoverage])
        .toEqual(['Electricity', 'grid_electricity', 'kWh', 2, 'all_ghg']);
    }
  });

  it('covers 2024 to 2026 only, so other years fail closed', () => {
    for (const release of [ipcc, etkb]) {
      expect([...new Set(release.factors.map((f) => f.reportingYear))].sort()).toEqual([2024, 2025, 2026]);
      expect(release.factors.every((f) => f.geographyCode === 'TR')).toBe(true);
    }
  });

  it('dates the grid factors by ETKB data year (D07; owner decision 2026-11-05 (5))', () => {
    expect(etkb.factors.map((f) => [f.reportingYear, f.dataYear, f.factorValue, f.scope2Method])).toEqual([
      [2024, 2023, 0.442, 'location'],
      [2025, 2024, 0.434, 'location'],
      [2026, 2024, 0.434, 'location'],
    ]);
  });

  it('holds the reference values, the billed GCV range and every leak rate (D2, D7, D11)', () => {
    const value = (key, subject = null, isDefault = true) =>
      ipcc.parameters.find((p) => p.key === key && p.subject === subject && p.isDefault === isDefault)?.value;
    expect(value('reference_ncv')).toBe(8250);
    expect(value('reference_gcv')).toBe(9155);
    expect(value('billed_gcv_min')).toBe(8100);
    expect(value('billed_gcv_max')).toBe(10427);
    expect(Object.fromEntries(EQUIPMENT_TYPES.map((t) => [t, value('leak_rate', t)]))).toEqual({
      fire_suppression_system: 0.02, fire_extinguisher: 0.04, transformer_breaker: 0.0001, split_air_conditioner: 0.01,
      water_dispenser: 0.001, refrigerator: 0.001, chiller: 0.02, mobile_air_conditioner: 0.15, portable_air_conditioner: 0.1,
    });
    expect(Object.fromEntries(EQUIPMENT_TYPES_WITH_ALTERNATIVE.map((t) => [t, value('leak_rate', t, false)])))
      .toEqual({ split_air_conditioner: 0.1, chiller: 0.08 });
    expect(ipcc.parameters).toHaveLength(4 + 9 + 2);
    expect(ipcc.parameters.every((p) => p.source.length > 0)).toBe(true);
  });

  it('cites a source and gives the arithmetic on every row', () => {
    for (const f of [...ipcc.factors, ...etkb.factors]) {
      expect(f.source).toMatch(/TR factor package/);
      expect(f.methodology.length).toBeGreaterThan(10);
    }
  });

  // The package's §5 rows, recomputed from the files alone (the end-to-end
  // check through the loader and the engine is the integration spec).
  it.each([
    ['Electricity 2025', 4180.56 * 0.434, 1814.36],
    ['On-road petrol', 15973.75 * total(ipcc, 'Mobile Combustion', 'on_road_petrol').factorValue, 36864.62],
    ['On-road diesel', 3784.51 * total(ipcc, 'Mobile Combustion', 'on_road_diesel').factorValue, 10090.24],
    ['Leakage', 84783.36 * total(ipcc, 'Fugitive Gas', 'gas_network_leakage').factorValue, 1632467.22],
    ['Natural gas, default NCV', 100 * ipcc.conversions[1].multiplier * total(ipcc, 'Natural Gas', 'natural_gas').factorValue, 193.83],
  ])('reproduces the golden value %s within ±0.5%%', (_name, actual, expected) => {
    expect(Math.abs(actual - expected) / expected).toBeLessThan(0.005);
  });
});
