// LP4-02 PR5, task 5.1: the two authoritative TR release files, derived from
// the owner- and COO-sealed TR factor package (docs/md_docs/Revision MD.md,
// edition TONYAI-EF-TR-UK-2026.11-AR6-SEALED) and the owner's decisions of
// 2026-11-05 (design D1, D2, D5, D6, D7, D11).
//
// Every number below is the package's own figure, copied once, with its
// section; every factor is computed from them here, and its arithmetic is
// written into the row's `methodology`. Nothing is rounded: the design's D6
// table is the check, to six decimals (build.spec.mjs).
//
//   pnpm --filter @tonyai/db factor-releases:tr   # rewrite the JSON files
// (tsx, which reads @tonyai/shared-types from source). The spec compares them.
//
// The JSON files are what the loader reads; the spec fails if they differ
// from what this builds.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KWH_PER_KCAL, STANDARD_REFERENCE_CONDITIONS, factorUnitFor, unitSymbol } from '@tonyai/shared-types';

export const EDITION = 'TONYAI-EF-TR-UK-2026.11-AR6-SEALED';
/** The package's seal date (§3), when its reviewers signed it. */
const SEALED_ON = '2026-11-04';
const REVIEWED_BY = 'TonyAI Sustainability Team';
const PACKAGE = 'TR factor package TONYAI-EF-TR-UK-2026.11-AR6-SEALED (docs/md_docs/Revision MD.md)';
const YEARS = [2024, 2025, 2026];

/** TJ per kcal: 4.184 kJ per kcal, 10⁹ kJ per TJ (package §4.1, §4.2). */
const TJ_PER_KCAL = 4.184e-9;
/** TJ per kWh: 3.6 MJ per kWh (package §4.2). */
const TJ_PER_KWH = 3.6e-6;
/** AR6 100-year GWPs (package §2, D09). */
const GWP = { CO2: 1, CH4_COMBUSTION: 27.0, CH4_FUGITIVE: 29.8, N2O: 273 };

/** Package §4.3: stationary combustion, per TJ on the net basis. */
const STATIONARY = [
  { type: 'diesel', unit: 'litres', density: 0.83, ncv: 10200, co2: 74100, ch4: 3.0, n2o: 0.6, label: 'Diesel (stationary)' },
  { type: 'petrol', unit: 'litres', density: 0.735, ncv: 10400, co2: 69300, ch4: 3.0, n2o: 0.6, label: 'Gasoline (stationary)' },
  { type: 'lpg', unit: 'kg', density: null, ncv: 10900, co2: 63100, ch4: 1.0, n2o: 0.1, label: 'LPG (stationary)' },
  { type: 'coal', unit: 'kg', density: null, ncv: 6100, co2: 98300, ch4: 10.0, n2o: 1.5, label: 'Coal' },
  { type: 'lng', unit: 'kg', density: null, ncv: 8250, co2: 64200, ch4: 3.0, n2o: 0.6, label: 'LNG' },
  { type: 'fuel_oil', unit: 'kg', density: null, ncv: 9600, co2: 77400, ch4: 3.0, n2o: 0.6, label: 'Fuel oil' },
];

/** Package §4.4: mobile combustion by vehicle mode, per TJ on the net basis. */
const MOBILE = [
  { type: 'on_road_petrol', density: 0.735, ncv: 10400, co2: 69300, ch4: 25.0, n2o: 8.0, label: 'ON ROAD (Gasoline)' },
  { type: 'on_road_diesel', density: 0.83, ncv: 10200, co2: 74100, ch4: 3.9, n2o: 3.9, label: 'ON ROAD (Diesel)' },
  { type: 'on_road_lpg', density: 0.56, ncv: 10900, co2: 63100, ch4: 62.0, n2o: 0.2, label: 'ON ROAD (LPG)' },
  { type: 'off_road_petrol', density: 0.735, ncv: 10400, co2: 69300, ch4: 50.0, n2o: 2.0, label: 'OFF ROAD (Gasoline)' },
  { type: 'off_road_diesel', density: 0.83, ncv: 10200, co2: 74100, ch4: 4.15, n2o: 28.6, label: 'OFF ROAD (Diesel)' },
];

