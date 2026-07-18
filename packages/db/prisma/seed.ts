import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  PrismaClient,
  UserRole,
  SubsidiaryStatus,
  ActivityRecordStatus,
} from '../generated/client';

const prisma = new PrismaClient();

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to seed auth users. Copy packages/db/.env.example to .env.');
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG_ID = '11111111-1111-1111-1111-111111111111';

const SUBSIDIARIES = [
  { id: '22222222-2222-2222-2222-222222220001', legalName: 'TonyAI Energy A.Ş.', tradingName: 'TonyAI Energy', location: 'Istanbul, Turkey', geographyCode: 'TR', sector: 'Energy', businessArea: 'Power Generation', status: SubsidiaryStatus.active },
  { id: '22222222-2222-2222-2222-222222220002', legalName: 'TonyAI Gas Ltd.', tradingName: 'TonyAI Gas', location: 'London, UK', geographyCode: 'UK', sector: 'Utilities', businessArea: 'Gas Distribution', status: SubsidiaryStatus.active },
  { id: '22222222-2222-2222-2222-222222220003', legalName: 'TonyAI Manufacturing GmbH', tradingName: 'TonyAI Mfg', location: 'Munich, Germany', geographyCode: 'EU', sector: 'Manufacturing', businessArea: 'Industrial Production', status: SubsidiaryStatus.active },
  { id: '22222222-2222-2222-2222-222222220004', legalName: 'TonyAI Logistics A.Ş.', tradingName: 'TonyAI Logistics', location: 'Izmir, Turkey', geographyCode: 'TR', sector: 'Transportation', businessArea: 'Freight & Logistics', status: SubsidiaryStatus.pending },
  { id: '22222222-2222-2222-2222-222222220005', legalName: 'TonyAI Trading Ltd.', tradingName: 'TonyAI Trading', location: 'Manchester, UK', geographyCode: 'UK', sector: 'Wholesale Trade', businessArea: 'Commodity Trading', status: SubsidiaryStatus.inactive },
];

// Operational locations (FR §1.1 third tier). Fixed ids keep the seed
// idempotent; names/addresses are demo values.
// geographyCode defaults to the parent subsidiary's (a location determines the
// factor geography for records attributed to it, FR §5.2).
const LOCATIONS = [
  { id: '33333333-3333-3333-3333-333333330001', subsidiaryId: SUBSIDIARIES[0].id, name: 'Istanbul HQ', geographyCode: SUBSIDIARIES[0].geographyCode, address: 'Levent, Istanbul', authorizedPerson: 'Aylin Demir' },
  { id: '33333333-3333-3333-3333-333333330002', subsidiaryId: SUBSIDIARIES[0].id, name: 'Ankara Power Plant', geographyCode: SUBSIDIARIES[0].geographyCode, address: 'Sincan OSB, Ankara', authorizedPerson: 'Murat Aksoy' },
  { id: '33333333-3333-3333-3333-333333330003', subsidiaryId: SUBSIDIARIES[1].id, name: 'London Distribution Centre', geographyCode: SUBSIDIARIES[1].geographyCode, address: 'Canary Wharf, London', authorizedPerson: 'James Carter' },
  { id: '33333333-3333-3333-3333-333333330004', subsidiaryId: SUBSIDIARIES[1].id, name: 'Leeds Depot', geographyCode: SUBSIDIARIES[1].geographyCode, address: 'Holbeck, Leeds', authorizedPerson: 'Sophie Hall' },
  { id: '33333333-3333-3333-3333-333333330005', subsidiaryId: SUBSIDIARIES[2].id, name: 'Munich Factory', geographyCode: SUBSIDIARIES[2].geographyCode, address: 'Werksviertel, Munich', authorizedPerson: 'Lukas Weber' },
  { id: '33333333-3333-3333-3333-333333330006', subsidiaryId: SUBSIDIARIES[3].id, name: 'Izmir Freight Hub', geographyCode: SUBSIDIARIES[3].geographyCode, address: 'Alsancak Port, Izmir', authorizedPerson: 'Deniz Kaya' },
  { id: '33333333-3333-3333-3333-333333330007', subsidiaryId: SUBSIDIARIES[3].id, name: 'Istanbul Transfer Station', geographyCode: SUBSIDIARIES[3].geographyCode, address: 'Tuzla, Istanbul', authorizedPerson: 'Deniz Kaya' },
  { id: '33333333-3333-3333-3333-333333330008', subsidiaryId: SUBSIDIARIES[4].id, name: 'Manchester Office', geographyCode: SUBSIDIARIES[4].geographyCode, address: 'Spinningfields, Manchester', authorizedPerson: 'Oliver Grant' },
];

