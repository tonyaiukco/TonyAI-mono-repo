import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateFactorReleaseImport } from '@tonyai/shared-types';
import { buildMgoRelease, EDITION, RELEASE_FILE } from './build.mjs';
import { RELEASE_FILES as TR_RELEASE_FILES } from '../tr-2026-11/build.mjs';

/**
 * UAT round 2, BUG-R2-11 (OpenSpec `uat2-mgo-factor-edition`, tasks 1.2–1.3):
 * the supplementary IPCC MGO release against IPCC 2006's printed values, the
 * import contract, the committed JSON and the TR package it sits beside.
 */
const mgo = buildMgoRelease();
const six = (n) => Number(n.toFixed(6));
const row = (gas, year = 2025) => mgo.factors.find((f) => f.reportingYear === year && f.gas === gas);

describe('the MGO release file (uat2-mgo-factor-edition)', () => {
  it('is what the build writes, byte for byte', () => {
    expect(readFileSync(RELEASE_FILE, 'utf8')).toBe(`${JSON.stringify(buildMgoRelease(), null, 2)}\n`);
  });

  it('holds every number as the database stores it, so a re-run is a no-op', () => {
    for (const { factorValue } of mgo.factors) expect(Number(factorValue.toPrecision(16))).toBe(factorValue);
  });

  it('passes the import contract with no issue', () => {
    expect(validateFactorReleaseImport(mgo)).toEqual([]);
  });

  it('is IPCC ordinal 2 under its own edition, authoritative, on AR6, reviewed (design D1, D7)', () => {
    expect(mgo.release).toMatchObject({
      publisher: 'IPCC', edition: EDITION, ordinal: 2, status: 'authoritative', gwpSet: 'AR6',
      reviewedBy: 'TonyAI Sustainability Team', reviewedAt: '2026-11-10', publishedAt: '2026-11-10',
    });
    expect(mgo.conversions).toEqual([]);
    expect(mgo.parameters).toEqual([]);
  });

  it('prices only TR marine gas oil per kg, 2024–2026, one row per gas (design D3)', () => {
    expect(mgo.factors).toHaveLength(12);
    for (const f of mgo.factors) {
      expect(f).toMatchObject({
        category: 'Mobile Combustion', activityType: 'marine_gas_oil', geographyCode: 'TR', scope: 1,
        factorUnit: 'kgCO2e/kg', normalizedUnit: 'kg', calorificBasis: 'not_applicable', scope2Method: 'not_applicable',
      });
      expect(f.dataYear).toBe(f.reportingYear);
    }
    const keys = mgo.factors.map((f) => `${f.reportingYear}/${f.gas}`).sort();
    expect(keys).toEqual(
      [2024, 2025, 2026].flatMap((y) => ['CH4', 'CO2', 'CO2e', 'N2O'].map((g) => `${y}/${g}`)).sort(),
    );
  });

  // Recomputed here from the printed values, not read from the builder:
  // NCV 43.0 TJ/Gg (Ch. 1 Table 1.2); CO2 74 100, CH4 7, N2O 2 kg/TJ (Ch. 3
  // Tables 3.5.2, 3.5.3); AR6 CH4 27, N2O 273.
  it('prices MGO at the IPCC values, per kg', () => {
    const tjPerKg = 43.0 / 1e6;
    for (const year of [2024, 2025, 2026]) {
      expect(six(row('CO2e', year).factorValue)).toBe(six(tjPerKg * (74100 + 7 * 27 + 2 * 273)));
      expect(six(row('CO2e', year).factorValue)).toBe(3.217905);
      expect(six(row('CO2', year).factorValue)).toBe(six(tjPerKg * 74100));
      expect(six(row('CH4', year).factorValue)).toBe(six(tjPerKg * 7 * 27));
      expect(six(row('N2O', year).factorValue)).toBe(six(tjPerKg * 2 * 273));
    }
  });

  it('carries per-gas rows that sum to the CO2e total', () => {
    for (const year of [2024, 2025, 2026]) {
      const sum = row('CO2', year).factorValue + row('CH4', year).factorValue + row('N2O', year).factorValue;
      expect(sum).toBeCloseTo(row('CO2e', year).factorValue, 12);
    }
  });

  // The extraction cross-check (design D4): IPCC's gas/diesel oil CO2 is the
  // value the TR package already prices on-road diesel with. Recovered from the
  // committed TR file: CO2 per litre ÷ (0.83 kg/L × 10 200 kcal/kg × 4.184e-9).
  it('uses the same gas/diesel oil CO2 per TJ as the TR package', () => {
    const tr = JSON.parse(readFileSync(TR_RELEASE_FILES.ipcc, 'utf8'));
    const diesel = tr.factors.find(
      (f) => f.activityType === 'on_road_diesel' && f.reportingYear === 2025 && f.gas === 'CO2',
    );
    const co2PerTj = diesel.factorValue / (0.83 * 10200 * 4.184e-9);
    expect(co2PerTj).toBeCloseTo(74100, 6);
    expect(row('CO2').factorValue / (43.0 / 1e6)).toBeCloseTo(co2PerTj, 6);
  });

  it('cites IPCC 2006 directly, never the TR package document', () => {
    for (const f of mgo.factors) {
      expect(f.source).toMatch(/IPCC 2006 Vol\. 2 Ch\. 3 Table 3\.5\.2/);
      expect(f.source).toMatch(/Table 3\.5\.3/);
      expect(f.source).toMatch(/Ch\. 1 Table 1\.2/);
      expect(f.source).not.toMatch(/Revision MD/);
    }
    expect(mgo.release.notes).toMatch(/neither supersedes nor overlaps/);
  });

  it('does not overlap the TR package: no TR row prices marine gas oil', () => {
    for (const path of Object.values(TR_RELEASE_FILES)) {
      const tr = JSON.parse(readFileSync(path, 'utf8'));
      expect(tr.factors.some((f) => f.activityType === 'marine_gas_oil')).toBe(false);
    }
  });
});