/** Package §4.3 natural gas row and §4.1: the IPCC 2006 per-TJ factors and the reference calorific values. */
const NATURAL_GAS = { co2: 56100, ch4: 1.0, n2o: 0.1 };
const REFERENCE_NCV = 8250;
const REFERENCE_GCV = 9155;

/**
 * Package §4.2 and §5 (golden value 8): gas-network leakage. A standard m³ at
 * 15 °C becomes a 0 °C m³ by 273/288, at a density of 0.7409 kg/Sm³ and a
 * methane share of 0.92 (owner decision 2026-11-05: the table's 0.67 is not used).
 */
const LEAKAGE = { temperature: 273 / 288, density: 0.7409, methaneShare: 0.92 };

/** Package §4.6: AR6 GWPs of the gases (kgCO2e per kg). */
const REFRIGERANTS = [
  { type: 'HFC-227ea', gwp: 3600, label: 'FM200 (HFC-227ea)' },
  { type: 'R-410A', gwp: 2256, label: 'R-410A' },
  { type: 'R-134a', gwp: 1530, label: 'R-134a' },
  { type: 'R-32', gwp: 771, label: 'R-32' },
  { type: 'R-404A', gwp: 4728, label: 'R-404A' },
  { type: 'R-22', gwp: 1960, label: 'HCFC-22 (R-22)' },
  { type: 'SF6', gwp: 25200, label: 'SF6' },
];

/** Package §4.6: annual leak rates by equipment type, and the two alternatives (D7). */
const LEAK_RATES = [
  { subject: 'fire_suppression_system', rate: 0.02, label: 'Fire suppression system 2.0%' },
  { subject: 'fire_extinguisher', rate: 0.04, label: 'Fire extinguisher 4.0%' },
  { subject: 'transformer_breaker', rate: 0.0001, label: 'Transformer breaker gas (SF6) 0.01%' },
  { subject: 'split_air_conditioner', rate: 0.01, alternative: 0.1, label: 'Split or office air conditioner 1.0%, option 10.0%' },
  { subject: 'water_dispenser', rate: 0.001, label: 'Water dispenser 0.1%' },
  { subject: 'refrigerator', rate: 0.001, label: 'Refrigerator 0.1%' },
  { subject: 'chiller', rate: 0.02, alternative: 0.08, label: 'Chiller 2.0%, industrial option 8.0%' },
  { subject: 'mobile_air_conditioner', rate: 0.15, label: 'Vehicle air conditioner 15.0%' },
  { subject: 'portable_air_conditioner', rate: 0.1, label: 'Portable air conditioner 10.0%' },
];

/**
 * The billed GCV range (D11, task 5.5; owner decision 2026-11-05): Annex 1 of
 * BOTAŞ's transmission network operating rules, the natural gas quality
 * specification, at 15 °C and 1.01325 bar absolute.
 */
const SID_URL = 'https://www.botas.gov.tr/uploads/sayfaResim/191307-d_21122023_12275_kk.doc';
const BILLED_GCV = { min: 8100, max: 10427 };

/** Package §4.5 and D07 (owner decision 2026-11-05 (5)): ETKB grid factors by reporting year. */
const GRID = [
  { reportingYear: 2024, dataYear: 2023, value: 0.442 },
  { reportingYear: 2025, dataYear: 2024, value: 0.434 },
  { reportingYear: 2026, dataYear: 2024, value: 0.434 },
];

const fmt = (n) => String(n);

/**
 * A computed value as the database stores it: Prisma writes a double at 16
 * significant digits. A file holding the 17th digit would load, and then be
 * refused as "already loaded with other content" on the loader's re-run, which
 * compares the file with the stored rows exactly.
 */
const stored = (n) => Number(n.toPrecision(16));

/** The per-gas kgCO2e of one TJ, and their total (AR6, combustion CH4). */
function perTj({ co2, ch4, n2o }) {
  const parts = { CO2: co2 * GWP.CO2, CH4: ch4 * GWP.CH4_COMBUSTION, N2O: n2o * GWP.N2O };
  return { parts, total: parts.CO2 + parts.CH4 + parts.N2O };
}

