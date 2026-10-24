import { test, expect, request as playwrightRequest } from '@playwright/test';
import trCategories from '../apps/web/messages/tr/categories.json';
import trDashboard from '../apps/web/messages/tr/dashboard.json';
import trEmissions from '../apps/web/messages/tr/emissions.json';
import trIntensity from '../apps/web/messages/tr/intensity.json';
import trNav from '../apps/web/messages/tr/nav.json';
import trTargets from '../apps/web/messages/tr/targets.json';
import enDashboard from '../apps/web/messages/en/dashboard.json';
import enEmissions from '../apps/web/messages/en/emissions.json';
import { ADMIN_EMAIL, API_BASE, E2E_YEAR, bearer, getAccessToken, login } from './helpers';

/**
 * The dashboard and Emissions for a Turkish profile (LP4-04 slice 2 PR B, M7):
 * the chrome speaks Turkish — read from the catalogue, so the owner's term
 * review cannot break this spec — figures carry Turkish separators, and the
 * figure itself is the API's in both languages.
 *
 * Read-only: nothing is created, so no lane is claimed. The admin's language
 * is restored in `afterAll` (and by globalSetup before every run).
 */
async function setLanguage(language: 'tr' | 'en') {
  const api = await playwrightRequest.newContext();
  try {
    const token = await getAccessToken(api, ADMIN_EMAIL);
    const res = await api.patch(`${API_BASE}/me/preferences`, { headers: bearer(token), data: { language } });
    if (res.status() !== 200) throw new Error(`language ${language}: ${res.status()}`);
  } finally {
    await api.dispose();
  }
}

// On its own request context, so a timed-out test still leaves the seed user
// in English for the specs after it.
test.afterAll(async () => setLanguage('en'));

/** The year's Scope 1 total as the API computed it. */
async function scope1Total(request: import('@playwright/test').APIRequestContext): Promise<number> {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const res = await request.get(`${API_BASE}/emissions/context/summary?year=${E2E_YEAR}`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: { totals: { scope1: number } } };
  return body.data.totals.scope1;
}

const whole = (locale: 'en-GB' | 'tr-TR', value: number) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);

test('the dashboard and Emissions speak Turkish, and a total is the same number in both languages', async ({
  page,
  request,
}) => {
  await setLanguage('tr');
  await login(page, ADMIN_EMAIL);
  await page.goto(`/?year=${E2E_YEAR}`);

  // The dashboard: header, register, KPI strip, overview, matrix and its cells.
  await expect(page.getByTestId('dashboard-title')).toHaveText(trDashboard.title);
  await expect(page.getByText(trDashboard.register.title, { exact: true })).toBeVisible();
  await expect(page.getByText(trDashboard.strip.totalSubsidiaries, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: trDashboard.overview.title })).toBeVisible();
  await expect(page.getByText(trDashboard.kpi.scope1, { exact: true })).toBeVisible();
  // The card title carries the year beside it.
  await expect(page.getByText(trDashboard.alerts.title).first()).toBeVisible();
  await expect(page.getByText(trDashboard.matrix.subsidiary, { exact: true })).toBeVisible();
  // A cell names its category and status in Turkish (its identity stays the prefix).
  const cell = page.getByRole('button', { name: `TonyAI Energy ${trCategories.Electricity}` }).first();
  await expect(cell).toBeVisible();
  const statusWords = Object.values(trDashboard.status).join('|');
  await expect(cell).toHaveAttribute('aria-label', new RegExp(`: (${statusWords})`));

  // The drill-down: Turkish copy and Turkish month headers.
  await page.getByRole('button', { name: /TonyAI Energy.*konum bazında/s }).first().click();
  await expect(page.getByText(trDashboard.drawer.invoiceGrid, { exact: true })).toBeVisible();
  await expect(page.getByText('Oca', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Emissions: title, tabs, the summary card's figure with Turkish separators.
  const total = await scope1Total(request);
  // Large enough to carry a thousands separator, so the format is really checked.
  expect(total).toBeGreaterThanOrEqual(1000);
  await page.goto(`/emissions?year=${E2E_YEAR}`);
  await expect(page.getByRole('heading', { name: trEmissions.title })).toBeVisible();
  await expect(page.getByText(trEmissions.summary.total1, { exact: true })).toBeVisible();
  await expect(page.getByTestId('summary-scope1')).toHaveText(whole('tr-TR', total));

  await page.getByRole('tab', { name: trEmissions.tabs.history }).click();
  await expect(page.getByRole('columnheader', { name: trEmissions.history.columns.created })).toBeVisible();
  await expect(page.getByTestId('history-shown')).toContainText('gösteriliyor');
  await page.locator('table tbody tr').first().click();
  await expect(page.getByText(trEmissions.drawer.title, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: trEmissions.drawer.auditTrail })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: trEmissions.tabs.targets }).click();
  await expect(page.getByText(trTargets.intro, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: trEmissions.view.intensity, exact: true }).click();
  await expect(page.getByRole('heading', { name: trIntensity.title.replace('{year}', String(E2E_YEAR)) })).toBeVisible();

  // English through the switcher: the same figure, English separators.
  await page.getByRole('button', { name: trNav.languages.en }).click();
  await expect(page.getByRole('heading', { name: enEmissions.title })).toBeVisible();
  await page.getByRole('button', { name: enEmissions.view.absolute, exact: true }).click();
  await page.getByRole('tab', { name: enEmissions.tabs.summary }).click();
  await expect(page.getByTestId('summary-scope1')).toHaveText(whole('en-GB', total));
  await page.goto(`/?year=${E2E_YEAR}`);
  await expect(page.getByTestId('dashboard-title')).toHaveText(enDashboard.title);
});
