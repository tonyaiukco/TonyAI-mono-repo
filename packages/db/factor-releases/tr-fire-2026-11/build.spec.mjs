import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recordActivityTypesFor, validateFactorReleaseImport } from '@tonyai/shared-types';
import { buildFireRelease, EDITION, RELEASE_FILE } from './build.mjs';
import { RELEASE_FILES as TR_RELEASE_FILES } from '../tr-2026-11/build.mjs';
import { RELEASE_FILE as MGO_RELEASE_FILE } from '../tr-mgo-2026-11/build.mjs';

/**
 * UAT round 4, BUG-12 (OpenSpec `uat4-fire-suppression-entry`, task 4.2): the
 * supplementary fire suppression release against the TR package's §4.6, the
 * import contract, the committed JSON and the releases it sits beside.
 */
const fire = buildFireRelease();
const tr = JSON.parse(readFileSync(TR_RELEASE_FILES.ipcc, 'utf8'));

describe('the fire suppression release file (uat4-fire-suppression-entry)', () => {
  it('is what the build writes, byte for byte', () => {
    expect(readFileSync(RELEASE_FILE, 'utf8')).toBe(`${JSON.stringify(buildFireRelease(), null, 2)}\n`);
  });

  it('passes the import contract with no issue', () => {
    expect(validateFactorReleaseImport(fire)).toEqual([]);
  });

  it('is IPCC ordinal 3 under its own edition, authoritative, on AR6, reviewed by the owner\'s approval', () => {
    expect(fire.release).toMatchObject({
      publisher: 'IPCC', edition: EDITION, ordinal: 3, status: 'authoritative', gwpSet: 'AR6',
      reviewedBy: 'TonyAI Sustainability Team', reviewedAt: '2026-11-24', publishedAt: '2026-11-24',
    });
    expect(EDITION).toBe('TONYAI-EF-TR-FIRE-2026.11-AR6');
    expect(fire.conversions).toEqual([]);
    expect(fire.release.notes).toMatch(/neither supersedes nor overlaps/);
    // The issued report prints the title, never a row's source: it must not
    // credit the zero to IPCC or the package (data-factors review).
    expect(fire.release.title).toMatch(/dry powder or foam zero is a TonyAI owner decision \(UAT round 4, BUG-12\), not from IPCC or the package/);
    expect(fire.release.title.length).toBeLessThanOrEqual(500);
  });

  it('prices exactly the category\'s four types for TR, 2024–2026, per kg, one CO2e row each', () => {
    expect(fire.factors).toHaveLength(12);
    for (const f of fire.factors) {
      expect(f).toMatchObject({
        category: 'Fire Suppression', geographyCode: 'TR', scope: 1, gas: 'CO2e', gasCoverage: 'all_ghg',
        factorUnit: 'kgCO2e/kg', normalizedUnit: 'kg', calorificBasis: 'not_applicable', scope2Method: 'not_applicable',
      });
      expect(f.dataYear).toBe(f.reportingYear);
    }
    expect([...new Set(fire.factors.map((f) => f.reportingYear))]).toEqual([2024, 2025, 2026]);
    const types = recordActivityTypesFor('Fire Suppression').map((t) => t.value);
    for (const year of [2024, 2025, 2026]) {
      expect(fire.factors.filter((f) => f.reportingYear === year).map((f) => f.activityType).sort()).toEqual([...types].sort());
    }
  });

  // The values written out here, not read from the builder.
  it('holds exactly the value map: CO2 1, FM200 3,600, SF6 25,200, dry powder or foam 0', () => {
    const values = Object.fromEntries(fire.factors.map((f) => [`${f.reportingYear}/${f.activityType}`, f.factorValue]));
    for (const year of [2024, 2025, 2026]) {
      expect(values[`${year}/CO2`]).toBe(1);
      expect(values[`${year}/HFC-227ea`]).toBe(3600);
      expect(values[`${year}/SF6`]).toBe(25200);
      expect(values[`${year}/dry_powder_or_foam`]).toBe(0);
    }
  });

  it('carries the three fire devices\' default leak rates, 4%, 2% and 0.01%, and no other rate', () => {
    expect(fire.parameters.map((p) => [p.key, p.subject, p.value, p.unit, p.isDefault])).toEqual([
      ['leak_rate', 'fire_extinguisher', 0.04, 'fraction', true],
      ['leak_rate', 'fire_suppression_system', 0.02, 'fraction', true],
      ['leak_rate', 'transformer_breaker', 0.0001, 'fraction', true],
    ]);
  });

  it('repeats the TR package release\'s own rates for the three devices, and its own GWPs', () => {
    for (const p of fire.parameters) {
      const package_ = tr.parameters.filter((q) => q.key === 'leak_rate' && q.subject === p.subject);
      expect(package_, p.subject).toHaveLength(1);
      expect(p.value).toBe(package_[0].value);
      expect(package_[0].isDefault).toBe(true);
    }
    for (const type of ['HFC-227ea', 'SF6']) {
      const packageRow = tr.factors.find((f) => f.category === 'Refrigerants' && f.activityType === type && f.reportingYear === 2025);
      expect(fire.factors.find((f) => f.activityType === type && f.reportingYear === 2025).factorValue).toBe(packageRow.factorValue);
    }
  });

  it('cites the package\'s §4.6 for every gas row and rate, and never for the zero row', () => {
    for (const f of fire.factors.filter((x) => x.activityType !== 'dry_powder_or_foam')) {
      expect(f.source).toMatch(/§4\.6/);
      expect(f.source).toMatch(/IPCC AR6/);
      expect(f.source).toMatch(/Revision MD\.md/);
    }
    for (const p of fire.parameters) expect(p.source).toMatch(/Revision MD\.md\) §4\.6/);
    for (const f of fire.factors.filter((x) => x.activityType === 'dry_powder_or_foam')) {
      expect(f.source).not.toMatch(/Revision MD/);
      expect(f.source).toMatch(/UAT round 4, BUG-12/);
      expect(f.source).toMatch(/no greenhouse gas/);
      expect(f.methodology).toMatch(/^Not a measured emission factor/);
      expect(f.methodology).toMatch(/holds no greenhouse gas/);
    }
  });

  it('overlaps neither the TR package nor the MGO edition', () => {
    for (const path of [...Object.values(TR_RELEASE_FILES), MGO_RELEASE_FILE]) {
      const other = JSON.parse(readFileSync(path, 'utf8'));
      expect(other.factors.some((f) => f.category === 'Fire Suppression'), path).toBe(false);
      expect(other.release.ordinal === 3 && other.release.publisher === 'IPCC', path).toBe(false);
    }
  });
});
