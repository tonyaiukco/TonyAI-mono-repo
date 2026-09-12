import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export const PASSWORD = 'TonyAI!2026';
export const ADMIN_EMAIL = 'admin@tonyai.local';
export const ENTRY_EMAIL = 'entry@tonyai.local';
/** Review-only: org-wide read, may review and reject, may NOT approve. Seeded
 * with no per-subsidiary access rows on purpose — a consultant's visibility
 * comes from the organisation, so granting rows here would hide a regression in
 * that guard branch. */
export const CONSULTANT_EMAIL = 'review@tonyai.local';

// NestJS API (versioned prefix). Absolute so it ignores the page baseURL.
export const API_BASE = 'http://localhost:3001/api/v1';

/**
 * Seeded subsidiaries (stable UUIDs from packages/db seed). `entryCan` marks the
 * two the data_entry user has explicit access to (Energy + Logistics).
 */
export const SUB = {
  energy: '22222222-2222-2222-2222-222222220001', // TonyAI Energy · TR · entry-accessible
  gas: '22222222-2222-2222-2222-222222220002', // TonyAI Gas · UK
  mfg: '22222222-2222-2222-2222-222222220003', // TonyAI Mfg · EU
  logistics: '22222222-2222-2222-2222-222222220004', // TonyAI Logistics · TR · entry-accessible
  trading: '22222222-2222-2222-2222-222222220005', // TonyAI Trading · UK
} as const;

/** A subsidiary the data_entry user CANNOT access — used by cross-tenant probes. */
/** A subsidiary OUTSIDE `entry@tonyai.local`'s access set. The seed has a
 * single organisation, so this proves access-set isolation, not cross-ORG
 * isolation — a second seeded org would be needed for that. */
export const OUT_OF_SCOPE_SUB = SUB.mfg;

/**
 * The seed is monthly-only in E2E_YEAR, so the whole `quarterly` space is unseeded.
 * Every E2E write lives there (distinct subsidiary per test → no tuple/baseline
 * collisions) and the teardown wipes all quarterly rows — the seed is untouched.
 */
// Must track the seed's DEMO_YEAR: the invariant is "the seed is monthly-only in
// this year, so the whole quarterly space is ours". Point it at a different year
// and the teardown stops reclaiming what the specs write.
export const E2E_YEAR = 2026;
export const E2E_PERIOD = 'quarterly';

// --- Login (UI) -------------------------------------------------------------

/**
 * Logs in via the real Supabase-backed login form and waits to land on the
 * dashboard (middleware redirects unauthenticated users to /login).
 */
/**
 * Switch to another user mid-test. Goes through the app's own Sign out rather
 * than clearing storage: an active session makes `/login` redirect straight to
 * the dashboard, so `login()` alone would silently keep the previous user.
 */
export async function switchUser(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/login');
  await login(page, email);
}

export async function login(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // After sign-in the app routes to "/" (Carbon Dashboard).
  await expect(page.getByRole('heading', { name: 'Carbon Dashboard' })).toBeVisible();
}

/** Rows in the live "Subsidiary register" table on /subsidiaries (excludes header). */
export function subsidiaryRows(page: Page) {
  return page.locator('table tbody tr');
}

/**
 * Pick an option from a shadcn/Radix `Select` identified by its field's exact
 * Label text (e.g. "Value", "Subsidiary"). Field-scoped so it survives the async
 * skeleton and select ordering, and — unlike matching the trigger's accessible
 * name — it isn't affected by how Radix composes the trigger's name. Waits for
 * the listbox to close so the overlay can't swallow the next interaction.
 */
/**
 * NOTE: this resolves the field by an EXACT label match, so it breaks with a
 * strict-mode violation when two fields share a label — on `/data-entry` both
 * "Activity data" and "Additional context" have a `Unit`. For those, address the
 * control by the option it currently displays instead.
 */
export async function pickByFieldLabel(page: Page, fieldLabel: string, optionName: string): Promise<void> {
  const field = page.locator('div.space-y-2', { has: page.getByText(fieldLabel, { exact: true }) });
  await field.getByRole('combobox').click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
  await expect(page.getByRole('option', { name: optionName, exact: true })).toBeHidden();
}

