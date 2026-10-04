import 'dotenv/config';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  Prisma,
  PrismaClient,
  UserRole,
  SubsidiaryStatus,
  TrackingGranularity,
  ActivityRecordStatus,
} from '../generated/client';
import {
  ANOMALY_BASELINE_PERIODS,
  ANOMALY_THRESHOLD,
  COUNTED_STATUSES,
  CALCULATION_GAS,
  MONTH_NAMES,
  factorActivityTypeFor,
  resolveFactorPath,
  scope2MethodFor,
  yearPolicyOf,
  type FactorReleaseSnapshot,
  type FactorStatus,
} from '@tonyai/shared-types';
import {
  DEMO_YEAR,
  PRIOR_YEAR,
  SEED_CONVERSIONS,
  SEED_FACTORS,
  SEED_RELEASES,
} from './factor-library';
import { assertLocalSeedTarget, seedActivityType } from './seed-guards';

/** The status every activity record the seed writes is created with. Read by
 *  `findOrCreateRecord` AND by the rolling-baseline guard below, so the two
 *  cannot disagree about whether a seeded row seeds a baseline. */
const SEED_RECORD_STATUS = ActivityRecordStatus.approved;

/** The average of a window, or null unless it is full — one definition for
 *  both loops, so the site series cannot drift from the company series. */
function rollingBaseline(priors: number[]): number | null {
  return priors.length === ANOMALY_BASELINE_PERIODS
    ? priors.reduce((sum, v) => sum + v, 0) / priors.length
    : null;
}

// The seed writes organisations, profiles, grants and reference data, which
// only the OWNER may (LP1-03): DIRECT_URL. DATABASE_URL is the least-privileged
// runtime role wherever the two differ; CI's supabase-stack sets both to the
// owner, so the fallback keeps that path unchanged.
const SEED_DATABASE_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;

assertLocalSeedTarget(SEED_DATABASE_URL, 'DIRECT_URL / DATABASE_URL');

const prisma = new PrismaClient({ datasourceUrl: SEED_DATABASE_URL });

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
// The demo auth users (with their documented password) and buckets go to this
// project: local only, like the database.
assertLocalSeedTarget(SUPABASE_URL, 'SUPABASE_URL');
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to seed auth users. Copy packages/db/.env.example to .env.');
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ORG_ID = '11111111-1111-1111-1111-111111111111';

// Demo contacts. Email uses the RFC 2606 reserved `example.com` domain, which
// can never resolve.
//
// Phones are harder to be honest about, so: the UK numbers use Ofcom's reserved
// drama range (+44 7700 900xxx), which genuinely cannot connect. BTK and
// BNetzA publish no equivalent, and `+90 555 …` is a LIVE Turkcell prefix — an
// earlier draft of this seed used one, which would have let a UAT tester tap a
// demo contact and reach a stranger. The TR and DE numbers are therefore one
// digit short of a valid subscriber number, so they cannot route either — with
// one caveat worth stating rather than glossing: German subscriber numbers are
// variable-length and Berlin (+49 30) has legitimate short ones, so the DE
// number uses an all-zero subscriber block instead, which is not allocated.
// Before WP16 every row carried the literal string "Seed Admin" as its
// designated person — a placeholder that read like data, which is exactly what
// CLAUDE.md forbids.
//
// NOTE: the upsert below is create-only (`update: {}`), so an existing database
// keeps its NULL contacts until `pnpm db:reset`. That is the seed's long-
// standing idempotency contract and this change does not alter it.
const SUBSIDIARIES = [
  { id: '22222222-2222-2222-2222-222222220001', designatedPerson: 'Aylin Demir', contactEmail: 'aylin.demir@example.com', contactPhone: '+90 555 000 000', legalName: 'TonyAI Energy A.Ş.', tradingName: 'TonyAI Energy', location: 'Istanbul, Turkey', geographyCode: 'TR', sector: 'Energy', businessArea: 'Power Generation', status: SubsidiaryStatus.active, trackingGranularity: TrackingGranularity.location },
  { id: '22222222-2222-2222-2222-222222220002', designatedPerson: 'James Carter', contactEmail: 'james.carter@example.com', contactPhone: '+44 7700 900002', legalName: 'TonyAI Gas Ltd.', tradingName: 'TonyAI Gas', location: 'London, UK', geographyCode: 'UK', sector: 'Utilities', businessArea: 'Gas Distribution', status: SubsidiaryStatus.active },
  { id: '22222222-2222-2222-2222-222222220003', designatedPerson: 'Lena Brandt', contactEmail: 'lena.brandt@example.com', contactPhone: '+49 30 000000', legalName: 'TonyAI Manufacturing GmbH', tradingName: 'TonyAI Mfg', location: 'Munich, Germany', geographyCode: 'EU', sector: 'Manufacturing', businessArea: 'Industrial Production', status: SubsidiaryStatus.active },
  { id: '22222222-2222-2222-2222-222222220004', designatedPerson: 'Murat Aksoy', contactEmail: 'murat.aksoy@example.com', contactPhone: '+90 555 000 004', legalName: 'TonyAI Logistics A.Ş.', tradingName: 'TonyAI Logistics', location: 'Izmir, Turkey', geographyCode: 'TR', sector: 'Transportation', businessArea: 'Freight & Logistics', status: SubsidiaryStatus.pending },
  { id: '22222222-2222-2222-2222-222222220005', designatedPerson: 'Sophie Hall', contactEmail: 'sophie.hall@example.com', contactPhone: '+44 7700 900005', legalName: 'TonyAI Trading Ltd.', tradingName: 'TonyAI Trading', location: 'Manchester, UK', geographyCode: 'UK', sector: 'Wholesale Trade', businessArea: 'Commodity Trading', status: SubsidiaryStatus.inactive },
];