// ---------------------------------------------------------------------------
// Emission factors (reference data, not tenant-scoped).
//
// Values are sourced from docs/md_docs/calculation_logic.md (§3 Regional
// Emission Factors). Scope 1 = direct combustion, Scope 2 = purchased energy.
// Electricity, natural gas and liquid fuels normalise to a base unit before the
// factor is applied (see the calculation engine's normalize()): electricity and
// natural gas -> kWh, liquid fuels -> litres.
//
// The doc gives a single demo factor set (treated here as reporting year 2024).
// To demonstrate factor VERSIONING we additionally seed a 2023 variant for UK
// electricity, explicitly marked as a demo placeholder — the doc does not give a
// 2023 number, so it must NOT be treated as an authoritative DEFRA 2023 value.
// The `source`/`version` fields carry provenance so a calculation can snapshot
// exactly which factor it used.
const DEMO_SOURCE = 'docs/md_docs/calculation_logic.md §3 (prototype demo factors)';

interface SeedFactor {
  category: string;
  geographyCode: string;
  reportingYear: number;
  scope: number;
  factorValue: number;
  factorUnit: string;
  normalizedUnit: string;
  methodology: string;
  source: string;
  version: string;
}

const EMISSION_FACTORS: SeedFactor[] = [
  // --- Scope 2: purchased electricity (kgCO2e/kWh) — 2024 ---
  { category: 'Electricity', geographyCode: 'UK', reportingYear: 2024, scope: 2, factorValue: 0.2071, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'location-based', source: DEMO_SOURCE, version: '2024.1' },
  { category: 'Electricity', geographyCode: 'TR', reportingYear: 2024, scope: 2, factorValue: 0.4400, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'location-based', source: DEMO_SOURCE, version: '2024.1' },
  { category: 'Electricity', geographyCode: 'EU', reportingYear: 2024, scope: 2, factorValue: 0.2310, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'residual-mix', source: DEMO_SOURCE, version: '2024.1' },

  // --- Scope 2: purchased electricity — 2023 versioning demo (UK) ---
  // Placeholder value (doc gives no 2023 number); present only to prove that
  // (category, geography, year) resolves to a DIFFERENT factor than 2024.
  { category: 'Electricity', geographyCode: 'UK', reportingYear: 2023, scope: 2, factorValue: 0.2123, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'location-based', source: `${DEMO_SOURCE} — 2023 demo placeholder, NOT an authoritative value`, version: '2023.1' },

  // --- Scope 1: natural gas (kgCO2e/kWh) — 2024 ---
  // Geography-agnostic demo factor; seeded per supported geography so a lookup by
  // the reporting entity's geographyCode always resolves.
  { category: 'Natural Gas', geographyCode: 'UK', reportingYear: 2024, scope: 1, factorValue: 0.1829, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'standard-factor', source: DEMO_SOURCE, version: '2024.1' },
  { category: 'Natural Gas', geographyCode: 'TR', reportingYear: 2024, scope: 1, factorValue: 0.1829, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'standard-factor', source: DEMO_SOURCE, version: '2024.1' },
  { category: 'Natural Gas', geographyCode: 'EU', reportingYear: 2024, scope: 1, factorValue: 0.1829, factorUnit: 'kgCO2e/kWh', normalizedUnit: 'kWh', methodology: 'standard-factor', source: DEMO_SOURCE, version: '2024.1' },

  // --- Scope 1: liquid fuels (kgCO2e/litre) — 2024 ---
  // Doc §3.1 gives Diesel 2.6841 and Petrol 2.3111; both fall under the
  // canonical "Fuel" category, differentiated by geography-agnostic demo values.
  // Seeded per geography so a lookup always resolves; Diesel is used as the
  // representative "Fuel" factor here.
  { category: 'Fuel', geographyCode: 'UK', reportingYear: 2024, scope: 1, factorValue: 2.6841, factorUnit: 'kgCO2e/litre', normalizedUnit: 'litres', methodology: 'standard-factor (diesel)', source: DEMO_SOURCE, version: '2024.1' },
  { category: 'Fuel', geographyCode: 'TR', reportingYear: 2024, scope: 1, factorValue: 2.6841, factorUnit: 'kgCO2e/litre', normalizedUnit: 'litres', methodology: 'standard-factor (diesel)', source: DEMO_SOURCE, version: '2024.1' },
  { category: 'Fuel', geographyCode: 'EU', reportingYear: 2024, scope: 1, factorValue: 2.6841, factorUnit: 'kgCO2e/litre', normalizedUnit: 'litres', methodology: 'standard-factor (diesel)', source: DEMO_SOURCE, version: '2024.1' },
];