/** Select a subsidiary on /data-entry (the "Subsidiary" field). */
export function selectSubsidiary(page: Page, optionName: string): Promise<void> {
  return pickByFieldLabel(page, 'Subsidiary', optionName);
}

// --- Environment (populated by playwright.config.ts before anything runs) ----

/** Local Supabase URL + anon key, loaded from apps/web/.env.local by the config. */
export function supabaseEnv(): { url: string; anon: string } {
  const url = process.env.E2E_SUPABASE_URL;
  const anon = process.env.E2E_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      'E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY not set — see the env loader in playwright.config.ts.',
    );
  }
  return { url, anon };
}

// --- API tokens + helpers ---------------------------------------------------

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Password-grant a Supabase access token — the same JWT the NestJS guard
 * verifies. The token is never minted or parsed here, so this works under both
 * signing schemes (HS256 shared secret and asymmetric/JWKS). Used both to drive
 * API-only arrange/act steps (approve has no UI) and by the RLS probes.
 */
export async function getAccessToken(
  request: APIRequestContext,
  email: string,
  password = PASSWORD,
): Promise<string> {
  const { url, anon } = supabaseEnv();
  const res = await request.post(`${url}/auth/v1/token?grant_type=password`, {
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    data: { email, password },
  });
  if (!res.ok()) {
    throw new Error(`token grant failed for ${email}: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()).access_token as string;
}

// Shared evidence fixture (a tiny valid PDF; the API checks MIME + size, not content).
export const EVIDENCE_FIXTURE = resolve(__dirname, 'fixtures/sample-invoice.pdf');

interface CommittedRecordInput {
  subsidiaryId: string;
  /** Attribute the record to an operational location instead of the subsidiary
   *  as a whole. Also widens the uniqueness tuple, so a located record cannot
   *  collide with a company-level one for the same category and period. */
  locationId?: string | null;
  category: string;
  periodValue: string;
  activityValue: number;
  activityUnit?: string;
  reportingYear?: number;
  reportingPeriod?: string;
}

/**
 * Arrange a committed (submitted) activity record via the API: create draft →
 * attach evidence (every seeded factor category is evidence-required) → submit.
 * Returns the record id. Used to build anomaly baselines that would be tedious
 * to create through the UI.
 */
export async function createCommittedRecord(
  request: APIRequestContext,
  token: string,
  input: CommittedRecordInput,
): Promise<string> {
  const headers = bearer(token);
  const create = await request.post(`${API_BASE}/activity-records`, {
    headers,
    data: {
      subsidiaryId: input.subsidiaryId,
      locationId: input.locationId ?? null,
      reportingYear: input.reportingYear ?? E2E_YEAR,
      reportingPeriod: input.reportingPeriod ?? E2E_PERIOD,
      periodValue: input.periodValue,
      category: input.category,
      activityValue: input.activityValue,
      activityUnit: input.activityUnit ?? 'kWh',
      varianceReason: null,
      input: null,
    },
  });
  if (!create.ok()) throw new Error(`create failed: ${create.status()} ${await create.text()}`);
  const rec = await create.json();

  const upload = await request.post(`${API_BASE}/activity-records/${rec.id}/evidence`, {
    headers,
    multipart: {
      file: { name: 'sample-invoice.pdf', mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) },
    },
  });
  if (!upload.ok()) throw new Error(`evidence upload failed: ${upload.status()} ${await upload.text()}`);

  const submit = await request.post(`${API_BASE}/activity-records/${rec.id}/submit`, { headers });
  if (!submit.ok()) throw new Error(`submit failed: ${submit.status()} ${await submit.text()}`);
  return rec.id as string;
}

/**
 * Find one activity record by its full reporting-entity tuple (for the API
 * approve step). Includes `locationId` (default `null` = subsidiary-level) so a
 * location-level twin with the same category/period can't be picked by mistake.
 */
export async function findRecordId(
  request: APIRequestContext,
  token: string,
  q: {
    subsidiaryId: string;
    category: string;
    periodValue: string;
    reportingPeriod?: string;
    locationId?: string | null;
  },
): Promise<string> {
  const res = await request.get(`${API_BASE}/activity-records?subsidiaryId=${q.subsidiaryId}`, {
    headers: bearer(token),
  });
  if (!res.ok()) throw new Error(`list failed: ${res.status()} ${await res.text()}`);
  const list = (await res.json()) as Array<Record<string, string | null>>;
  const rec = list.find(
    (r) =>
      r.category === q.category &&
      r.periodValue === q.periodValue &&
      r.reportingPeriod === (q.reportingPeriod ?? E2E_PERIOD) &&
      (r.locationId ?? null) === (q.locationId ?? null),
  );
  if (!rec) throw new Error(`record not found: ${q.subsidiaryId} ${q.category} ${q.periodValue}`);
  return rec.id as string;
}

/** Approve a submitted record (super_admin only; no UI for this). */
export async function approveRecord(request: APIRequestContext, token: string, id: string): Promise<void> {
  const res = await request.post(`${API_BASE}/activity-records/${id}/approve`, { headers: bearer(token) });
  if (!res.ok()) throw new Error(`approve failed: ${res.status()} ${await res.text()}`);
}

/** Lock a reporting period (super_admin). Returns the lock id. */
export async function lockPeriod(
  request: APIRequestContext,
  token: string,
  body: { subsidiaryId: string; reportingYear?: number; reportingPeriod?: string; periodValue: string },
): Promise<string> {
  const res = await request.post(`${API_BASE}/period-locks`, {
    headers: bearer(token),
    data: {
      subsidiaryId: body.subsidiaryId,
      reportingYear: body.reportingYear ?? E2E_YEAR,
      reportingPeriod: body.reportingPeriod ?? E2E_PERIOD,
      periodValue: body.periodValue,
    },
  });
  if (!res.ok()) throw new Error(`lock failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).id as string;
}

// --- Teardown ---------------------------------------------------------------

/**
 * Remove every quarterly row (service-role → bypasses RLS). Since the seed is
 * monthly-only, quarterly rows can only have come from E2E, so this is a safe,
 * seed-preserving reset. Evidence rows cascade on the DB FK; a few orphaned
 * storage objects may remain locally (harmless).
 */
/**
 * A cleanup that fails must SAY so.
 *
 * These ran fire-and-forget, so when `prisma migrate reset` wiped the schema
 * grants every delete came back 403 and the suite carried on as if the database
 * had been reset. The rows it left behind then surfaced as tuple collisions in
 * unrelated specs — a 409 four files away is a very expensive way to learn that
 * teardown is broken.
 */
/** Teardown deletes with the service-role key, so it must never be pointed at a
 *  shared database. `supabaseEnv()` reads whatever the local env files say. */
function assertLocalTarget(url: string): void {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url)) {
    throw new Error(
      `Refusing to run E2E teardown against a non-local Supabase (${url}). ` +
        'These deletes bypass RLS.',
    );
  }
}