// Operational locations (FR §1.1 third tier). Fixed ids keep the seed
// idempotent; names/addresses are demo values.
// geographyCode defaults to the parent subsidiary's (a location determines the
// factor geography for records attributed to it, data_entry_page.md §5.2).
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
// Emission factors (reference data, not tenant-scoped): the placeholder
// library — releases, factors and the K4 conversion — lives in
// `factor-library.ts`, pure data the parity spec checks against the LP3-03
// migration and the shared contract.
export { DEMO_YEAR, PRIOR_YEAR } from './factor-library';

// ---------------------------------------------------------------------------
// Demo activity records so the Emissions Analytics workspace renders with data.
//
// These are PROTOTYPE values, NOT real operational data — they exist so the
// analytics/trend views are demoable out of the box. They reuse the demo
// placeholder factor library (`factor-library.ts`, labelled as prototype), so every
// calculation snapshot carries that same non-authoritative provenance.
//
// Only Scope 1 & 2 categories are seeded (Electricity, Natural Gas, Fuel) —
// the only ones with seeded factors, and exactly the Phase 1 Scope 1 & 2
// boundary. Records are seeded MONTHLY across DEMO_YEAR so the monthly, quarterly
// and yearly trend views all populate. Records are `approved` (committed), so
// they feed the inventory the same way real reviewed data would.
// The canonical vocabulary, from the contract package. This was the LAST
// hand-written copy of the twelve months in the repo, and the only one in a
// file that writes `period_value` directly — bypassing the API's own
// canonicalisation, which is exactly the writer a drifted copy would hurt.
const MONTHS = MONTH_NAMES;

const ACTIVITY_YEAR = DEMO_YEAR;

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

/**
 * The factor a seeded record of `category` — its seed activity type, entered
 * in `unit` — is priced by, through `resolveFactorPath`: the one selection rule
 * the calculation engine applies, so seeded snapshots match runtime output.
 * The seed is a local tool, so placeholders are allowed. No factor → null (the
 * caller skips the series); any other refusal is a defect in the library.
 */
async function resolveFactor(
  category: string,
  geographyCode: string,
  reportingYear: number,
  unit: string,
) {
  const lookup = {
    category,
    activityType: factorActivityTypeFor(category, seedActivityType(category)),
    geographyCode,
    reportingYear,
    release: { status: { not: 'withdrawn' } },
  };
  const [factors, conversions] = await Promise.all([
    prisma.emissionFactor.findMany({
      where: { ...lookup, gas: CALCULATION_GAS, scope2Method: scope2MethodFor(category) },
      include: { release: true },
    }),
    prisma.unitConversion.findMany({ where: lookup, include: { release: true } }),
  ]);
  // The column is CHECK-constrained to FactorStatus; selection ignores any
  // status it does not know in any case.
  const ranked = <T extends { release: { status: string } }>(row: T) => ({
    ...row,
    release: { ...row.release, status: row.release.status as FactorStatus },
  });
  const resolution = resolveFactorPath({
    category,
    inputUnit: unit,
    factors: factors.map(ranked),
    conversions: conversions.map(ranked),
    allowPlaceholders: true,
  });
  if (!resolution.ok) {
    if (resolution.code === 'no_factor') return null;
    throw new Error(`Seed factor library refuses ${category}/${geographyCode}/${reportingYear} in ${unit}: ${resolution.code}`);
  }
  if (resolution.conversion) {
    throw new Error(`Seed series are entered in their factor's own unit; ${category} in ${unit} needs a conversion`);
  }
  return resolution.factor;
}

type ResolvedFactor = NonNullable<Awaited<ReturnType<typeof resolveFactor>>>;

/** The release as a v2 snapshot embeds it (`FactorReleaseSnapshot`). */
function releaseSnapshot(release: ResolvedFactor['release']): FactorReleaseSnapshot {
  return {
    id: release.id,
    publisher: release.publisher,
    title: release.title,
    edition: release.edition,
    ordinal: release.ordinal,
    status: release.status,
    sourceUrl: release.sourceUrl,
    licence: release.licence,
    publishedAt: release.publishedAt ? release.publishedAt.toISOString().slice(0, 10) : null,
    gwpSet: release.gwpSet as FactorReleaseSnapshot['gwpSet'],
  };
}

/**
 * The v2 snapshot's provenance (`CalculationResultV2`), as the engine writes
 * it: where the figure came from, so a screen or report can tell a
 * placeholder from an authoritative number (`isAuthoritativeSnapshot`).
 */
