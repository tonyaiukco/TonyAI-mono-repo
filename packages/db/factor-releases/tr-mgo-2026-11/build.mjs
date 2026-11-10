// UAT round 2, BUG-R2-11 (owner decision K6, 2026-11-10): a supplementary IPCC
// release for marine gas oil (MGO) on TR records — OpenSpec change
// `uat2-mgo-factor-edition`, design D1–D4.
//
// It is NOT part of the TR factor package (docs/md_docs/Revision MD.md, which
// has no marine fuel) and does not supersede it: it is IPCC ordinal 2, a key
// (Mobile Combustion / marine_gas_oil) no other release prices. Every number
// below is IPCC 2006's own, copied once with its table, row and page; the
// factors are computed here and their arithmetic written into `methodology`.
//
// Read from the published PDFs by two independent readers, who agreed:
//   Vol. 2 Ch. 3  V2_3_Ch3_Mobile_Combustion.pdf
//                 sha256 b0b7d96d5ac90ecf359cdb74e932448cfba041c6cec0e1dc24f2def444508c30
//   Vol. 2 Ch. 1  V2_1_Ch1_Introduction.pdf
//                 sha256 e391cd4676d0891cd77f67d3bd76e0e6775386b468ce5ce7ebe2311a6ea1ac45
//
//   pnpm --filter @tonyai/db factor-releases:tr-mgo   # rewrite the JSON file
// (tsx, which reads @tonyai/shared-types from source). The spec compares it.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factorUnitFor, unitSymbol } from '@tonyai/shared-types';

export const EDITION = 'TONYAI-EF-TR-MGO-2026.11-AR6';
/**
 * The owner's approval of this edition's sources and method (K6 and the
 * explore decisions, 2026-11-10; recorded in the status file's Decisions log).
 */
const REVIEWED_ON = '2026-11-10';
/** When this edition was compiled from the IPCC 2006 chapters (its `publishedAt`). */
const COMPILED_ON = '2026-11-10';
const REVIEWED_BY = 'TonyAI Sustainability Team';
const YEARS = [2024, 2025, 2026];
const ACTIVITY_TYPE = 'marine_gas_oil';
const UNIT = 'kg';

/**
 * AR6 100-year GWPs, the values the TR package applies to combustion CH4 and
 * N2O (its §2, D09), so MGO is weighted as every other TR combustion row is.
 */
const GWP = { CO2: 1, CH4: 27.0, N2O: 273 };

/**
 * IPCC 2006 Vol. 2 Ch. 3 Table 3.5.2 "CO2 emission factors", row
 * "Gas/Diesel Oil", default (lower 72 600, upper 74 800), kg/TJ — PDF page 50,
 * printed page 3.50. IPCC never names MGO: it is a gas/diesel oil grade by
 * Ch. 1's fuel definitions ("diesel oil for diesel compression ignition (cars,
 * trucks, marine, etc.)"), so mapping it to this row is ours (design D4).
 */
const CO2_KG_PER_TJ = 74100;

/**
 * IPCC 2006 Vol. 2 Ch. 3 Table 3.5.3 "Default water-borne navigation CH4 and
 * N2O emission factors", its only row "Ocean-going Ships" (CH4 ±50%, N2O
 * −40%/+140%), kg/TJ — PDF page 50, printed page 3.50. Its footnote: "Default
 * values derived for diesel engines using heavy fuel oil." IPCC's Tier 1
 * default for every water-borne fuel; not specific to MGO (design, Risks).
 */
const CH4_KG_PER_TJ = 7;
const N2O_KG_PER_TJ = 2;

/**
 * IPCC 2006 Vol. 2 Ch. 1 Table 1.2 "Default net calorific values (NCVs)",
 * row "Gas/Diesel Oil" (lower 41.4, upper 43.3), TJ/Gg — PDF page 18, printed
 * page 1.18. A Gg is 10⁶ kg.
 */
const NCV_TJ_PER_GG = 43.0;
const KG_PER_GG = 1e6;

const SOURCE =
  'IPCC 2006 Vol. 2 Ch. 3 Table 3.5.2 (Gas/Diesel Oil, CO2; IPCC does not name MGO, which TonyAI maps to this row) and Table 3.5.3 (Ocean-going Ships, CH4 and N2O; derived for diesel engines using heavy fuel oil), with the default NCV of Gas/Diesel Oil from Vol. 2 Ch. 1 Table 1.2';