/**
 * Delete via PostgREST and RETURN the failure rather than throwing it, so the
 * caller can run every delete before reporting (see `reportCleanup`).
 *
 * The return type said `void` while the body returned `null` or a message. The
 * runtime was right and the annotation was the lie, but it was a lie with teeth:
 * it told every reader that these calls produce nothing, which is an invitation
 * to "simplify" the returns away and silently turn `reportCleanup` into a
 * no-op — a teardown that reports success no matter what it failed to delete.
 * Nothing caught it because `e2e/` was outside every tsconfig until now.
 */
async function del(
  request: APIRequestContext,
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const res = await request.delete(url, { headers });
  if (res.ok()) return null;
  return `${res.status()} on ${url.split('/rest/v1/')[1]} — ${await res.text()}`;
}

/** Run every delete, THEN report. Failing fast on the first one skipped the
 *  rest, which is the leak the check was added to prevent. */
function reportCleanup(errors: (string | null)[]): void {
  const failed = errors.filter(Boolean);
  if (failed.length) throw new Error(`E2E cleanup failed: ${failed.join(' | ')}`);
}

/**
 * Storage paths of the evidence attached to records matching a PostgREST filter
 * on `activity_records` (or, through it, on `subsidiaries`).
 *
 * Collected BEFORE the rows are deleted, because that is the only moment they
 * are knowable: `Evidence.activityRecord` is ON DELETE CASCADE, so the rows go
 * inside Postgres and the object keys go with them. Teardown then used to leave
 * the files behind forever — every run uploads at least one invoice per
 * committed record, and the local bucket had grown to 1501 objects against 102
 * rows before anyone counted.
 */
