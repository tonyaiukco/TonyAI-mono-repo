import { test, expect, request as playwrightRequest, type Page, type Request } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_BASE,
  CONSULTANT_EMAIL,
  E2E_YEAR,
  ENTRY_EMAIL,
  OUT_OF_SCOPE_SUB,
  SUB,
  bearer,
  getAccessToken,
  login,
} from './helpers';

/**
 * LP3-02 N1: one reporting context — year, subsidiary, scope, category — in the
 * URL, through the real app. It survives a reload and a sidebar navigation,
 * reaches the export, is forgotten when someone else signs in, and an invalid
 * link loads nothing (D06's default under a 2027 clock is a unit test:
 * a faked browser clock makes every Supabase session look expired). Read-only: no record is written (the int spec
 * `reporting-context-reconciliation` proves the figures on its own fixture).
 * As the consultant: a non-authoring role that may export, whose catalogue
 * language the last test sets and restores.
 */

const CANONICAL_DEFAULT = `year=${E2E_YEAR}&subsidiaryId=all&scope=all&category=all`;
/** A request's query, without the noise of the API base. */
const queryOf = (request: Request) => Object.fromEntries(new URL(request.url()).searchParams);
const isSummary = (request: Request) => request.url().includes('/emissions/context/summary');

async function pick(page: Page, testId: string, option: string | RegExp) {
  await page.getByTestId(testId).click();
  await page.getByRole('option', { name: option }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

test('the selection lives in the URL: reload, navigation and the export keep it', async ({ page }) => {
  await login(page, CONSULTANT_EMAIL);
  // The dashboard writes the resolved default into the canonical URL.
  await expect(page).toHaveURL(new RegExp(`/\\?${CANONICAL_DEFAULT}$`));

  await page.goto('/emissions');
  await expect(page).toHaveURL(new RegExp(`/emissions\\?${CANONICAL_DEFAULT}$`));
  await pick(page, 'context-year', '2027');
  await pick(page, 'context-subsidiary', /^TonyAI Energy/);
  await expect(page).toHaveURL(new RegExp(`year=2027&subsidiaryId=${SUB.energy}&scope=all&category=all`));
  // Each choice is a history entry: Back returns to the previous selection, and its data.
  const backData = page.waitForRequest((r) => isSummary(r) && !('subsidiaryId' in queryOf(r)));
  await page.goBack();
  expect(queryOf(await backData)).toEqual({ year: '2027' });
  await expect(page).toHaveURL(/year=2027&subsidiaryId=all&scope=all&category=all/);
  await expect(page.getByTestId('context-subsidiary')).toHaveText('All accessible subsidiaries');
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`year=2027&subsidiaryId=${SUB.energy}`));
  await expect(page.getByTestId('context-subsidiary')).toContainText('TonyAI Energy');

  // A reload keeps it — the URL, not memory, carries it.
  await page.reload();
  await expect(page.getByTestId('context-year')).toHaveText('2027');
  await expect(page.getByTestId('context-subsidiary')).toContainText('TonyAI Energy');
  // Trends is the explicit all-year comparison, labelled as such.
  await page.getByRole('tab', { name: /trends/i }).click();
  await expect(page.getByTestId('trends-all-years')).toBeVisible();

  // A sidebar link has no query: the remembered selection fills it in.
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(new RegExp(`/reports\\?year=2027&subsidiaryId=${SUB.energy}&scope=all&category=all`));
  await expect(page.getByText(/Reporting year 2027/)).toBeVisible();

  // The export is the selection the preview shows: 2027, Energy — read off the
  // request itself (every seed id starts 22222222, so the file name cannot tell).
  const exported = page.waitForRequest((r) => r.url().includes('/reports/context/csv'));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect(queryOf(await exported)).toEqual({
    year: '2027', subsidiaryId: SUB.energy, template: 'executive_summary',
    includeMethodologyNotes: 'true', includeEvidenceSummary: 'false',
  });
  expect((await download).suggestedFilename()).toBe(`tonyai-executive_summary-2027-${SUB.energy.slice(0, 8)}.csv`);

  // A scope narrows the report to an extract, and says so.
  await pick(page, 'context-scope', 'Scope 2');
  await expect(page).toHaveURL(/scope=2/);
  await expect(page.getByTestId('filtered-extract')).toContainText('Scope 2');
});