// ---------------------------------------------------------------------------
// Demo activity records so the Emissions Analytics workspace renders with data.
//
// These are PROTOTYPE values, NOT real operational data — they exist so the
// analytics/trend views are demoable out of the box. They reuse the demo
// emission factors above (already labelled as prototype/DEMO_SOURCE), so every
// calculation snapshot carries that same non-authoritative provenance.
//
// Only Scope 1 & 2 categories are seeded (Electricity, Natural Gas, Fuel) —
// the only ones with seeded factors, and exactly the Phase 1 Scope 1 & 2
// boundary. Records are seeded MONTHLY across 2024 so the monthly, quarterly
// and yearly trend views all populate. Records are `approved` (committed), so
// they feed the inventory the same way real reviewed data would.
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const ACTIVITY_YEAR = 2024;

interface ActivitySpec {
  subsidiaryIndex: number; // index into SUBSIDIARIES
  category: string; // must have a seeded factor for the subsidiary's geography
  unit: string; // base unit matching the factor's normalizedUnit (no conversion)
  baseMonthly: number; // typical monthly activity amount
  amplitude: number; // seasonal swing as a fraction of base (0–1)
  peakMonth: number; // month index (0=Jan) where activity peaks
  anomaly?: { month: number; multiplier: number }; // optional one-off spike
}

// Chosen so both data_entry-visible subsidiaries (index 0 and 3) have data,
// and both scopes are represented (Scope 1: Natural Gas + Fuel, Scope 2:
// Electricity). Gas peaks in winter, fuel/electricity in summer.
const ACTIVITY_SPECS: ActivitySpec[] = [
  { subsidiaryIndex: 0, category: 'Electricity', unit: 'kWh', baseMonthly: 145000, amplitude: 0.12, peakMonth: 6 },
  { subsidiaryIndex: 0, category: 'Natural Gas', unit: 'kWh', baseMonthly: 90000, amplitude: 0.35, peakMonth: 0 },
  { subsidiaryIndex: 1, category: 'Electricity', unit: 'kWh', baseMonthly: 78000, amplitude: 0.1, peakMonth: 7 },
  { subsidiaryIndex: 1, category: 'Natural Gas', unit: 'kWh', baseMonthly: 120000, amplitude: 0.4, peakMonth: 0 },
  { subsidiaryIndex: 1, category: 'Fuel', unit: 'litres', baseMonthly: 8000, amplitude: 0.2, peakMonth: 6 },
  { subsidiaryIndex: 2, category: 'Electricity', unit: 'kWh', baseMonthly: 210000, amplitude: 0.08, peakMonth: 6 },
  { subsidiaryIndex: 3, category: 'Fuel', unit: 'litres', baseMonthly: 15000, amplitude: 0.22, peakMonth: 7, anomaly: { month: 6, multiplier: 2.2 } },
  { subsidiaryIndex: 3, category: 'Electricity', unit: 'kWh', baseMonthly: 52000, amplitude: 0.1, peakMonth: 6 },
];