async function evidencePathsFor(
  request: APIRequestContext,
  /** Full PostgREST query string: the `select` embed AND the filters on it. One
   *  argument rather than two, because the embed and the filter that walks it
   *  have to agree — `activity_records.x=` only works if the select joined it. */
  query: string,
): Promise<string[]> {
  const { url } = supabaseEnv();
  const service = process.env.E2E_SUPABASE_SERVICE_KEY as string;
  const res = await request.get(`${url}/rest/v1/evidence?${query}`, {
    headers: { apikey: service, Authorization: `Bearer ${service}` },
  });
  if (!res.ok()) {
    throw new Error(`E2E cleanup could not list evidence paths: ${res.status()} ${await res.text()}`);
  }
  return ((await res.json()) as { storage_path: string }[]).map((r) => r.storage_path);
}

/**
 * Delete storage objects by key. Returns a failure string in the same shape as
 * `del`, so it can join a `reportCleanup` batch.
 */
async function removeEvidenceObjects(
  request: APIRequestContext,
  paths: string[],
): Promise<string | null> {
  if (paths.length === 0) return null;
  const { url } = supabaseEnv();
  const service = process.env.E2E_SUPABASE_SERVICE_KEY as string;
  const res = await request.delete(`${url}/storage/v1/object/evidence`, {
    headers: {
      apikey: service,
      Authorization: `Bearer ${service}`,
      'Content-Type': 'application/json',
    },
    data: { prefixes: paths },
  });
  if (res.ok()) return null;
  return `${res.status()} removing ${paths.length} evidence object(s) — ${await res.text()}`;
}

export async function cleanupQuarterly(request: APIRequestContext): Promise<void> {
  const { url } = supabaseEnv();
  assertLocalTarget(url);
  const service = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!service) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  const headers = { apikey: service, Authorization: `Bearer ${service}`, Prefer: 'return=minimal' };
  // Locks first (independent), then records (evidence cascades in the DB).
  // Scoped by YEAR as well as period. Filtering on period alone was survivable
  // while the UI offered two years; DE-9 opened it to twelve, so an unscoped
  // wipe would destroy a UAT tester's quarterly data in any of them — with the
  // service-role key, which bypasses RLS and therefore every tenant boundary.
  const scope = `reporting_period=eq.${E2E_PERIOD}&reporting_year=eq.${E2E_YEAR}`;
  // Files BEFORE rows: the evidence rows cascade away with the records, taking
  // the object keys with them, so this is the last moment they can be read.
  const paths = await evidencePathsFor(
    request,
    'select=storage_path,activity_records!inner(id)' +
      `&activity_records.reporting_period=eq.${E2E_PERIOD}` +
      `&activity_records.reporting_year=eq.${E2E_YEAR}`,
  );
  reportCleanup([
    await removeEvidenceObjects(request, paths),
    await del(request, `${url}/rest/v1/period_locks?${scope}`, headers),
    await del(request, `${url}/rest/v1/activity_records?${scope}`, headers),
  ]);
}

/**
 * Remove subsidiaries created by a previous run.
 *
 * `smoke.spec.ts` creates one, edits it and deletes it — and PR 4 widened that
 * window (create → edit → geography confirmation → cancel → save → delete), so
 * an abort now strands a row more often. Nothing else reclaimed them, and a
 * single leftover breaks every spec that asserts an absolute subsidiary count
 * (observed: two failures in `smoke.spec.ts` and two in `targets.spec.ts` from
 * one stray row). The `E2E Test Co` prefix is the sentinel; the seed's five
 * legal names cannot match it.
 */
