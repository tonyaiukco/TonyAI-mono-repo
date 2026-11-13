import { test, expect, request as playwrightRequest } from '@playwright/test';
import anomalyEn from '../apps/web/messages/en/anomaly.json';
import anomalyTr from '../apps/web/messages/tr/anomaly.json';
import dataEntryEn from '../apps/web/messages/en/dataEntry.json';
import {
  API_BASE,
  bearer,
  login,
  switchUser,
  ADMIN_EMAIL,
  CONSULTANT_EMAIL,
  EVIDENCE_FIXTURE,
  getAccessToken,
  deleteRecordsAsService,
} from './helpers';

/**
 * The first-period typo ceiling (BUG-R2-07 tier 3; Decisions 2026-11-12;
 * OpenSpec `uat2-anomaly-typo-ceiling`): a first period above its ceiling is
 * flagged, the form states the amount and the ceiling, submit asks for a
 * variance reason, and the reviewer reads the same statement in Turkish. A
 * first period below its ceiling stays a plain first-period record.
 *
 * The rule itself is pinned by the unit and integration suites; this proves
 * the page.
 *
 * Lane: a subsidiary created by this test (TR), so every series in it is a
 * first period no other spec can give history to. Its records are deleted
 * through the service role and the subsidiary through the API in `finally`.
 */

const YEAR = 2026;
const VARIANCE = 'New plant commissioned; meter read checked against the invoice.';

async function setReviewerLanguage(language: 'tr' | 'en') {
  const api = await playwrightRequest.newContext();
  try {
    const token = await getAccessToken(api, CONSULTANT_EMAIL);
    const res = await api.patch(`${API_BASE}/me/preferences`, { headers: bearer(token), data: { language } });
    if (res.status() !== 200) throw new Error(`language ${language}: ${res.status()}`);
  } finally {
    await api.dispose();
  }
}

test.afterAll(async () => setReviewerLanguage('en'));

test('a first period above its ceiling is flagged, gated and stated; one below it is a first-period record', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const name = `E2E Ceiling ${Date.now()}`;
  const created = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: name, geographyCode: 'TR', reportingStatus: 'active' },
  });
  expect(created.status()).toBe(201);
  const subsidiaryId = ((await created.json()) as { id: string }).id;
  const ids: string[] = [];

  const draft = async (body: Record<string, unknown>) => {
    const res = await request.post(`${API_BASE}/activity-records`, {
      headers: bearer(token),
      data: {
        subsidiaryId,
        reportingYear: YEAR,
        reportingPeriod: 'monthly',
        periodValue: 'January',
        varianceReason: null,
        input: null,
        ...body,
      },
    });
    if (!res.ok()) throw new Error(`create failed: ${res.status()} ${await res.text()}`);
    const record = (await res.json()) as { id: string; anomalyFlag: boolean; anomalyBaselinePriorCount: number | null };
    ids.push(record.id);
    return record;
  };
  const open = async (category: string) => {
    const query = new URLSearchParams({
      subsidiaryId,
      category,
      year: String(YEAR),
      period: 'monthly',
      periodValue: 'January',
    });
    await page.goto(`/data-entry?${query}`);
    await expect(page.getByTestId('evidence-vault')).toHaveAttribute('data-mode', 'record');
  };

  try {
    // 4,500,000 kWh: an extra zero on a 450,000 kWh month. Stored flagged,
    // with no earlier period behind it.
    const big = await draft({ category: 'Electricity', activityValue: 4_500_000, activityUnit: 'kWh' });
    expect(big).toMatchObject({ anomalyFlag: true, anomalyBaselinePriorCount: 0 });
    // 100 Sm³ of natural gas: a first period well under its ceiling.
    const small = await draft({ category: 'Natural Gas', activityValue: 100, activityUnit: 'standard_cubic_metres' });
    expect(small).toMatchObject({ anomalyFlag: false, anomalyBaselinePriorCount: 0 });

    await login(page, ADMIN_EMAIL);

    // The form states the amount and the ceiling, and asks for a reason.
    await open('Electricity');
    await expect(page.getByText(/4,500,000 kWh is above the plausibility ceiling of 1,000,000 kWh/)).toBeVisible();
    await expect(page.getByText(/historical average/)).toHaveCount(0);
    const variance = page.getByLabel('Reason for variance *');
    await expect(variance).toBeVisible();

    // Electricity needs a file; attached so only the anomaly gate remains.
    await page.locator('[data-testid="evidence-vault-input"]').setInputFiles(EVIDENCE_FIXTURE);
    await expect(page.getByText('Evidence uploaded')).toBeVisible();

    // No reason, no submit — and the refusal names the ceiling.
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByText(dataEntryEn.aboveCeilingBeforeSubmit)).toBeVisible();

    await variance.fill(VARIANCE);
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByText('Submitted for review')).toBeVisible();

    // Below its ceiling: the first-period note, no flag, no variance field.
    await open('Natural Gas');
    await expect(page.getByText(anomalyEn.firstPeriod.headline, { exact: false })).toBeVisible();
    await expect(page.getByText(anomalyEn.ceiling.headline)).toHaveCount(0);
    await expect(page.getByLabel('Reason for variance *')).toHaveCount(0);

    // The reviewer reads the same statement, in Turkish, beside the reason.
    await setReviewerLanguage('tr');
    await switchUser(page, CONSULTANT_EMAIL);
    await page.goto('/review');
    await page.locator('table tbody tr', { hasText: name }).first().click();
    await expect(page.getByText(anomalyTr.ceiling.headline)).toBeVisible();
    await expect(
      page.getByText(/4\.500\.000 kWh, bu kategori için makul üst sınır olan 1\.000\.000 kWh/),
    ).toBeVisible();
    await expect(page.getByText(VARIANCE, { exact: false })).toBeVisible();

    // The matrix cell is amber and does not count the flag as not checked;
    // the export names the ceiling.
    const matrix = await request.get(`${API_BASE}/emissions/tracking-matrix?year=${YEAR}`, { headers: bearer(token) });
    expect(matrix.ok()).toBe(true);
    const row = ((await matrix.json()) as {
      rows: { subsidiaryId: string; cells: { category: string; anomaly: boolean; notEvaluatedRecordCount: number }[] }[];
    }).rows.find((r) => r.subsidiaryId === subsidiaryId);
    const cell = row?.cells.find((c) => c.category === 'Electricity');
    expect(cell).toMatchObject({ anomaly: true, notEvaluatedRecordCount: 0 });
    const csv = await request.get(`${API_BASE}/reports/csv?template=ghg_protocol_detail&year=${YEAR}`, {
      headers: bearer(token),
    });
    expect(csv.ok()).toBe(true);
    const line = (await csv.text()).split('\n').find((l) => l.includes(name) && l.includes('Electricity'));
    expect(line).toContain('yes (above the first-period ceiling)');
  } finally {
    await setReviewerLanguage('en');
    await deleteRecordsAsService(request, ids);
    await request.delete(`${API_BASE}/subsidiaries/${subsidiaryId}`, { headers: bearer(token) });
  }
});