test('a remembered selection is the signed-in person\'s: the next one to sign in starts from the default', async ({ page }) => {
  await login(page, CONSULTANT_EMAIL);
  await pick(page, 'context-subsidiary', /^TonyAI Gas/);
  await expect(page).toHaveURL(new RegExp(`subsidiaryId=${SUB.gas}`));
  // Same tab, client-side: sign out, then someone else signs in.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
  await login(page, ENTRY_EMAIL);
  await expect(page).toHaveURL(new RegExp(`/\\?${CANONICAL_DEFAULT}$`));
  await expect(page.getByRole('heading', { name: /Data Collection Status/ })).toContainText(String(E2E_YEAR));
});

test('a drawer belongs to its selection: Back closes it instead of mixing two years (Codex B9 P2-3)', async ({ page }) => {
  await login(page, CONSULTANT_EMAIL);
  await pick(page, 'context-year', '2025');
  await pick(page, 'context-year', String(E2E_YEAR));
  await page.getByRole('button', { name: /TonyAI Energy.*per location/s }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/year=2025&/);
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Data Collection Status/ }).first()).toContainText('2025');
});

test('a mutation that completes after a new selection refreshes the new one, not the old (Codex B9 P2-2)', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  // `E2E-`: the global teardown removes it if this test stops before deleting it.
  const created = await request.post(`${API_BASE}/targets`, {
    headers: bearer(token),
    data: { subsidiaryId: SUB.energy, name: 'E2E-delayed-delete', basis: 'science_based', scope: 'all',
      baselineYear: 2023, baselineTCo2e: 2000, targetYear: 2030, targetTCo2e: 1000 },
  });
  expect(created.status()).toBe(201);
  // The DELETE is held until the user has moved on.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/targets/*', async (route) => {
    if (route.request().method() === 'DELETE') await held;
    await route.continue();
  });

  await login(page, ADMIN_EMAIL);
  await page.goto(`/emissions?year=${E2E_YEAR}&subsidiaryId=${SUB.energy}&scope=all&category=all`);
  await page.getByRole('tab', { name: 'Targets' }).click();
  await expect(page.getByText('Net-zero pathway 2030')).toBeVisible();
  await page.getByRole('heading', { name: 'E2E-delayed-delete' })
    .locator('xpath=ancestor::div[contains(@class,"justify-between")][1]')
    .getByRole('button', { name: 'Delete target' }).click();

  await pick(page, 'context-subsidiary', /^TonyAI Mfg/);
  await expect(page.getByText('Manufacturing SBTi 1.5°C')).toBeVisible();
  await expect(page.getByText('Net-zero pathway 2030')).toHaveCount(0);

  // The follow-up refresh is the current selection's, so Energy's targets never return under Mfg.
  // Every target read after the release is recorded, so a second, stale refresh cannot hide.
  const isTargetRead = (r: Request) => r.method() === 'GET' && /\/api\/v1\/targets(\/progress)?\?/.test(r.url());
  const readsAfterRelease: string[] = [];
  page.on('request', (r) => {
    if (isTargetRead(r)) readsAfterRelease.push(new URL(r.url()).searchParams.get('subsidiaryId') ?? '');
  });
  const followUp = page.waitForRequest((r) => isTargetRead(r) && /\/api\/v1\/targets\?/.test(r.url()));
  release();
  await expect(page.getByText('Target removed')).toBeVisible();
  const followUpRequest = await followUp;
  expect(new URL(followUpRequest.url()).searchParams.get('subsidiaryId')).toBe(SUB.mfg);
  // Its own response, not `networkidle`: under `page.route` the page-wide idle signal never
  // came on CI (E2E run 39860897619) although the API had answered every request.
  await followUpRequest.response();
  expect(new Set(readsAfterRelease)).toEqual(new Set([SUB.mfg]));
  await expect(page.getByText('Manufacturing SBTi 1.5°C')).toBeVisible();
  await expect(page.getByText('Net-zero pathway 2030')).toHaveCount(0);
});