export async function cleanupE2ESubsidiaries(request: APIRequestContext): Promise<void> {
  const { url } = supabaseEnv();
  assertLocalTarget(url);
  const service = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!service) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  const headers = { apikey: service, Authorization: `Bearer ${service}`, Prefer: 'return=minimal' };
  // Same rule as cleanupQuarterly: the subsidiary delete cascades all the way
  // down to evidence rows, so the files have to be reclaimed while their keys
  // are still readable. Not covered by the quarterly sweep — a spec is free to
  // put an E2E subsidiary's record in any period.
  const paths = await evidencePathsFor(
    request,
    'select=storage_path,activity_records!inner(subsidiaries!inner(id))' +
      '&activity_records.subsidiaries.legal_name=like.E2E%20Test%20Co*',
  );
  reportCleanup([
    await removeEvidenceObjects(request, paths),
    await del(request, `${url}/rest/v1/subsidiaries?legal_name=like.E2E%20Test%20Co*`, headers),
  ]);
}

/**
 * Remove locations left by a previous run.
 *
 * Subsidiaries and targets had sentinels; locations had none, so a run that died
 * between creating one and its `finally` stranded it permanently — surviving
 * re-seeds, shifting the location count the UAT testers see, and invisible to
 * every spec, since nothing asserts an absolute location total.
 */
export async function cleanupE2ELocations(request: APIRequestContext): Promise<void> {
  const { url } = supabaseEnv();
  assertLocalTarget(url);
  const service = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!service) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  const headers = { apikey: service, Authorization: `Bearer ${service}`, Prefer: 'return=minimal' };
  reportCleanup([
    await del(request, `${url}/rest/v1/locations?name=like.E2E%20*`, headers),
  ]);
}

/**
 * Targets/denominators aren't period-scoped, so the quarterly wipe can't reach
 * them. E2E rows use the `E2E-` name/unit sentinel; this deletes exactly those
 * (service-role), leaving the seed's demo targets/denominators intact.
 */
export async function cleanupE2ETargets(request: APIRequestContext): Promise<void> {
  const { url } = supabaseEnv();
  assertLocalTarget(url);
  const service = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!service) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  const headers = { apikey: service, Authorization: `Bearer ${service}`, Prefer: 'return=minimal' };
  reportCleanup([
    await del(request, `${url}/rest/v1/targets?name=like.E2E-*`, headers),
    await del(request, `${url}/rest/v1/subsidiary_denominators?unit=like.E2E-*`, headers),
  ]);
}

/**
 * Back-date a record's `created_at` without touching `submitted_at`.
 *
 * The two fields are seconds apart for anything a test creates, so the Waiting
 * column reads the same whichever one it counts from — which means an
 * assertion on a freshly submitted record cannot tell a correct implementation
 * from one that quietly fell back to `created_at`. Pulling `created_at` a month
 * into the past manufactures the January-draft/June-submit case the column
 * exists for, and makes the two answers differ by 30 days.
 *
 * Service-role and direct to PostgREST on purpose: the API has no endpoint for
 * this, and it must not grow one — a client that can set its own timestamps can
 * forge a submission time.
 */
