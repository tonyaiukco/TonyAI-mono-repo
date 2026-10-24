import { test, expect, request as playwrightRequest } from '@playwright/test';
import trBulk from '../apps/web/messages/tr/bulkUpload.json';
import trCategories from '../apps/web/messages/tr/categories.json';
import trCompleteness from '../apps/web/messages/tr/completeness.json';
import trEntry from '../apps/web/messages/tr/dataEntry.json';
import trNav from '../apps/web/messages/tr/nav.json';
import trPeriods from '../apps/web/messages/tr/periods.json';
import enEntry from '../apps/web/messages/en/dataEntry.json';
import {
  API_BASE,
  ENTRY_EMAIL,
  SUB,
  bearer,
  findRecordId,
  getAccessToken,
  login,
  pickByFieldLabel,
} from './helpers';

/**
 * Data Entry for a Turkish profile (LP4-04 slice 2, M4/M7): the panels speak
 * Turkish — read from the catalogue, so the owner's term review cannot break
 * this spec — and a quantity typed the Turkish way is the same number after a
 * switch to English, and the same number in the database.
 *
 * Lane: `SUB.logistics` / quarterly `E2E_YEAR` / Q2 `Natural Gas`, whole
 * company — no other spec writes Natural Gas for Logistics. The draft is
 * deleted in the test's own `finally`.
 */
async function setLanguage(language: 'tr' | 'en') {
  const api = await playwrightRequest.newContext();
  try {
    const token = await getAccessToken(api, ENTRY_EMAIL);
    const res = await api.patch(`${API_BASE}/me/preferences`, { headers: bearer(token), data: { language } });
    if (res.status() !== 200) throw new Error(`language ${language}: ${res.status()}`);
  } finally {
    await api.dispose();
  }
}

// On its own request context, so a timed-out test still leaves the seed user
// in English for the specs after it.
test.afterAll(async () => setLanguage('en'));

test('Data Entry speaks Turkish, and 1.234,5 typed in Turkish is saved as 1234.5 after a switch to English', async ({
  page,
  request,
}) => {
  await setLanguage('tr');
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');

  await expect(page.getByText(trEntry.submissions.title, { exact: true })).toBeVisible();
  await expect(page.getByText(trBulk.title, { exact: true })).toBeVisible();
  await expect(page.getByText(trEntry.context.title, { exact: true })).toBeVisible();
  await expect(page.getByTestId('sign-out')).toHaveText('Çıkış yap');

  await pickByFieldLabel(page, trEntry.subsidiary, 'TonyAI Logistics (TR)');
  await expect(page.getByText(trCompleteness.panel.title, { exact: true })).toBeVisible();
  await pickByFieldLabel(page, trEntry.category, trCategories['Natural Gas']);
  await pickByFieldLabel(page, trEntry.periodValue, trPeriods.values.Q2);

  await page.getByPlaceholder(trEntry.activityValuePlaceholder).fill('1.234,5');
  // The switcher, as a user would: the field is re-written from the number it
  // meant (D15), never re-read under English rules (where 1.234 is 1.234).
  await page.getByRole('button', { name: trNav.languages.en }).click();
  const value = page.getByPlaceholder(enEntry.activityValuePlaceholder);
  await expect(value).toHaveValue('1234.5');

  await page.getByRole('button', { name: enEntry.saveDraft }).click();
  await expect(page.getByText(enEntry.draftSaved)).toBeVisible();

  const token = await getAccessToken(request, ENTRY_EMAIL);
  const id = await findRecordId(request, token, {
    subsidiaryId: SUB.logistics,
    category: 'Natural Gas',
    periodValue: 'Q2',
  });
  try {
    const res = await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { activityValue: number }).activityValue).toBe(1234.5);
  } finally {
    const removed = await request.delete(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
    expect(removed.ok()).toBe(true);
  }
});