test('an invalid link is refused, loads nothing, and offers the default', async ({ page }) => {
  await login(page, CONSULTANT_EMAIL);
  // The dashboard's own context reads finish first, so only this page's are counted.
  await page.waitForLoadState('networkidle');
  const contextCalls: string[] = [];
  page.on('request', (request) => {
    // Every context route: `/emissions/context/…`, `/reports/context/…` and `/intensity/context?…`.
    if (/\/context(\/|\?)/.test(new URL(request.url()).pathname + '?')) contextCalls.push(request.url());
  });
  await page.goto('/emissions?year=02027&scope=1&category=Electricity');
  const refusal = page.getByTestId('context-invalid');
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText('reporting year');
  await expect(refusal).toContainText('scope');
  // Never "fixed" to a default behind the user's back.
  await expect(page).toHaveURL(/year=02027/);
  // Let any fetch an effect might start arrive before deciding none did.
  await page.waitForLoadState('networkidle');
  expect(contextCalls).toEqual([]);

  await refusal.getByRole('button', { name: 'Use the default selection' }).click();
  await expect(page).toHaveURL(new RegExp(`/emissions\\?${CANONICAL_DEFAULT}$`));
  await expect(page.getByTestId('context-invalid')).toHaveCount(0);
});

test('a selection outside the caller\'s access stays selected and empty — never all', async ({ page, request }) => {
  await login(page, ENTRY_EMAIL);
  await page.waitForLoadState('networkidle');
  const summaries: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/emissions/context/summary')) summaries.push(new URL(r.url()).searchParams.get('subsidiaryId') ?? '');
  });
  await page.goto(`/emissions?year=${E2E_YEAR}&subsidiaryId=${OUT_OF_SCOPE_SUB}&scope=all&category=all`);
  await expect(page.getByTestId('context-unavailable')).toBeVisible();
  await expect(page.getByTestId('context-subsidiary')).toContainText('Unavailable subsidiary');
  await expect(page).toHaveURL(new RegExp(`subsidiaryId=${OUT_OF_SCOPE_SUB}`));
  expect(new Set(summaries)).toEqual(new Set([OUT_OF_SCOPE_SUB]));
  // The API answers that selection empty for this caller.
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await request.get(`${API_BASE}/emissions/context/summary?year=${E2E_YEAR}&subsidiaryId=${OUT_OF_SCOPE_SUB}`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  expect((await res.json()).data).toMatchObject({ recordCount: 0, totals: { total: 0 } });
});

test('Data Entry refuses a link with an invalid year instead of opening the default year', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto(`/data-entry?subsidiaryId=${SUB.energy}&category=Natural%20Gas&year=02027`);
  await expect(page.getByText("This link's reporting year is not valid, so the link was not applied.")).toBeVisible();
  await expect(page.locator('div.space-y-2').filter({ hasText: 'Category' }).getByRole('combobox')).not.toContainText('Natural Gas');
});

test.describe('in Turkish', () => {
  /** The consultant's language, set through the API as the user would. */
  async function setLanguage(language: 'tr' | 'en') {
    const api = await playwrightRequest.newContext();
    try {
      const token = await getAccessToken(api, CONSULTANT_EMAIL);
      const res = await api.patch(`${API_BASE}/me/preferences`, { headers: bearer(token), data: { language } });
      if (res.status() !== 200) throw new Error(`language ${language}: ${res.status()}`);
    } finally {
      await api.dispose();
    }
  }
  // On its own request context, so a timed-out test still leaves the seed user
  // in English for the specs and runs after it.
  test.afterAll(async () => setLanguage('en'));

  test('the selection speaks Turkish for a Turkish profile', async ({ page }) => {
    await setLanguage('tr');
    await login(page, CONSULTANT_EMAIL);
    await expect(page.getByTestId('context-scope')).toHaveText('Tüm kapsamlar');
    await expect(page.getByTestId('context-subsidiary')).toHaveText('Erişilebilir tüm bağlı şirketler');
  });
});