export async function backdateCreatedAt(
  request: APIRequestContext,
  recordId: string,
  days: number,
): Promise<void> {
  const { url } = supabaseEnv();
  assertLocalTarget(url);
  const service = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!service) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  const when = new Date(Date.now() - days * 86_400_000).toISOString();
  const res = await request.patch(`${url}/rest/v1/activity_records?id=eq.${recordId}`, {
    headers: {
      apikey: service,
      Authorization: `Bearer ${service}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    data: { created_at: when },
  });
  if (!res.ok()) {
    throw new Error(`backdateCreatedAt failed: ${res.status()} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// WP8 — bulk upload and bulk submit
// ---------------------------------------------------------------------------

/**
 * The category a bulk-submit E2E can actually use, and why it needs a fixture.
 *
 * Every category the seeded factor library covers — Electricity, Natural Gas,
 * Fuel — is evidence-required, and so is Water, the one factorless category the
 * calc engine will record. So on a seeded database the set of rows that can be
 * IMPORTED and the set that can be BULK-SUBMITTED are disjoint, and the panel's
 * submit button never renders. `seedE2EFactor` opens a lane: one factor row for
 * a non-evidence category, labelled unmistakably as a fixture.
 */
export const E2E_BULK_CATEGORY = 'Waste';
export const E2E_BULK_UNIT = 'tonnes';

/**
 * The version string, chosen so it can never shadow a real factor.
 *
 * `findFactor` orders by `version DESC` and takes the first row, so a version
 * that sorts ABOVE a real one (`E2E-…` beats `2026.1` lexically) would silently
 * take precedence the day someone seeds a genuine Waste factor. Leading zeroes
 * put this below every plausible real version instead: the fixture applies only
 * while nothing real exists, which is exactly its remit.
 */
export const E2E_FACTOR_VERSION = '0000-E2E-FIXTURE';

/**
 * A factor row for a non-evidence category, so a bulk submit has something to
 * submit.
 *
 * **This is not an emission factor.** Its value is arithmetically convenient
 * and cites no source, and every field says so — `source`, `methodology` and
 * `version` all name it as a test fixture. CLAUDE.md forbids inventing factor
 * values precisely because a number that looks authoritative becomes one; the
 * defence here is not the number but the labelling, plus a version that cannot
 * outrank a sourced factor and a teardown that removes it.
 */
export async function seedE2EFactor(request: APIRequestContext): Promise<void> {
  const { url } = supabaseEnv();
  assertLocalTarget(url);
  const service = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!service) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  const rows = ['TR', 'UK', 'EU'].map((geographyCode) => ({
    id: randomUUID(),
    category: E2E_BULK_CATEGORY,
    geography_code: geographyCode,
    reporting_year: E2E_YEAR,
    scope: 3,
    factor_value: 1,
    factor_unit: `kgCO2e/${E2E_BULK_UNIT}`,
    normalized_unit: E2E_BULK_UNIT,
    methodology: 'E2E fixture — not a methodology',
    source: 'E2E FIXTURE — not a real emission factor, not for reporting',
    version: E2E_FACTOR_VERSION,
  }));
  const res = await request.post(`${url}/rest/v1/emission_factors`, {
    headers: {
      apikey: service,
      Authorization: `Bearer ${service}`,
      'Content-Type': 'application/json',
      // Idempotent: a previous run that died before teardown must not make the
      // next one fail on the (category, geography, year, version) unique index.
      Prefer: 'return=minimal,resolution=merge-duplicates',
    },
    data: rows,
  });
  if (!res.ok()) {
    throw new Error(`seedE2EFactor failed: ${res.status()} ${await res.text()}`);
  }
}

/** Remove the fixture factor. Keyed on the version sentinel, like the others. */
export async function cleanupE2EFactors(request: APIRequestContext): Promise<void> {
  const { url } = supabaseEnv();
  assertLocalTarget(url);
  const service = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!service) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  const headers = { apikey: service, Authorization: `Bearer ${service}`, Prefer: 'return=minimal' };
  reportCleanup([
    await del(
      request,
      `${url}/rest/v1/emission_factors?version=eq.${encodeURIComponent(E2E_FACTOR_VERSION)}`,
      headers,
    ),
  ]);
}

/** One row of a bulk-upload file, in the importer's own column order. */
export interface BulkRow {
  subsidiaryId: string;
  locationId?: string;
  reportingYear?: number;
  reportingPeriod?: string;
  periodValue: string;
  category?: string;
  activityValue: number | string;
  activityUnit?: string;
  varianceReason?: string;
}

/**
 * Build a CSV body in the spec rather than committing a fixture file.
 *
 * The rows have to carry live seed UUIDs and a period value the running spec
 * owns — both of which are constants in this file. A committed `.csv` would
 * hard-code one subsidiary and drift the first time the lanes move.
 */
export function buildBulkCsv(rows: BulkRow[]): Buffer {
  const header =
    'subsidiaryId,locationId,reportingYear,reportingPeriod,periodValue,category,activityValue,activityUnit,varianceReason';
  const lines = rows.map((r) =>
    [
      r.subsidiaryId,
      r.locationId ?? '',
      String(r.reportingYear ?? E2E_YEAR),
      r.reportingPeriod ?? E2E_PERIOD,
      r.periodValue,
      r.category ?? E2E_BULK_CATEGORY,
      String(r.activityValue),
      r.activityUnit ?? E2E_BULK_UNIT,
      r.varianceReason ?? '',
    ].join(','),
  );
  return Buffer.from([header, ...lines].join('\n'), 'utf8');
}

/**
 * Post a bulk import.
 *
 * `fieldName` is a parameter for one reason: the multipart field name is closed
 * over inside the class `FileInterceptor('file', …)` generates, so no unit test
 * can vary it and no browser can either — the web client always sends `file`.
 * Posting it as anything else is a property only this layer can check.
 */
export async function postBulkImport(
  request: APIRequestContext,
  token: string,
  opts: {
    buffer: Buffer;
    fileName?: string;
    mimeType?: string;
    dryRun: 'true' | 'false';
    fieldName?: string;
  },
) {
  return request.post(`${API_BASE}/bulk-upload/activity-records`, {
    headers: bearer(token),
    multipart: {
      [opts.fieldName ?? 'file']: {
        name: opts.fileName ?? 'bulk.csv',
        mimeType: opts.mimeType ?? 'text/csv',
        buffer: opts.buffer,
      },
      dryRun: opts.dryRun,
    },
  });
}

/** Attach the sample invoice to a record — the middle step of a committed record. */
export async function attachEvidence(
  request: APIRequestContext,
  token: string,
  recordId: string,
): Promise<void> {
  const res = await request.post(`${API_BASE}/activity-records/${recordId}/evidence`, {
    headers: bearer(token),
    multipart: {
      file: {
        name: 'sample-invoice.pdf',
        mimeType: 'application/pdf',
        buffer: readFileSync(EVIDENCE_FIXTURE),
      },
    },
  });
  if (!res.ok()) {
    throw new Error(`attachEvidence failed: ${res.status()} ${await res.text()}`);
  }
}

/**
 * Audit rows written since a timestamp.
 *
 * The per-record rows are invisible to the unit suite — the bulk services mock
 * the record service wholesale — so "every mutation writes an audit row", which
 * CLAUDE.md calls non-negotiable, is only checkable here.
 */
export async function readAuditSince(
  request: APIRequestContext,
  token: string,
  filter: { entity?: string; action?: string; since: string },
): Promise<{ entityId: string | null; action: string; diff: Record<string, unknown> }[]> {
  const search = new URLSearchParams({ limit: '200' });
  if (filter.entity) search.set('entity', filter.entity);
  if (filter.action) search.set('action', filter.action);
  const res = await request.get(`${API_BASE}/audit?${search.toString()}`, {
    headers: bearer(token),
  });
  if (!res.ok()) throw new Error(`readAuditSince failed: ${res.status()}`);
  const body = await res.json();
  const rows = (body.rows ?? body) as {
    createdAt: string;
    entityId: string | null;
    action: string;
    diff: Record<string, unknown>;
  }[];
  return rows.filter((r) => r.createdAt >= filter.since);
}

/** Read activity_records straight from PostgREST, past the API's own gates. */
export async function serviceReadRecords(
  request: APIRequestContext,
  query: string,
): Promise<Record<string, unknown>[]> {
  const { url } = supabaseEnv();
  assertLocalTarget(url);
  const service = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!service) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  const res = await request.get(`${url}/rest/v1/activity_records?${query}`, {
    headers: { apikey: service, Authorization: `Bearer ${service}` },
  });
  if (!res.ok()) throw new Error(`serviceReadRecords failed: ${res.status()}`);
  return res.json();
}

/**
 * Delete records with the service role.
 *
 * Required, not a convenience: the API refuses to delete a `submitted` record,
 * and a bulk-submit spec's whole job is producing them. Left behind, they make
 * `lockPeriod` return 409 in a spec four files later, with an error that names
 * neither this file nor the record.
 */
export async function deleteRecordsAsService(
  request: APIRequestContext,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const { url } = supabaseEnv();
  assertLocalTarget(url);
  const service = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!service) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  const headers = { apikey: service, Authorization: `Bearer ${service}`, Prefer: 'return=minimal' };
  const list = ids.map((id) => `"${id}"`).join(',');
  reportCleanup([
    await del(request, `${url}/rest/v1/evidence?activity_record_id=in.(${list})`, headers),
    await del(request, `${url}/rest/v1/activity_records?id=in.(${list})`, headers),
  ]);
}