/** Deterministic seasonal activity value for a given month (0=Jan). */
function monthlyActivity(spec: ActivitySpec, month: number): number {
  const seasonal =
    spec.baseMonthly *
    (1 + spec.amplitude * Math.cos((2 * Math.PI * (month - spec.peakMonth)) / 12));
  const spike =
    spec.anomaly && spec.anomaly.month === month ? spec.anomaly.multiplier : 1;
  return Math.round(seasonal * spike);
}

/** Resolve the latest-version factor for (category, geography, year), mirroring
 * the calc engine's resolution so seeded snapshots match runtime output. */
async function resolveFactor(
  category: string,
  geographyCode: string,
  reportingYear: number,
) {
  return prisma.emissionFactor.findFirst({
    where: { category, geographyCode, reportingYear },
    orderBy: { version: 'desc' },
  });
}

// --- Demo evidence ---------------------------------------------------------
// The seeded records are all evidence-required categories (Electricity, Natural
// Gas, Fuel), so without a linked file they would show as "incomplete" (FR §2.2)
// on the dashboard. We attach one tiny placeholder CSV per record — clearly a
// demo artefact, not a real invoice.
const EVIDENCE_BUCKET = 'evidence';
const DEMO_EVIDENCE_CSV =
  'field,value\nnote,"DEMO placeholder evidence — not a real document"\n';

/** Create the private `evidence` bucket if it does not already exist. */
async function ensureEvidenceBucket(): Promise<void> {
  const { error } = await admin.storage.createBucket(EVIDENCE_BUCKET, {
    public: false,
  });
  // "already exists" is fine; anything else is a real failure.
  if (error && !/exist/i.test(error.message)) throw error;
}

/** Attach one placeholder evidence file to a record, idempotently. */
async function ensureSeedEvidence(
  recordId: string,
  uploadedBy: string,
): Promise<boolean> {
  const existing = await prisma.evidence.count({
    where: { activityRecordId: recordId },
  });
  if (existing > 0) return false;

  const storagePath = `${recordId}/seed-evidence.csv`;
  const { error } = await admin.storage
    .from(EVIDENCE_BUCKET)
    .upload(storagePath, Buffer.from(DEMO_EVIDENCE_CSV), {
      contentType: 'text/csv',
      upsert: true,
    });
  if (error) throw error;

  await prisma.evidence.create({
    data: {
      activityRecordId: recordId,
      storagePath,
      fileName: 'demo-evidence.csv',
      mimeType: 'text/csv',
      sizeBytes: Buffer.byteLength(DEMO_EVIDENCE_CSV),
      uploadedBy,
    },
  });
  return true;
}

interface SeedRecordInput {
  subsidiaryId: string;
  locationId: string | null;
  reportingYear: number;
  reportingPeriod: string;
  periodValue: string;
  category: string;
  scope: number;
  activityValue: number;
  activityUnit: string;
  calculation: Record<string, unknown>;
  createdBy: string;
  anomalyFlag: boolean;
  varianceReason: string | null;
}

/**
 * Idempotent create by the natural reporting-entity key. Uniqueness is enforced
 * by a raw NULLS NOT DISTINCT index (no Prisma compound-unique input), so we
 * find-or-create rather than upsert. `location_id` is part of the key.
 */
async function findOrCreateRecord(
  data: SeedRecordInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.activityRecord.findFirst({
    where: {
      subsidiaryId: data.subsidiaryId,
      locationId: data.locationId,
      reportingYear: data.reportingYear,
      reportingPeriod: data.reportingPeriod,
      periodValue: data.periodValue,
      category: data.category,
    },
  });
  if (existing) return { id: existing.id, created: false };
  const record = await prisma.activityRecord.create({
    data: { ...data, status: ActivityRecordStatus.approved },
  });
  return { id: record.id, created: true };
}

async function ensureAuthUser(email: string, password: string, fullName: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (!error && data.user) return data.user.id;

  if (error && /already|registered|exists/i.test(error.message)) {
    const { data: list, error: listErr } = await admin.auth.admin.listUsers();
    if (listErr) throw listErr;
    const existing = list.users.find((u) => u.email === email);
    if (existing) return existing.id;
  }
  throw error ?? new Error(`Could not create or find user ${email}`);
}