function factorRow(base, gas, value, methodology) {
  return {
    ...base,
    gas,
    gasCoverage: gas === 'CO2e' ? 'all_ghg' : null,
    factorValue: stored(value),
    methodology,
  };
}

/** A CO2e total and its per-gas disclosure rows, for every reporting year. */
function combustionRows({ category, activityType, unit, calorificBasis, tjPerUnit, tjText, gases, source }) {
  const { parts, total } = perTj(gases);
  const weights = `CO2 ${fmt(gases.co2)} + CH4 ${fmt(gases.ch4)} × 27 + N2O ${fmt(gases.n2o)} × 273 = ${fmt(total)} kgCO2e/TJ (AR6)`;
  return YEARS.flatMap((year) => {
    const base = {
      category, activityType, geographyCode: 'TR', reportingYear: year, dataYear: year, scope: 1,
      factorUnit: factorUnitFor(unit), normalizedUnit: unit, calorificBasis, scope2Method: 'not_applicable', source,
    };
    return [
      factorRow(base, 'CO2e', tjPerUnit * total, `${tjText} TJ per ${unitSymbol(unit)} × (${weights})`),
      ...['CO2', 'CH4', 'N2O'].map((gas) =>
        factorRow(base, gas, tjPerUnit * parts[gas], `${gas} share: ${tjText} TJ per ${unitSymbol(unit)} × ${fmt(parts[gas])} kgCO2e/TJ (AR6)`),
      ),
    ];
  });
}