function snapshotProvenance(factor: ResolvedFactor, reportingYear: number) {
  return {
    snapshotSchema: 2 as const,
    activityType: factor.activityType,
    gas: CALCULATION_GAS,
    gasCoverage: factor.gasCoverage,
    calorificBasis: factor.calorificBasis,
    scope2Method: factor.scope2Method,
    dataYear: factor.dataYear,
    yearPolicy: yearPolicyOf(reportingYear, factor.dataYear),
    factorRelease: releaseSnapshot(factor.release),
    conversion: null,
  };
}

/** Throw unless `stored` matches `wanted` on every listed field. */
function assertUnchanged<T extends object>(
  what: string,
  stored: T,
  wanted: Partial<T>,
  fields: readonly (keyof T)[],
): void {
  const drifted = fields.filter((field) => stored[field] !== wanted[field]);
  if (drifted.length > 0) {
    throw new Error(
      `${what} already exists with different ${drifted.join(', ')}. The factor library ` +
        'is append-only: a changed value is a NEW release, never an edit. Reset this ' +
        'database (pnpm db:reset) if the stored row is a stale local copy.',
    );
  }
}

/**
 * Load the placeholder library, insert-if-absent: a release, factor or
 * conversion already present must match the seed exactly, or the seed stops —
 * the tables are append-only, so it can never "update" a value.
 */
async function seedFactorLibrary(): Promise<void> {
  const releaseIds = new Map<string, string>();
  for (const release of SEED_RELEASES) {
    const stored = await prisma.factorRelease.findUnique({
      where: { publisher_edition: { publisher: release.publisher, edition: release.edition } },
    });
    if (stored) {
      assertUnchanged(`Release ${release.publisher} ${release.edition}`, stored, release, ['title', 'ordinal', 'status']);
      releaseIds.set(release.edition, stored.id);
    } else {
      releaseIds.set(release.edition, (await prisma.factorRelease.create({ data: release })).id);
    }
  }
  const releaseIdOf = (edition: string): string => {
    const id = releaseIds.get(edition);
    if (!id) throw new Error(`Seed row names edition ${edition}, which the seed does not declare`);
    return id;
  };

  for (const { edition, ...factor } of SEED_FACTORS) {
    const data = { ...factor, releaseId: releaseIdOf(edition) };
    const stored = await prisma.emissionFactor.findUnique({
      where: {
        identity: {
          releaseId: data.releaseId,
          category: data.category,
          activityType: data.activityType,
          gas: data.gas,
          geographyCode: data.geographyCode,
          reportingYear: data.reportingYear,
          scope2Method: data.scope2Method,
          calorificBasis: data.calorificBasis,
          normalizedUnit: data.normalizedUnit,
        },
      },
    });
    if (stored) {
      assertUnchanged(
        `Factor ${data.category}/${data.activityType}/${data.geographyCode}/${data.reportingYear} (${edition})`,
        stored,
        data,
        ['scope', 'factorValue', 'factorUnit', 'methodology', 'source', 'version', 'gasCoverage', 'dataYear'],
      );
    } else {
      await prisma.emissionFactor.create({ data });
    }
  }

  for (const { edition, ...conversion } of SEED_CONVERSIONS) {
    const data = { ...conversion, releaseId: releaseIdOf(edition) };
    const stored = await prisma.unitConversion.findUnique({
      where: {
        identity: {
          releaseId: data.releaseId,
          category: data.category,
          activityType: data.activityType,
          geographyCode: data.geographyCode,
          reportingYear: data.reportingYear,
          fromUnit: data.fromUnit,
          toUnit: data.toUnit,
          calorificBasis: data.calorificBasis,
        },
      },
    });
    if (stored) {
      assertUnchanged(
        `Conversion ${data.category}/${data.geographyCode}/${data.reportingYear} ${data.fromUnit}→${data.toUnit} (${edition})`,
        stored,
        data,
        ['multiplier', 'referenceConditions', 'basis', 'dataYear'],
      );
    } else {
      await prisma.unitConversion.create({ data });
    }
  }
}

// --- Demo evidence ---------------------------------------------------------
// The seeded records are all evidence-required categories (Electricity, Natural
// Gas, Fuel), so without a linked file they would show as "incomplete" (FR §2.2)
// on the dashboard. We attach one tiny placeholder CSV per record — clearly a
// demo artefact, not a real invoice.
const EVIDENCE_BUCKET = 'evidence';
const DEMO_EVIDENCE_CSV =
  'field,value\nnote,"DEMO placeholder evidence — not a real document"\n';
/** Its content identity (LP1-02), so `storage:reconcile --verify` checks the seed's files too. */
const DEMO_EVIDENCE_SHA256 = createHash('sha256').update(DEMO_EVIDENCE_CSV).digest('hex');

/** Create the private `evidence` bucket if it does not already exist. */
async function ensureEvidenceBucket(): Promise<void> {
  const { error } = await admin.storage.createBucket(EVIDENCE_BUCKET, {
    public: false,
  });
  // "already exists" is fine; anything else is a real failure.
  if (error && !/exist/i.test(error.message)) throw error;
}

/**
 * Create the private `import-sources` bucket if it does not already exist:
 * where an applied bulk import keeps its source file. Declared in
 * `supabase/config.toml` too; this covers a stack started before it was.
 */