const fmt = (n) => String(n);

/**
 * A computed value as the database stores it: Prisma writes a double at 16
 * significant digits (see tr-2026-11/build.mjs).
 */
const stored = (n) => Number(n.toPrecision(16));

function factorRow(base, gas, value, methodology) {
  return {
    ...base,
    gas,
    gasCoverage: gas === 'CO2e' ? 'all_ghg' : null,
    factorValue: stored(value),
    methodology,
  };
}

function ipccMgoRelease() {
  const tjPerKg = NCV_TJ_PER_GG / KG_PER_GG;
  const tjText = `NCV ${fmt(NCV_TJ_PER_GG)} TJ/Gg ÷ 10^6 kg/Gg = ${fmt(tjPerKg)}`;
  const parts = { CO2: CO2_KG_PER_TJ * GWP.CO2, CH4: CH4_KG_PER_TJ * GWP.CH4, N2O: N2O_KG_PER_TJ * GWP.N2O };
  const total = parts.CO2 + parts.CH4 + parts.N2O;
  const weights = `CO2 ${fmt(CO2_KG_PER_TJ)} + CH4 ${fmt(CH4_KG_PER_TJ)} × 27 + N2O ${fmt(N2O_KG_PER_TJ)} × 273 = ${fmt(total)} kgCO2e/TJ (AR6)`;

  const factors = YEARS.flatMap((year) => {
    const base = {
      category: 'Mobile Combustion', activityType: ACTIVITY_TYPE, geographyCode: 'TR', reportingYear: year, dataYear: year,
      scope: 1, factorUnit: factorUnitFor(UNIT), normalizedUnit: UNIT, calorificBasis: 'not_applicable',
      scope2Method: 'not_applicable', source: SOURCE,
    };
    return [
      factorRow(base, 'CO2e', tjPerKg * total, `${tjText} TJ per ${unitSymbol(UNIT)} × (${weights})`),
      ...['CO2', 'CH4', 'N2O'].map((gas) =>
        factorRow(base, gas, tjPerKg * parts[gas], `${gas} share: ${tjText} TJ per ${unitSymbol(UNIT)} × ${fmt(parts[gas])} kgCO2e/TJ (AR6)`),
      ),
    ];
  });

  return {
    release: {
      publisher: 'IPCC',
      title: 'IPCC 2006 Guidelines for National Greenhouse Gas Inventories (Vol. 2 Energy, water-borne navigation) with AR6 GWPs: supplementary edition for marine gas oil in Türkiye',
      edition: EDITION,
      ordinal: 2,
      status: 'authoritative',
      sourceUrl: 'https://www.ipcc-nggip.iges.or.jp/public/2006gl/vol2.html',
      licence: 'IPCC public domain (publicly available international standard)',
      // As the TR package's releases date themselves by the package's seal, this
      // edition is dated by its own compilation: the Guidelines' publication
      // day is not printed in the chapters read, and is not guessed.
      publishedAt: COMPILED_ON,
      gwpSet: 'AR6',
      reviewedBy: REVIEWED_BY,
      reviewedAt: REVIEWED_ON,
      notes: `Supplementary: marine gas oil. Built by packages/db/factor-releases/tr-mgo-2026-11/build.mjs from IPCC 2006 Vol. 2 Ch. 1 and Ch. 3 directly, not from the TR factor package (docs/md_docs/Revision MD.md), which it neither supersedes nor overlaps. Priced per kg: marine fuel is delivered by mass (Bunker Delivery Note) and IPCC gives no density. publishedAt is this edition's compilation date, not the Guidelines' (2006); reviewedAt the owner's approval of its sources and method. Owner decision K6, 2026-11-10 (UAT round 2, BUG-R2-11).`,
    },
    factors,
    conversions: [],
    parameters: [],
  };
}

export function buildMgoRelease() {
  return ipccMgoRelease();
}

const here = dirname(fileURLToPath(import.meta.url));
export const RELEASE_FILE = join(here, 'ipcc-mgo.json');

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  writeFileSync(RELEASE_FILE, `${JSON.stringify(buildMgoRelease(), null, 2)}\n`);
  console.log(`wrote ${RELEASE_FILE}`);
}