function ipccRelease() {
  const factors = [];

  // Natural gas (D5): a net-basis kWh row; the Sm³ chain is the conversion below.
  factors.push(...combustionRows({
    category: 'Natural Gas', activityType: 'natural_gas', unit: 'kWh', calorificBasis: 'net',
    tjPerUnit: TJ_PER_KWH, tjText: '3.6e-6',
    gases: NATURAL_GAS,
    source: `IPCC 2006 Vol. 2 Ch. 2 Table 2.2 (natural gas, net calorific value basis), via ${PACKAGE} §4.1, §4.3`,
  }));

  for (const fuel of STATIONARY) {
    const tjPerUnit = (fuel.density ?? 1) * fuel.ncv * TJ_PER_KCAL;
    const tjText = fuel.density === null
      ? `${fmt(fuel.ncv)} kcal/kg × 4.184e-9`
      : `${fmt(fuel.density)} kg/L × ${fmt(fuel.ncv)} kcal/kg × 4.184e-9`;
    factors.push(...combustionRows({
      category: 'Fuel', activityType: fuel.type, unit: fuel.unit, calorificBasis: 'not_applicable',
      tjPerUnit, tjText, gases: fuel,
      source: `IPCC 2006 Vol. 2 Ch. 2 Table 2.2 (${fuel.label}), with the package's density and NCV, via ${PACKAGE} §4.3`,
    }));
  }

  // Mobile modes (D6; owner decision 2026-11-05 (4)): the package's formula,
  // not its combined column.
  for (const mode of MOBILE) {
    factors.push(...combustionRows({
      category: 'Mobile Combustion', activityType: mode.type, unit: 'litres', calorificBasis: 'not_applicable',
      tjPerUnit: mode.density * mode.ncv * TJ_PER_KCAL,
      tjText: `${fmt(mode.density)} kg/L × ${fmt(mode.ncv)} kcal/kg × 4.184e-9`,
      gases: mode,
      source: `IPCC 2006 Vol. 2 Ch. 3 Tables 3.2.1 and 3.2.2 (${mode.label}), via ${PACKAGE} §4.4`,
    }));
  }

  // Gas-network leakage: methane only, at the fugitive GWP.
  const ch4PerSm3 = LEAKAGE.temperature * LEAKAGE.density * LEAKAGE.methaneShare;
  const leakageMethod = `273/288 × ${fmt(LEAKAGE.density)} kg/Sm3 × ${fmt(LEAKAGE.methaneShare)} CH4 = ${fmt(ch4PerSm3)} kg CH4 per Sm3 (15 °C), × 29.8 (AR6 fugitive CH4)`;
  for (const year of YEARS) {
    const base = {
      category: 'Fugitive Gas', activityType: 'gas_network_leakage', geographyCode: 'TR', reportingYear: year, dataYear: year,
      scope: 1, factorUnit: factorUnitFor('standard_cubic_metres'), normalizedUnit: 'standard_cubic_metres', calorificBasis: 'not_applicable',
      scope2Method: 'not_applicable',
      source: `IPCC AR6 WGI Table 7.15 (fugitive CH4 GWP) with the holding's network gas composition, via ${PACKAGE} §1, §4.2 and §5`,
    };
    factors.push(
      factorRow(base, 'CO2e', ch4PerSm3 * GWP.CH4_FUGITIVE, leakageMethod),
      factorRow(base, 'CH4', ch4PerSm3 * GWP.CH4_FUGITIVE, `CH4 share (the whole total): ${leakageMethod}`),
    );
  }

  for (const gas of REFRIGERANTS) {
    for (const year of YEARS) {
      factors.push({
        category: 'Refrigerants', activityType: gas.type, gas: 'CO2e', gasCoverage: 'all_ghg', geographyCode: 'TR',
        reportingYear: year, dataYear: year, scope: 1, factorValue: gas.gwp, factorUnit: factorUnitFor('kg'), normalizedUnit: 'kg',
        calorificBasis: 'not_applicable', scope2Method: 'not_applicable',
        methodology: `AR6 100-year GWP of ${gas.label}: ${fmt(gas.gwp)} kgCO2e per kg released; the capacity method prices the released mass (D7)`,
        source: `IPCC AR6 WGI Table 7.15, via ${PACKAGE} §4.6`,
      });
    }
  }

  const conversions = YEARS.map((year) => ({
    category: 'Natural Gas', activityType: 'natural_gas', geographyCode: 'TR', reportingYear: year, dataYear: year,
    fromUnit: 'standard_cubic_metres', toUnit: 'kWh', multiplier: stored(REFERENCE_NCV * KWH_PER_KCAL), calorificBasis: 'net',
    referenceConditions: STANDARD_REFERENCE_CONDITIONS,
    basis: `Reference net calorific value ${fmt(REFERENCE_NCV)} kcal/Sm3 × 4.184 kJ/kcal ÷ 3,600 kJ/kWh (${PACKAGE} §4.1, §4.2)`,
  }));

  const parameter = (key, subject, value, unit, isDefault, source, methodology = null) =>
    ({ key, subject, value, unit, isDefault, source, methodology });
  const parameters = [
    parameter('reference_ncv', null, REFERENCE_NCV, 'kcal/Sm3', true,
      `${PACKAGE} §4.1, §4.3 (Türkiye national inventory / BOTAŞ NCV acceptance)`,
      'The default net calorific value of a record in Sm3 (D5)'),
    parameter('reference_gcv', null, REFERENCE_GCV, 'kcal/Sm3', true,
      `${PACKAGE} §4.1 (BOTAŞ reference gross calorific value of a standard cubic metre)`,
      'Effective NCV of a billed GCV = reference NCV × reference GCV ÷ billed GCV, as the package writes it (owner decision 2026-11-05 (3))'),
    parameter('billed_gcv_min', null, BILLED_GCV.min, 'kcal/Sm3', true,
      `BOTAŞ transmission network operating rules (ŞİD), Annex 1, natural gas quality specification: gross calorific value minimum, m3 at 15 °C and 1.01325 bar (${SID_URL})`,
      'A billed GCV below it is refused (D11; owner decision 2026-11-05)'),
    parameter('billed_gcv_max', null, BILLED_GCV.max, 'kcal/Sm3', true,
      `BOTAŞ transmission network operating rules (ŞİD), Annex 1, natural gas quality specification: gross calorific value maximum, m3 at 15 °C and 1.01325 bar (${SID_URL})`,
      'A billed GCV above it is refused (D11; owner decision 2026-11-05)'),
    ...LEAK_RATES.flatMap((r) => [
      parameter('leak_rate', r.subject, r.rate, 'fraction', true,
        `IPCC 2006 Vol. 3 Ch. 7, via ${PACKAGE} §4.6 (${r.label})`, 'Default annual leak rate of the installed capacity (D7)'),
      ...(r.alternative === undefined ? [] : [
        parameter('leak_rate', r.subject, r.alternative, 'fraction', false,
          `IPCC 2006 Vol. 3 Ch. 7, via ${PACKAGE} §4.6 (${r.label})`,
          'Alternative annual leak rate a record may choose instead of the default (D7; owner decision 2026-11-05 (4))'),
      ]),
    ]),
  ];

  return {
    release: {
      publisher: 'IPCC',
      title: 'IPCC 2006 Guidelines for National Greenhouse Gas Inventories (Vol. 2 Energy, Vol. 3 Ch. 7) with AR6 GWPs, as sealed in the TonyAI TR factor package',
      edition: EDITION,
      ordinal: 1,
      status: 'authoritative',
      sourceUrl: 'https://www.ipcc-nggip.iges.or.jp/public/2006gl/vol2.html',
      licence: 'IPCC public domain (publicly available international standard)',
      publishedAt: SEALED_ON,
      gwpSet: 'AR6',
      reviewedBy: REVIEWED_BY,
      reviewedAt: SEALED_ON,
      notes: `Built by packages/db/factor-releases/tr-2026-11/build.mjs from ${PACKAGE}, sealed ${SEALED_ON}, and the owner's decisions of 2026-11-05. publishedAt is the package's seal date. The billed GCV bounds come from BOTAŞ's ŞİD Annex 1.`,
    },
    factors,
    conversions,
    parameters,
  };
}

