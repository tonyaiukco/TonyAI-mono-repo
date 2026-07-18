import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PASSWORD = 'TonyAI!2026';
export const ADMIN_EMAIL = 'admin@tonyai.local';
export const ENTRY_EMAIL = 'entry@tonyai.local';

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
export const CROSS_TENANT_SUB = SUB.mfg;

/**
 * The seed is monthly-2024 only, so the whole `quarterly` space is unseeded.
 * Every E2E write lives there (distinct subsidiary per test → no tuple/baseline
 * collisions) and the teardown wipes all quarterly rows — the seed is untouched.
 */
export const E2E_YEAR = 2024;
export const E2E_PERIOD = 'quarterly';

// --- Login (UI) -------------------------------------------------------------

/**
 * Logs in via the real Supabase-backed login form and waits to land on the
 * dashboard (middleware redirects unauthenticated users to /login).
 */
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
 * Password-grant a Supabase access token — the same HS256 JWT the NestJS guard
 * verifies. Used both to drive API-only arrange/act steps (approve has no UI)
 * and by the RLS probes.
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
  category: string;
  periodValue: string;
  activityValue: number;
  activityUnit?: string;
  reportingYear?: number;
  reportingPeriod?: string;
}

/**
 * Arrange a committed (submitted) activity record via the API: create draft →
 * attach evidence (all 2024 factor categories are evidence-required) → submit.
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
      locationId: null,
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
export async function cleanupQuarterly(request: APIRequestContext): Promise<void> {
  const { url } = supabaseEnv();
  const service = process.env.E2E_SUPABASE_SERVICE_KEY;
  if (!service) throw new Error('E2E_SUPABASE_SERVICE_KEY not set (see playwright.config.ts env loader).');
  const headers = { apikey: service, Authorization: `Bearer ${service}`, Prefer: 'return=minimal' };
  // Locks first (independent), then records (evidence cascades in the DB).
  await request.delete(`${url}/rest/v1/period_locks?reporting_period=eq.${E2E_PERIOD}`, { headers });
  await request.delete(`${url}/rest/v1/activity_records?reporting_period=eq.${E2E_PERIOD}`, { headers });
}