async function ensureImportSourcesBucket(): Promise<void> {
  const { error } = await admin.storage.createBucket('import-sources', {
    public: false,
    // Bytes, not a unit string: the Storage API refuses "2MiB" ("use 20MB")
    // — this is the 2 MiB of `BULK_UPLOAD_MAX_SIZE_BYTES` and config.toml.
    fileSizeLimit: 2 * 1024 * 1024,
    allowedMimeTypes: [
      'text/csv',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  });
  if (error && !/exist/i.test(error.message)) throw error;
}

/**
 * Attach one placeholder evidence file to a record, idempotently. A file
 * belongs to the record's subsidiary and reaches the record through a link
 * (WP8 PR7); the seed gives each record its own file. The object key keeps
 * the record id so a re-run finds the same object.
 */
async function ensureSeedEvidence(
  recordId: string,
  uploadedBy: string,
): Promise<boolean> {
  const existing = await prisma.activityRecordEvidence.count({
    where: { activityRecordId: recordId },
  });
  if (existing > 0) {
    // A database seeded before LP1-02: give the seed's OWN file its hash. Only
    // this key, whose bytes the seed itself wrote — never another file's.
    await prisma.evidence.updateMany({
      where: { storagePath: `${recordId}/seed-evidence.csv`, sha256: null },
      data: { sha256: DEMO_EVIDENCE_SHA256 },
    });
    return false;
  }
  const { subsidiaryId } = await prisma.activityRecord.findUniqueOrThrow({
    where: { id: recordId },
    select: { subsidiaryId: true },
  });

  const storagePath = `${recordId}/seed-evidence.csv`;
  const { error } = await admin.storage
    .from(EVIDENCE_BUCKET)
    .upload(storagePath, Buffer.from(DEMO_EVIDENCE_CSV), {
      contentType: 'text/csv',
      upsert: true,
    });
  if (error) throw error;

  await prisma.$transaction(async (tx) => {
    const file = await tx.evidence.create({
      data: {
        subsidiaryId,
        storagePath,
        fileName: 'demo-evidence.csv',
        mimeType: 'text/csv',
        sizeBytes: Buffer.byteLength(DEMO_EVIDENCE_CSV),
        sha256: DEMO_EVIDENCE_SHA256,
        uploadedBy,
      },
    });
    await tx.activityRecordEvidence.create({
      data: {
        activityRecordId: recordId,
        evidenceId: file.id,
        subsidiaryId,
        linkedBy: uploadedBy,
      },
    });
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
  anomalyBaselinePriorCount: number | null;
  anomalyBaselineTCo2e: number | null;
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
    data: {
      ...data,
      // Found above by its slot alone, so a database seeded before LP3-03 keeps
      // its untyped records; a fresh one gets typed ones (the slot-kind rule
      // refuses a mix).
      activityType: seedActivityType(data.category),
      // The snapshot is modelled here as a plain object; Prisma's Json input
      // type is a narrower union that an index signature does not satisfy.
      // Asserted rather than re-typed: the shape is the calc engine's, not the
      // seed's, and widening `SeedRecordInput` to Prisma's type would drag the
      // client's generated types into this file's own contract.
      calculation: data.calculation as Prisma.InputJsonValue,
      status: SEED_RECORD_STATUS,
    },
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
      // Narrowly not `{}`. The upsert is create-only by design — re-seeding
      // must not overwrite anything a UAT tester has edited — but the three
      // contact columns arrived in WP16 PR 2a, AFTER these rows existed, so on
      // every already-seeded database they stayed NULL and `designatedPerson`
      // kept the literal string "Seed Admin". A demo dataset that shows a
      // placeholder where the feature under test should be is worse than no
      // demo data at all, and the alternative was telling everyone to
      // `db:reset` and lose their UAT work.
      //
      // Scoped to exactly those three columns, and only for the five seeded
      // ids, so nothing a tester typed anywhere else is touched.
      // `trackingGranularity` joins the narrow update list for the same reason
      // the contact columns did: WP17 needs at least one subsidiary measured by
      // location for the rule to be visible, and on an already-seeded database
      // every row would otherwise keep the `subsidiary` default and the feature
      // would look unimplemented. A tester who switches Gas or Mfg by hand will
      // see it reset on the next `pnpm db:seed` — the seed's standing contract
      // for these five fixed ids.
      update: {
        designatedPerson: s.designatedPerson,
        contactEmail: s.contactEmail,
        contactPhone: s.contactPhone,
      },
      create: {
        id: s.id,
        organisationId: ORG_ID,
        legalName: s.legalName,
        tradingName: s.tradingName,
        location: s.location,
        geographyCode: s.geographyCode,
        sector: s.sector,
        businessArea: s.businessArea,
        designatedPerson: s.designatedPerson,
        contactEmail: s.contactEmail,
        contactPhone: s.contactPhone,
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

  // AFTER the locations exist, never before. `location` granularity is only
  // legal for a subsidiary that owns at least one location — the API refuses
  // the switch otherwise — and a seed that died between the two writes would
  // leave a state the product itself cannot create, in which every invoice cell
  // reports N/0 and goes green.
  for (const s of SUBSIDIARIES) {
    if (!s.trackingGranularity) continue;
    await prisma.subsidiary.update({
      where: { id: s.id },
      data: { trackingGranularity: s.trackingGranularity },
    });
  }

  // Sweep any stranded test fixture BEFORE seeding the library. Playwright
  // skips its `globalTeardown` on SIGINT or a crash, so an interrupted E2E run
  // can leave its fixture release behind — and while it sits there its
  // category calculates at a made-up rate instead of being refused, freezing
  // that rate into every snapshot entered against it. Scoped to `fixture`
  // releases, the only rows the append-only triggers let anyone delete.
  const fixtureReleases = await prisma.factorRelease.findMany({
    where: { status: 'fixture' },
    select: { id: true, edition: true },
  });
  if (fixtureReleases.length > 0) {
    const releaseId = { in: fixtureReleases.map((r) => r.id) };
    await prisma.$transaction([
      prisma.emissionFactor.deleteMany({ where: { releaseId } }),
      prisma.unitConversion.deleteMany({ where: { releaseId } }),
      prisma.factorRelease.deleteMany({ where: { id: releaseId } }),
    ]);
    console.log(
      `Removed ${fixtureReleases.length} stranded test-fixture release(s) ` +
        `(${fixtureReleases.map((r) => r.edition).join(', ')}) left by an interrupted E2E run.`,
    );
  }

  console.log('Seeding the placeholder factor library (reference data, insert-if-absent)...');
  await seedFactorLibrary();

  console.log('Seeding auth users + profiles...');
  const adminId = await ensureAuthUser('admin@tonyai.local', 'TonyAI!2026', 'Tony Admin');
  const entryId = await ensureAuthUser('entry@tonyai.local', 'TonyAI!2026', 'Eda Entry');
  const reviewId = await ensureAuthUser('review@tonyai.local', 'TonyAI!2026', 'Cem Consultant');
  // A second super_admin, because the approver may not be the record's
  // creator (decision D01, 2026-09-29): with one super_admin, nothing that
  // super_admin entered could ever be approved. The e2e suite and the UAT
  // catalogue approve as this user whatever admin@ created.
  const approverId = await ensureAuthUser('approver@tonyai.local', 'TonyAI!2026', 'Arda Approver');

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

  await prisma.profile.upsert({
    where: { id: approverId },
    update: { role: UserRole.super_admin, organisationId: ORG_ID },
    create: { id: approverId, email: 'approver@tonyai.local', fullName: 'Arda Approver', role: UserRole.super_admin, organisationId: ORG_ID },
  });

  // Review-only (decision 2026-07-30): may take records into review and reject
  // them, may NOT enter, edit, submit or approve. Deliberately given NO
  // userSubsidiaryAccess rows — a consultant's visibility comes from the
  // organisation, not from per-subsidiary grants, so seeding grants here would
  // hide a regression in that guard branch behind data that papers over it.
  await prisma.profile.upsert({
    where: { id: reviewId },
    update: { role: UserRole.consultant, organisationId: ORG_ID },
    create: { id: reviewId, email: 'review@tonyai.local', fullName: 'Cem Consultant', role: UserRole.consultant, organisationId: ORG_ID },
  });

  // data_entry user can only access two of the five subsidiaries (tenant isolation demo)
  const accessibleForEntry = [SUBSIDIARIES[0].id, SUBSIDIARIES[3].id];
  for (const subsidiaryId of accessibleForEntry) {
    await prisma.userSubsidiaryAccess.upsert({
      where: { userId_subsidiaryId: { userId: entryId, subsidiaryId } },
      update: {},
      // Same organisation as the profile — the composite keys refuse anything else.
      create: { userId: entryId, subsidiaryId, organisationId: ORG_ID },
    });
  }

  console.log('Seeding demo activity records (prototype data, Scope 1 & 2)...');
  await ensureEvidenceBucket();
  await ensureImportSourcesBucket();
  let activityCount = 0;
  let evidenceCount = 0;

  // A few LOCATION-level records (attributed to a specific location, not just the
  // subsidiary) to exercise the reporting-entity dimension (data_entry_page.md §5.2).
  //
  // The subsidiary and geography are DERIVED from the location rather than
  // restated beside it. Restating them meant a reordering of `LOCATIONS` could
  // write a record whose `locationId` belonged to a different subsidiary than
  // its `subsidiaryId` — which the API's own ownership check refuses — while
  // the skip-set below suppressed the wrong subsidiary's month.
  /**
 * Site-reported series. Since WP18 these are EXCLUSIVE: the company-level loop
 * below skips any month a location already reports, so no (subsidiary, category,
 * month) tuple is written twice.
 *
 * The consequence for anyone writing a fixture: the six tuples this produces —
 * Energy·Electricity and Logistics·Fuel, January through March — have NO
 * company-level record. An E2E helper looking one up by subsidiary+category+
 * period with no `locationId` will not find it and will throw. That is exactly
 * how `rbac-tenant.spec.ts` broke, silently, for ten merged PRs.
 */
const LOCATION_ACTIVITY = [
    { location: LOCATIONS[0], category: 'Electricity', unit: 'kWh', base: 40000 },
    { location: LOCATIONS[5], category: 'Fuel', unit: 'litres', base: 6000 },
  ];
  const LOCATION_YEAR = ACTIVITY_YEAR;
  const LOCATION_PERIOD = 'monthly';
  const LOCATION_MONTHS = ['January', 'February', 'March'];

  // The two paths below describe the same consumption from two directions, and
  // until WP18 they were written independently. Where they met on the same
  // (subsidiary, category, month) the inventory counted that month twice: the
  // uniqueness index keys on `location_id`, so both rows are legal, and every
  // total simply adds them. Measured on this seed: six overlapping pairs, worth
  // 101-270 tCO2e of surplus against a 3,176 tCO2e inventory (3-8.5%),
  // depending on which half you call the duplicate. Nothing in the product
  // could tell you which — the company figure came from a seasonal curve and
  // the site figure from a flat constant, with no modelled relation.
  //
  // So the paths are now derived from one fact. A month a site reports is a
  // month the company-level roll-up does not claim: it is tracked site by site
  // instead. The invoice-coverage grid then reports those months honestly ("3
  // of 24" — one site of two, for three months of twelve), which is what it was
  // built in WP17 to measure. An inventory known to be incomplete is a thing a
  // reviewer can act on; one that is silently double-counted is not.
  //
  // The company figure for those months is WITHDRAWN, not redistributed: the
  // residual it carried (~87.6k kWh/month at Energy, ~6.1k litres/month at
  // Logistics — the consumption of the sites that do NOT report) is deliberately
  // unreported, because inventing a number for it would be worse. The coverage
  // grid is where that shows, and it is the only place it shows.
  //
  // Resolving the site factors BEFORE the company loop is what makes the skip
  // safe. The site loop bails when a factor is missing; suppressing the company
  // month anyway would leave that month with no row at ALL — the inventory
  // quietly losing data while the console printed a reassuring count.
  const siteSpecs: Array<{
    location: (typeof LOCATIONS)[number];
    category: string;
    unit: string;
    base: number;
    subsidiary: (typeof SUBSIDIARIES)[number];
    factor: ResolvedFactor;
  }> = [];
  for (const spec of LOCATION_ACTIVITY) {
    const subsidiary = SUBSIDIARIES.find((s) => s.id === spec.location.subsidiaryId);
    if (!subsidiary) {
      throw new Error(`Seed location "${spec.location.name}" points at an unknown subsidiary`);
    }
    const factor = await resolveFactor(spec.category, subsidiary.geographyCode, LOCATION_YEAR, spec.unit);
    if (!factor) {
      console.warn(
        `  ! no factor for ${spec.category}/${subsidiary.geographyCode}/${LOCATION_YEAR} — ` +
          `${spec.location.name} reports nothing, and its months stay company-level`,
      );
      continue;
    }
    siteSpecs.push({ ...spec, subsidiary, factor });
  }

  // Keyed on the database's own uniqueness tuple with the location column
  // collapsed — which is exactly what this guard means ("the same key, ignoring
  // location"), so it cannot drift away from the constraint it protects
  // (`activity_records_reporting_entity_period_category_key`).
  //
  // Keying it on subsidiary+category+month alone was a trap in two directions.
  // A quarterly site spec would produce `…|Q1`, match nothing in `MONTHS`, and
  // let both rows come back for all three months — silently reopening the very
  // defect this exists to close. A site spec for another YEAR would delete the
  // wrong year's company months.
  const entityPeriodKey = (
    subsidiaryId: string,
    year: number,
    period: string,
    periodValue: string,
    category: string,
  ) => `${subsidiaryId}|${year}|${period}|${periodValue}|${category}`;
  const siteReportedKeys = new Set(
    siteSpecs.flatMap((spec) =>
      LOCATION_MONTHS.map((month) =>
        entityPeriodKey(spec.subsidiary.id, LOCATION_YEAR, LOCATION_PERIOD, month, spec.category),
      ),
    ),
  );
  let yieldedToSiteLevel = 0;
  let siteRecordCount = 0;

  for (const spec of ACTIVITY_SPECS) {
    const subsidiary = SUBSIDIARIES[spec.subsidiaryIndex];
    const factor = await resolveFactor(
      spec.category,
      subsidiary.geographyCode,
      ACTIVITY_YEAR,
      spec.unit,
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

    // What the anomaly verdict on each record was decided against. The seed
    // STAGES its verdicts rather than running the rule (see `isAnomaly`), so it
    // states the provenance the same way — from the series it is building, not
    // by re-deriving VAR §4. A month yielded to the sites below is never pushed,
    // so the window holds the three most recent months this series actually
    // wrote, which is exactly the pool the rule would find.
    const writtenTCo2e: number[] = [];

    for (let month = 0; month < MONTHS.length; month++) {
      // This month belongs to the sites (see the note above the loop).
      if (
        siteReportedKeys.has(
          entityPeriodKey(subsidiary.id, ACTIVITY_YEAR, 'monthly', MONTHS[month], spec.category),
        )
      ) {
        yieldedToSiteLevel++;
        continue;
      }
      const activityValue = monthlyActivity(spec, month);
      const kgCo2e = activityValue * factor.factorValue;
      const tCo2e = kgCo2e / 1000;
      const isAnomaly = spec.anomaly?.month === month;
      const priors = writtenTCo2e.slice(-ANOMALY_BASELINE_PERIODS);
      const baselineTCo2e = rollingBaseline(priors);
      // A staged anomaly on a record the rule could never have evaluated would
      // ship a row no code path can produce: flagged, with the baseline that
      // decided it declared absent. Caught here rather than in a screenshot.
      if (isAnomaly && baselineTCo2e === null) {
        throw new Error(
          `Seed stages an anomaly for ${subsidiary.tradingName}/${spec.category} at ` +
            `${MONTHS[month]}, which has only ${priors.length} prior period(s) — ` +
            `VAR §4.1 needs ${ANOMALY_BASELINE_PERIODS}.`,
        );
      }
      // ...and that the staged flag AGREES with the window it claims. Checking
      // only that a baseline exists let the seed ship a flagged record whose
      // own stored average implies a 5% deviation — a contradiction the screens
      // now render, since they print the average beside the warning.
      if (
        isAnomaly &&
        baselineTCo2e !== null &&
        Math.abs(tCo2e - baselineTCo2e) / baselineTCo2e <= ANOMALY_THRESHOLD
      ) {
        throw new Error(
          `Seed stages an anomaly for ${subsidiary.tradingName}/${spec.category} at ` +
            `${MONTHS[month]} whose value (${tCo2e.toFixed(3)} tCO2e) is within ` +
            `${ANOMALY_THRESHOLD * 100}% of its own baseline (${baselineTCo2e.toFixed(3)}).`,
        );
      }

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
        version: factor.release.edition,
        ...snapshotProvenance(factor, ACTIVITY_YEAR),
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
        anomalyBaselinePriorCount: priors.length,
        anomalyBaselineTCo2e: baselineTCo2e,
        varianceReason: isAnomaly
          ? 'Prototype anomaly: unusually high activity vs seasonal baseline.'
          : null,
      });
      activityCount++;
      // Only a COUNTED record seeds a baseline. The status is set 300 lines
      // away, so this checks the seed's own constant against the shared
      // vocabulary rather than against a repeated literal: flip
      // SEED_RECORD_STATUS to `draft` and this fires, instead of every later
      // record silently claiming a window of rows that seed nothing.
      if (!(COUNTED_STATUSES as readonly string[]).includes(SEED_RECORD_STATUS)) {
        throw new Error(
          `the rolling baseline assumes seeded records are counted, but they are written as "${SEED_RECORD_STATUS}"`,
        );
      }
      writtenTCo2e.push(tCo2e);
      // Evidence-required categories need a linked file to count as complete.
      if (await ensureSeedEvidence(recordId, adminId)) evidenceCount++;
    }
  }

  // The site-level half of the split declared above. A subsidiary+category can
  // still hold both attribution levels across the year — that is the dimension
  // this exercises — but never for the same month. Iterates `siteSpecs`, whose
  // factors are already resolved, so the months skipped above are exactly the
  // months written here.
  for (const spec of siteSpecs) {
    const { factor, subsidiary } = spec;
    const siteWrittenTCo2e: number[] = [];
    for (const periodValue of LOCATION_MONTHS) {
      const activityValue = spec.base;
      const kgCo2e = activityValue * factor.factorValue;
      const calculation = {
        category: spec.category, geographyCode: subsidiary.geographyCode, reportingYear: LOCATION_YEAR,
        scope: factor.scope, inputValue: activityValue, inputUnit: spec.unit,
        normalizedValue: activityValue, normalizedUnit: factor.normalizedUnit, conversionApplied: false,
        kgCo2e, tCo2e: kgCo2e / 1000, factorId: factor.id, factorValue: factor.factorValue,
        factorUnit: factor.factorUnit, methodology: factor.methodology, source: factor.source, version: factor.release.edition,
        ...snapshotProvenance(factor, LOCATION_YEAR),
      };
      const { id: recordId } = await findOrCreateRecord({
        subsidiaryId: subsidiary.id,
        locationId: spec.location.id,
        reportingYear: LOCATION_YEAR,
        reportingPeriod: LOCATION_PERIOD,
        periodValue,
        category: spec.category,
        scope: factor.scope,
        activityValue,
        activityUnit: spec.unit,
        calculation,
        createdBy: adminId,
        anomalyFlag: false,
        // Three months per site (LOCATION_MONTHS) means this series never
        // reaches a full window today: 0, then 1, then 2 priors. That is not a
        // gap in the seed — it is what a site's first quarter genuinely looks
        // like, and the surfaces now say "not evaluated" rather than "clean".
        // The average is DERIVED rather than hardcoded null: a fourth month
        // would otherwise ship a record claiming three priors and no baseline,
        // which is the row the migration's third guard refuses.
        anomalyBaselinePriorCount: siteWrittenTCo2e.slice(-ANOMALY_BASELINE_PERIODS).length,
        anomalyBaselineTCo2e: rollingBaseline(
          siteWrittenTCo2e.slice(-ANOMALY_BASELINE_PERIODS),
        ),
        varianceReason: null,
      });
      activityCount++;
      siteWrittenTCo2e.push(calculation.tCo2e);
      siteRecordCount++;
      if (await ensureSeedEvidence(recordId, adminId)) evidenceCount++;
    }
  }

  console.log(
    `  seeded ${activityCount} monthly activity records (approved, incl. ${siteRecordCount} location-level) + ${evidenceCount} placeholder evidence files.`,
  );
  // Both numbers are COUNTED, not computed from the spec lengths: a hardcoded
  // `specs x months` printed a reassuring total over a hole whenever a factor
  // failed to resolve. And the yielded count is printed rather than left to be
  // inferred, because it no longer matches specs x months — a reader who does
  // not know about the split would take the gap for a seeding failure.
  console.log(
    `  ${yieldedToSiteLevel} company-level months were left to the sites that report them (no month is counted twice).`,
  );

  // --- Targets & intensity denominators (WP5, DEMO) ------------------------
  // Baselines are DECLARED business inputs (demo values, not computed); "current"
  // progress is derived live from the real committed DEMO_YEAR records. Two use
  // a PRIOR_YEAR baseline (so DEMO_YEAR shows real progress); one uses a
  // DEMO_YEAR baseline (so it
  // honestly reads "n/a" — no post-baseline year has data yet). Denominators are
  // demo organisation metrics driving the Intensity toggle (Energy + Mfg have all
  // four; Gas has two; Logistics + Trading have none, so their toggle stays off).
  console.log('Seeding demo targets + intensity denominators...');
  // Baselines are tuned near the real committed emissions (~1000 / ~580 tCO₂e)
  // so progress lands in a meaningful spread (on_track / at_risk), not pinned at
  // 100%. The Gas target uses a DEMO_YEAR baseline → "n/a" (no post-baseline data).
  const DEMO_TARGETS = [
    { subsidiaryId: SUBSIDIARIES[0].id, name: 'Net-zero pathway 2030', basis: 'science_based', scope: 'all', baselineYear: PRIOR_YEAR, baselineTCo2e: 1600, targetYear: 2030, targetTCo2e: 900 },
    { subsidiaryId: SUBSIDIARIES[2].id, name: 'Manufacturing SBTi 1.5°C', basis: 'science_based', scope: 'all', baselineYear: PRIOR_YEAR, baselineTCo2e: 900, targetYear: 2030, targetTCo2e: 350 },
    { subsidiaryId: SUBSIDIARIES[1].id, name: 'Scope 1 reduction plan', basis: 'baseline_reduction', scope: 'scope1', baselineYear: DEMO_YEAR, baselineTCo2e: 700, targetYear: 2030, targetTCo2e: 350 },
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
    { subsidiaryId: SUBSIDIARIES[0].id, year: DEMO_YEAR, metric: 'area', value: 85000, unit: 'm²' },
    { subsidiaryId: SUBSIDIARIES[0].id, year: DEMO_YEAR, metric: 'revenue', value: 320, unit: 'M EUR' },
    { subsidiaryId: SUBSIDIARIES[0].id, year: DEMO_YEAR, metric: 'headcount', value: 1800, unit: 'FTE' },
    { subsidiaryId: SUBSIDIARIES[0].id, year: DEMO_YEAR, metric: 'production_output', value: 950000, unit: 'units' },
    { subsidiaryId: SUBSIDIARIES[2].id, year: DEMO_YEAR, metric: 'area', value: 62000, unit: 'm²' },
    { subsidiaryId: SUBSIDIARIES[2].id, year: DEMO_YEAR, metric: 'revenue', value: 480, unit: 'M EUR' },
    { subsidiaryId: SUBSIDIARIES[2].id, year: DEMO_YEAR, metric: 'headcount', value: 1450, unit: 'FTE' },
    { subsidiaryId: SUBSIDIARIES[2].id, year: DEMO_YEAR, metric: 'production_output', value: 1250000, unit: 'units' },
    { subsidiaryId: SUBSIDIARIES[1].id, year: DEMO_YEAR, metric: 'revenue', value: 210, unit: 'M EUR' },
    { subsidiaryId: SUBSIDIARIES[1].id, year: DEMO_YEAR, metric: 'headcount', value: 720, unit: 'FTE' },
    // Round-1 EM-1: energy sold, for the two energy-sector subsidiaries. The
    // unit is MWh (product owner, 2026-08-13) — the docs never stated one.
    { subsidiaryId: SUBSIDIARIES[0].id, year: DEMO_YEAR, metric: 'sales_output', value: 1250000, unit: 'MWh' },
    { subsidiaryId: SUBSIDIARIES[1].id, year: DEMO_YEAR, metric: 'sales_output', value: 480000, unit: 'MWh' },
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
    `  seeded ${targetCount} new demo targets + ${DEMO_DENOMINATORS.length} intensity denominators (declared demo baselines; progress computed from real ${DEMO_YEAR} data).`,
  );

  console.log('\nSeed complete.');
  console.log('  super_admin -> admin@tonyai.local / TonyAI!2026 (sees all 5 subsidiaries)');
  console.log('  super_admin -> approver@tonyai.local / TonyAI!2026 (a second approver: nobody approves a record they created)');
  console.log('  data_entry  -> entry@tonyai.local / TonyAI!2026 (sees 2 subsidiaries)');
  console.log('  consultant  -> review@tonyai.local / TonyAI!2026 (org-wide read; review/reject only, cannot approve)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