function etkbRelease() {
  return {
    release: {
      publisher: 'ETKB',
      title: 'Türkiye electricity generation and consumption-point emission factors information form (ETKB EVCED), as sealed in the TonyAI TR factor package',
      edition: EDITION,
      ordinal: 1,
      status: 'authoritative',
      sourceUrl: 'https://enerji.gov.tr/evced-cevre-ve-iklim-elektrik-uretim-tuketim-emisyon-faktorleri',
      licence: 'Official public data of the Republic of Türkiye',
      publishedAt: SEALED_ON,
      gwpSet: 'AR6',
      reviewedBy: REVIEWED_BY,
      reviewedAt: SEALED_ON,
      notes: `Built by packages/db/factor-releases/tr-2026-11/build.mjs from ${PACKAGE}, sealed ${SEALED_ON}, and the owner's decisions of 2026-11-05 (ETKB data years, D07). publishedAt is the package's seal date.`,
    },
    factors: GRID.map((g) => ({
      category: 'Electricity', activityType: 'grid_electricity', gas: 'CO2e', gasCoverage: 'all_ghg', geographyCode: 'TR',
      reportingYear: g.reportingYear, dataYear: g.dataYear, scope: 2, factorValue: g.value, factorUnit: factorUnitFor('kWh'),
      normalizedUnit: 'kWh', calorificBasis: 'not_applicable', scope2Method: 'location',
      methodology: g.dataYear === g.reportingYear
        ? `Location-based national grid factor, data year ${g.dataYear}`
        : `Location-based national grid factor; reporting year ${g.reportingYear} uses the ETKB value of data year ${g.dataYear}, the latest published (D07)`,
      source: `ETKB EVCED Türkiye electricity consumption-point emission factor, via ${PACKAGE} §2, §4.5`,
    })),
    conversions: [],
    parameters: [],
  };
}

export function buildTrReleases() {
  return { ipcc: ipccRelease(), etkb: etkbRelease() };
}

const here = dirname(fileURLToPath(import.meta.url));
export const RELEASE_FILES = { ipcc: join(here, 'ipcc.json'), etkb: join(here, 'etkb.json') };

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  const releases = buildTrReleases();
  for (const [name, path] of Object.entries(RELEASE_FILES)) {
    writeFileSync(path, `${JSON.stringify(releases[name], null, 2)}\n`);
    console.log(`wrote ${path}`);
  }
}
