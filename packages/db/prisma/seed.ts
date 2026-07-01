import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient, UserRole, SubsidiaryStatus } from '../generated/client';

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
