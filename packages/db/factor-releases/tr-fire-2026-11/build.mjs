// UAT round 4, BUG-12 (OpenSpec `uat4-fire-suppression-entry`, design
// decisions 3 and 4; owner, Decisions 2026-11-24 (fifth)): a supplementary IPCC
// release for the Fire Suppression category on TR records.
//
// It sits beside the TR factor package (docs/md_docs/Revision MD.md) and the
// MGO edition and supersedes neither: it is IPCC ordinal 3 and prices only
// `Fire Suppression`, a category no other release prices. So loading it
// withdraws nothing, and no open draft becomes stale.
//
// The three gas values and the three leak rates are the TR package's own
// (§4.6), read from the TR build's tables so each number has one copy:
// CO2 = 1, FM200 (HFC-227ea) = 3,600, SF6 = 25,200 (AR6), and the fire
// suppression system 2%, the fire extinguisher 4% and the transformer breaker
// gas 0.01%. The fourth row, dry powder or foam, is ZERO, and it is not from
// the package: it states the owner's UAT round 4 decision (BUG-12) that the
// agent holds no greenhouse gas. It is the one value here the package does not
// give, and it is on the external reviewer's list.
//
//   pnpm --filter @tonyai/db factor-releases:tr-fire   # rewrite the JSON file
// (tsx, which reads @tonyai/shared-types from source). The spec compares it.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { factorUnitFor } from '@tonyai/shared-types';
import { GWP, LEAK_RATES, PACKAGE, REFRIGERANTS } from '../tr-2026-11/build.mjs';

export const EDITION = 'TONYAI-EF-TR-FIRE-2026.11-AR6';
/** The owner's approval of this edition (Decisions 2026-11-24 (fifth), in the status file). */
const REVIEWED_ON = '2026-11-24';
/** When this edition was compiled from the TR package (its `publishedAt`). */
const COMPILED_ON = '2026-11-24';
const REVIEWED_BY = 'TonyAI Sustainability Team';
const YEARS = [2024, 2025, 2026];
const CATEGORY = 'Fire Suppression';
const UNIT = 'kg';

/** The activity type of dry powder and foam: no greenhouse gas. */
export const NO_GREENHOUSE_GAS = 'dry_powder_or_foam';

/** The package's §4.6 row of a gas, from the TR build's own table. */
const refrigerant = (type) => {
  const row = REFRIGERANTS.find((r) => r.type === type);
  if (!row) throw new Error(`the TR build holds no ${type}`);
  return row;
};

/** The fire suppression gases and their AR6 GWPs, as the package's §4.6 states them. */
export const GASES = [
  // §4.6: "CO2 = 1". The TR build holds it as its AR6 CO2 weight (§2, D09).
  { type: 'CO2', gwp: GWP.CO2, label: 'CO2' },
  { type: 'HFC-227ea', gwp: refrigerant('HFC-227ea').gwp, label: refrigerant('HFC-227ea').label },
  { type: 'SF6', gwp: refrigerant('SF6').gwp, label: refrigerant('SF6').label },
];

/** The three fire devices' default leak rates, from the TR build's own table. */
export const FIRE_DEVICES = ['fire_extinguisher', 'fire_suppression_system', 'transformer_breaker'];
export const FIRE_LEAK_RATES = FIRE_DEVICES.map((subject) => {
  const row = LEAK_RATES.find((r) => r.subject === subject);
  if (!row || row.alternative !== undefined) throw new Error(`the TR build holds no single default rate for ${subject}`);
  return row;
});

const fmt = (n) => String(n);

const ZERO_SOURCE =
  'TonyAI owner decision, UAT round 4, BUG-12 (status file, Decisions 2026-11-24 (fifth)): a dry powder or foam extinguishing agent holds no greenhouse gas. Not from the TR factor package, which does not name it.';