async function main() {
  console.log('Seeding organisation + subsidiaries...');
  await prisma.organisation.upsert({
    where: { id: ORG_ID },
    update: {},
    create: {
      id: ORG_ID,
      legalName: 'TonyAI Holding A.Ş.',
      tradingName: 'TonyAI Holding',
      country: 'Turkey',
      geographyCode: 'TR',
      sector: 'Diversified Holding',
      reportingCurrency: 'EUR',
    },
  });

  for (const s of SUBSIDIARIES) {
    await prisma.subsidiary.upsert({
      where: { id: s.id },
      update: {},
      create: {
        id: s.id,
        organisationId: ORG_ID,
        legalName: s.legalName,
        tradingName: s.tradingName,
        location: s.location,
        geographyCode: s.geographyCode,
        sector: s.sector,
        businessArea: s.businessArea,
        designatedPerson: 'Seed Admin',
        reportingStatus: s.status,
        includedScopes: [1, 2],
      },
    });
  }

  console.log('Seeding operational locations...');
  for (const l of LOCATIONS) {
    await prisma.location.upsert({
      where: { id: l.id },
      update: { geographyCode: l.geographyCode },
      create: l,
    });
  }

  console.log('Seeding emission factors (reference data)...');
  for (const f of EMISSION_FACTORS) {
    await prisma.emissionFactor.upsert({
      where: {
        category_geographyCode_reportingYear_version: {
          category: f.category,
          geographyCode: f.geographyCode,
          reportingYear: f.reportingYear,
          version: f.version,
        },
      },
      update: {
        scope: f.scope,
        factorValue: f.factorValue,
        factorUnit: f.factorUnit,
        normalizedUnit: f.normalizedUnit,
        methodology: f.methodology,
        source: f.source,
      },
      create: f,
    });
  }

  console.log('Seeding auth users + profiles...');
  const adminId = await ensureAuthUser('admin@tonyai.local', 'TonyAI!2026', 'Tony Admin');
  const entryId = await ensureAuthUser('entry@tonyai.local', 'TonyAI!2026', 'Eda Entry');

  await prisma.profile.upsert({
    where: { id: adminId },
    update: { role: UserRole.super_admin, organisationId: ORG_ID },
    create: { id: adminId, email: 'admin@tonyai.local', fullName: 'Tony Admin', role: UserRole.super_admin, organisationId: ORG_ID },
  });

  await prisma.profile.upsert({
    where: { id: entryId },
    update: { role: UserRole.data_entry, organisationId: ORG_ID },
    create: { id: entryId, email: 'entry@tonyai.local', fullName: 'Eda Entry', role: UserRole.data_entry, organisationId: ORG_ID },
  });

  // data_entry user can only access two of the five subsidiaries (tenant isolation demo)
  const accessibleForEntry = [SUBSIDIARIES[0].id, SUBSIDIARIES[3].id];
  for (const subsidiaryId of accessibleForEntry) {
    await prisma.userSubsidiaryAccess.upsert({
      where: { userId_subsidiaryId: { userId: entryId, subsidiaryId } },
      update: {},
      create: { userId: entryId, subsidiaryId },
    });
  }

  console.log('Seeding demo activity records (prototype data, Scope 1 & 2)...');
  await ensureEvidenceBucket();
  let activityCount = 0;
  let evidenceCount = 0;
  for (const spec of ACTIVITY_SPECS) {
    const subsidiary = SUBSIDIARIES[spec.subsidiaryIndex];
    const factor = await resolveFactor(
      spec.category,
      subsidiary.geographyCode,
      ACTIVITY_YEAR,
    );
    if (!factor) {
      console.warn(
        `  ! no factor for ${spec.category}/${subsidiary.geographyCode}/${ACTIVITY_YEAR} — skipping ${subsidiary.tradingName}`,
      );
      continue;
    }
    if (spec.unit !== factor.normalizedUnit) {
      throw new Error(
        `Seed activity unit "${spec.unit}" != factor normalizedUnit "${factor.normalizedUnit}" for ${spec.category}`,
      );
    }

    for (let month = 0; month < MONTHS.length; month++) {
      const activityValue = monthlyActivity(spec, month);
      const kgCo2e = activityValue * factor.factorValue;
      const tCo2e = kgCo2e / 1000;
      const isAnomaly = spec.anomaly?.month === month;

      // Immutable calc snapshot — same shape the calc engine produces at write
      // time (no unit conversion here: activity is already in the base unit).
      const calculation = {
        category: spec.category,
        geographyCode: subsidiary.geographyCode,
        reportingYear: ACTIVITY_YEAR,
        scope: factor.scope,
        inputValue: activityValue,
        inputUnit: spec.unit,
        normalizedValue: activityValue,
        normalizedUnit: factor.normalizedUnit,
        conversionApplied: false,
        kgCo2e,
        tCo2e,
        factorId: factor.id,
        factorValue: factor.factorValue,
        factorUnit: factor.factorUnit,
        methodology: factor.methodology,
        source: factor.source,
        version: factor.version,
      };

      const { id: recordId } = await findOrCreateRecord({
        subsidiaryId: subsidiary.id,
        locationId: null,
        reportingYear: ACTIVITY_YEAR,
        reportingPeriod: 'monthly',
        periodValue: MONTHS[month],
        category: spec.category,
        scope: factor.scope,
        activityValue,
        activityUnit: spec.unit,
        calculation,
        createdBy: adminId,
        anomalyFlag: isAnomaly,
        varianceReason: isAnomaly
          ? 'Prototype anomaly: unusually high activity vs seasonal baseline.'
          : null,
      });
      activityCount++;
      // Evidence-required categories need a linked file to count as complete.
      if (await ensureSeedEvidence(recordId, adminId)) evidenceCount++;
    }
  }

  // A few LOCATION-level records (attributed to a specific location, not just the
  // subsidiary) to exercise the reporting-entity dimension (FR §5.2). Same
  // subsidiary+category can coexist at subsidiary-level and per-location.
  const LOCATION_ACTIVITY = [
    { locationId: LOCATIONS[0].id, subsidiaryId: SUBSIDIARIES[0].id, geographyCode: SUBSIDIARIES[0].geographyCode, category: 'Electricity', unit: 'kWh', base: 40000 },
    { locationId: LOCATIONS[5].id, subsidiaryId: SUBSIDIARIES[3].id, geographyCode: SUBSIDIARIES[3].geographyCode, category: 'Fuel', unit: 'litres', base: 6000 },
  ];
  const LOCATION_MONTHS = ['January', 'February', 'March'];
  for (const spec of LOCATION_ACTIVITY) {
    const factor = await resolveFactor(spec.category, spec.geographyCode, ACTIVITY_YEAR);
    if (!factor) continue;
    for (const periodValue of LOCATION_MONTHS) {
      const activityValue = spec.base;
      const kgCo2e = activityValue * factor.factorValue;
      const calculation = {
        category: spec.category, geographyCode: spec.geographyCode, reportingYear: ACTIVITY_YEAR,
        scope: factor.scope, inputValue: activityValue, inputUnit: spec.unit,
        normalizedValue: activityValue, normalizedUnit: factor.normalizedUnit, conversionApplied: false,
        kgCo2e, tCo2e: kgCo2e / 1000, factorId: factor.id, factorValue: factor.factorValue,
        factorUnit: factor.factorUnit, methodology: factor.methodology, source: factor.source, version: factor.version,
      };
      const { id: recordId } = await findOrCreateRecord({
        subsidiaryId: spec.subsidiaryId,
        locationId: spec.locationId,
        reportingYear: ACTIVITY_YEAR,
        reportingPeriod: 'monthly',
        periodValue,
        category: spec.category,
        scope: factor.scope,
        activityValue,
        activityUnit: spec.unit,
        calculation,
        createdBy: adminId,
        anomalyFlag: false,
        varianceReason: null,
      });
      activityCount++;
      if (await ensureSeedEvidence(recordId, adminId)) evidenceCount++;
    }
  }

  console.log(
    `  seeded ${activityCount} monthly activity records (approved, incl. ${LOCATION_ACTIVITY.length * LOCATION_MONTHS.length} location-level) + ${evidenceCount} placeholder evidence files.`,
  );

  // --- Targets & intensity denominators (WP5, DEMO) ------------------------
  // Baselines are DECLARED business inputs (demo values, not computed); "current"
  // progress is derived live from the real committed 2024 records. Two targets use
  // a 2023 baseline (so 2024 shows real progress); one uses a 2024 baseline (so it
  // honestly reads "n/a" — no post-baseline year has data yet). Denominators are
  // demo organisation metrics driving the Intensity toggle (Energy + Mfg have all
  // four; Gas has two; Logistics + Trading have none, so their toggle stays off).
  console.log('Seeding demo targets + intensity denominators...');
  // Baselines are tuned near the real 2024 committed emissions (~1000 / ~580 tCO₂e)
  // so progress lands in a meaningful spread (on_track / at_risk), not pinned at
  // 100%. The Gas target uses a 2024 baseline → "n/a" (no post-baseline data).
  const DEMO_TARGETS = [
    { subsidiaryId: SUBSIDIARIES[0].id, name: 'Net-zero pathway 2030', basis: 'science_based', scope: 'all', baselineYear: 2023, baselineTCo2e: 1600, targetYear: 2030, targetTCo2e: 900 },
    { subsidiaryId: SUBSIDIARIES[2].id, name: 'Manufacturing SBTi 1.5°C', basis: 'science_based', scope: 'all', baselineYear: 2023, baselineTCo2e: 900, targetYear: 2030, targetTCo2e: 350 },
    { subsidiaryId: SUBSIDIARIES[1].id, name: 'Scope 1 reduction plan', basis: 'baseline_reduction', scope: 'scope1', baselineYear: 2024, baselineTCo2e: 700, targetYear: 2030, targetTCo2e: 350 },
  ];
  let targetCount = 0;
  for (const t of DEMO_TARGETS) {
    const existing = await prisma.target.findFirst({
      where: { subsidiaryId: t.subsidiaryId, name: t.name },
    });
    if (!existing) {
      await prisma.target.create({ data: { ...t, createdBy: adminId } });
      targetCount++;
    }
  }

  const DEMO_DENOMINATORS = [
    { subsidiaryId: SUBSIDIARIES[0].id, year: 2024, metric: 'area', value: 85000, unit: 'm²' },
    { subsidiaryId: SUBSIDIARIES[0].id, year: 2024, metric: 'revenue', value: 320, unit: 'M EUR' },
    { subsidiaryId: SUBSIDIARIES[0].id, year: 2024, metric: 'headcount', value: 1800, unit: 'FTE' },
    { subsidiaryId: SUBSIDIARIES[0].id, year: 2024, metric: 'production_output', value: 950000, unit: 'units' },
    { subsidiaryId: SUBSIDIARIES[2].id, year: 2024, metric: 'area', value: 62000, unit: 'm²' },
    { subsidiaryId: SUBSIDIARIES[2].id, year: 2024, metric: 'revenue', value: 480, unit: 'M EUR' },
    { subsidiaryId: SUBSIDIARIES[2].id, year: 2024, metric: 'headcount', value: 1450, unit: 'FTE' },
    { subsidiaryId: SUBSIDIARIES[2].id, year: 2024, metric: 'production_output', value: 1250000, unit: 'units' },
    { subsidiaryId: SUBSIDIARIES[1].id, year: 2024, metric: 'revenue', value: 210, unit: 'M EUR' },
    { subsidiaryId: SUBSIDIARIES[1].id, year: 2024, metric: 'headcount', value: 720, unit: 'FTE' },
  ];
  for (const d of DEMO_DENOMINATORS) {
    await prisma.subsidiaryDenominator.upsert({
      where: {
        subsidiaryId_year_metric: {
          subsidiaryId: d.subsidiaryId,
          year: d.year,
          metric: d.metric,
        },
      },
      update: { value: d.value, unit: d.unit },
      create: { ...d, createdBy: adminId },
    });
  }
  console.log(
    `  seeded ${targetCount} new demo targets + ${DEMO_DENOMINATORS.length} intensity denominators (declared demo baselines; progress computed from real 2024 data).`,
  );

  console.log('\nSeed complete.');
  console.log('  super_admin -> admin@tonyai.local / TonyAI!2026 (sees all 5 subsidiaries)');
  console.log('  data_entry  -> entry@tonyai.local / TonyAI!2026 (sees 2 subsidiaries)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