const ZERO_METHODOLOGY =
  'Not a measured emission factor: the zero states that a dry powder or foam agent holds no greenhouse gas as its extinguishing agent, so any released mass of it is 0 kgCO2e. A CO2 propellant cartridge is a CO2 line of its own. It lets such a record be calculated, with its lines and evidence, rather than left without a figure. A missing factor is never read as zero.';

function ipccFireRelease() {
  const factors = YEARS.flatMap((year) => {
    const base = {
      category: CATEGORY, geographyCode: 'TR', reportingYear: year, dataYear: year, gas: 'CO2e', gasCoverage: 'all_ghg',
      scope: 1, factorUnit: factorUnitFor(UNIT), normalizedUnit: UNIT, calorificBasis: 'not_applicable', scope2Method: 'not_applicable',
    };
    return [
      ...GASES.map((gas) => ({
        ...base,
        activityType: gas.type,
        factorValue: gas.gwp,
        methodology: `AR6 100-year GWP of ${gas.label}: ${fmt(gas.gwp)} kgCO2e per kg released; the capacity method prices the released mass (D7)`,
        source: `IPCC AR6 WGI Table 7.15, via ${PACKAGE} §4.6`,
      })),
      { ...base, activityType: NO_GREENHOUSE_GAS, factorValue: 0, methodology: ZERO_METHODOLOGY, source: ZERO_SOURCE },
    ];
  });

  const parameters = FIRE_LEAK_RATES.map((r) => ({
    key: 'leak_rate',
    subject: r.subject,
    value: r.rate,
    unit: 'fraction',
    isDefault: true,
    // As §4.6 cites them, whole: IPCC 2006 Vol. 3 Ch. 7 and the Enerya tables.
    source: `${PACKAGE} §4.6 (${r.label}; IPCC 2006 Vol. 3 Ch. 7 and Enerya V8-2 EF Tables 2 and 3, as the package cites them)`,
    methodology: 'Default annual leak rate of the installed capacity (D7); the same rate as the TR package release, repeated so a fire suppression record reads it from the release that priced it',
  }));

  return {
    release: {
      publisher: 'IPCC',
      // The issued report prints a release's title, not a row's source, so the
      // title names the zero's origin itself (data-factors review).
      title: 'AR6 GWPs and device leak rates as sealed in the TonyAI TR factor package (§4.6): supplementary edition for fire suppression in Türkiye; the dry powder or foam zero is a TonyAI owner decision (UAT round 4, BUG-12), not from IPCC or the package',
      edition: EDITION,
      ordinal: 3,
      status: 'authoritative',
      sourceUrl: 'https://www.ipcc-nggip.iges.or.jp/public/2006gl/vol3.html',
      licence: 'IPCC public domain (publicly available international standard)',
      // Dated by its own compilation, as the MGO edition is.
      publishedAt: COMPILED_ON,
      gwpSet: 'AR6',
      reviewedBy: REVIEWED_BY,
      reviewedAt: REVIEWED_ON,
      notes: `Supplementary: the Fire Suppression category. Built by packages/db/factor-releases/tr-fire-2026-11/build.mjs from the TR factor package's §4.6 (docs/md_docs/Revision MD.md), which it neither supersedes nor overlaps: no other release prices Fire Suppression. CO2, FM200 (HFC-227ea) and SF6 are the package's AR6 GWPs, and the three leak rates are its fire device rates. The dry powder or foam row is zero by the owner's UAT round 4 decision (BUG-12), not from the package. Open for the external reviewer: whether the 4% and 2% rates apply to CO2 equipment, and the zero. publishedAt is this edition's compilation date; reviewedAt the owner's approval (Decisions 2026-11-24 (fifth)).`,
    },
    factors,
    conversions: [],
    parameters,
  };
}

export function buildFireRelease() {
  return ipccFireRelease();
}

const here = dirname(fileURLToPath(import.meta.url));
export const RELEASE_FILE = join(here, 'ipcc-fire.json');

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  writeFileSync(RELEASE_FILE, `${JSON.stringify(buildFireRelease(), null, 2)}\n`);
  console.log(`wrote ${RELEASE_FILE}`);
}
