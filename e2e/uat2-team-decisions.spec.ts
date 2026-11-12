import { test, expect, type APIRequestContext, type Route } from '@playwright/test';
import { DEFAULT_PAGE_LIMIT } from '../packages/shared-types/src/bounded-access';
import anomalyEn from '../apps/web/messages/en/anomaly.json';
import dataEntryEn from '../apps/web/messages/en/dataEntry.json';
import evidenceEn from '../apps/web/messages/en/evidence.json';
import reviewEn from '../apps/web/messages/en/review.json';
import enCategories from '../apps/web/messages/en/categories.json';
import enPeriods from '../apps/web/messages/en/periods.json';
import enUnits from '../apps/web/messages/en/units.json';
import {
  API_BASE,
  CONSULTANT_EMAIL,
  E2E_TR_INPUTS,
  E2E_TR_INPUTS_YEAR,
  ENTRY_EMAIL,
  EVIDENCE_FIXTURE,
  SUB,
  bearer,
  cleanupTrInputsFixture,
  deleteRecordsAsService,
  getAccessToken,
  login,
  pickByFieldLabel,
  seedTrInputsFixture,
  switchUser,
} from './helpers';

/**
 * UAT round 2 team decisions (OpenSpec `uat2-team-decisions-copy`):
 * - S2: the sealed release list, and "Package sealed on" beside the release a
 *   figure names (Data Entry preview, conversion note, review sheet);
 * - K4-3a option A: a first-period record is named as one, needs no variance
 *   reason, and is marked in the review queue apart from a flag;
 * - K5 option A: a refrigerant record lists the evidence it accepts, and a
 *   shortcut attaches one document to the year's other gas records.
 *
 * Lanes, in `E2E_TR_INPUTS_YEAR` (2023), priced from the TR inputs fixture
 * release, which `data-entry-tr-inputs.spec.ts` also seeds and removes:
 * - `SUB.logistics`, Natural Gas, quarterly Q1, the whole subsidiary. Only Q3
 *   drafts are written there by the other file, and a draft is no history.
 * - `SUB.energy`, Refrigerants, annual, at its two seeded facilities. No other
 *   spec writes 2023 there.
 * Every record is deleted in `finally`, found by its lane, not by an id
 * collected on the way.
 */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => seedTrInputsFixture());
test.afterAll(async () => cleanupTrInputsFixture());

const YEAR = E2E_TR_INPUTS_YEAR;
const ISTANBUL_HQ = '33333333-3333-3333-3333-333333330001';
const ANKARA_PLANT = '33333333-3333-3333-3333-333333330002';

async function laneRecordIds(
  request: APIRequestContext,
  token: string,
  q: { subsidiaryId: string; category: string },
): Promise<string[]> {
  const search = new URLSearchParams({ subsidiaryId: q.subsidiaryId, category: q.category, year: String(YEAR), limit: '100' });
  const res = await request.get(`${API_BASE}/activity-records?${search}`, { headers: bearer(token) });
  if (!res.ok()) throw new Error(`list failed: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { items: { id: string }[] }).items.map((r) => r.id);
}

test('the sealed release list answers a signed-in user only, with database seal dates', async ({ request }) => {
  const anonymous = await request.get(`${API_BASE}/factors/releases`);
  expect(anonymous.status()).toBe(401);

  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await request.get(`${API_BASE}/factors/releases`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  const releases = (await res.json()) as Array<Record<string, unknown>>;
  expect(releases.length).toBeGreaterThan(0);
  for (const release of releases) {
    expect(typeof release.sealedAt).toBe('string');
    expect(Number.isNaN(Date.parse(release.sealedAt as string))).toBe(false);
    for (const hidden of ['reviewedBy', 'withdrawnBy', 'notes']) expect(release).not.toHaveProperty(hidden);
  }
});

test('a first-period record is named, needs no variance reason, and shows its package seal date', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const lane = { subsidiaryId: SUB.logistics, category: 'Natural Gas' };
  try {
    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await pickByFieldLabel(page, dataEntryEn.subsidiary, 'TonyAI Logistics (TR)');
    await pickByFieldLabel(page, dataEntryEn.category, enCategories['Natural Gas']);
    await pickByFieldLabel(page, dataEntryEn.reportingYear, String(YEAR));
    await pickByFieldLabel(page, dataEntryEn.period, enPeriods.granularity.quarterly);
    await pickByFieldLabel(page, dataEntryEn.periodValue, enPeriods.values.Q1);
    await page.getByRole('combobox', { name: dataEntryEn.unit, exact: true }).click();
    await page.getByRole('option', { name: enUnits.label.standard_cubic_metres, exact: true }).click();
    await expect(page.locator('#input-ncv')).toHaveValue(String(E2E_TR_INPUTS.referenceNcv));
    await page.getByPlaceholder(dataEntryEn.activityValuePlaceholder).fill('100');

    // S2: the preview names the package seal date, beside its source and in the conversion note.
    await expect(page.getByText(dataEntryEn.preview.sealedOn, { exact: true })).toBeVisible();
    await expect(page.getByTestId('conversion-note')).toContainText('Package sealed on');

    await page.getByRole('button', { name: dataEntryEn.saveDraft }).click();
    await expect(page.getByText(dataEntryEn.draftSaved)).toBeVisible();

    // K4-3a: named a first-period record, told what to check, no variance field.
    await expect(page.getByText(anomalyEn.firstPeriod.headline, { exact: false })).toBeVisible();
    await expect(page.getByText(anomalyEn.firstPeriod.detail, { exact: false })).toBeVisible();
    await expect(page.getByLabel('Reason for variance *')).toHaveCount(0);

    await page.locator('[data-testid="evidence-vault-input"]').setInputFiles(EVIDENCE_FIXTURE);
    await expect(page.getByText(evidenceEn.uploaded)).toBeVisible();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByText('Submitted for review')).toBeVisible();

    // The reviewer's queue marks it apart from a flag; the sheet names it and its seal date.
    await switchUser(page, CONSULTANT_EMAIL);
    await page.goto('/review');
    const row = page.locator('table tbody tr', { hasText: 'TonyAI Logistics' }).filter({ hasText: `Q1 ${YEAR}` });
    await expect(row.getByTestId('first-period-marker')).toBeVisible();
    await expect(row.getByTestId('first-period-marker')).toHaveAttribute('aria-label', anomalyEn.firstPeriod.headline);
    await row.click();
    await expect(page.getByText(anomalyEn.firstPeriod.headline, { exact: true })).toBeVisible();
    await expect(page.getByText(anomalyEn.flagged.headline)).toHaveCount(0);
    await expect(page.getByText(reviewEn.sheet.sealedOn, { exact: true })).toBeVisible();
    await expect(page.getByTestId('release-sealed-on')).toHaveText(/\d{4}/);
  } finally {
    await deleteRecordsAsService(request, await laneRecordIds(request, token, lane).catch(() => []));
  }
});

test('a refrigerant record lists the evidence it accepts, and attaches one document to the year’s gas records', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const lane = { subsidiaryId: SUB.energy, category: 'Refrigerants' };
  const draft = async (locationId: string) => {
    const res = await request.post(`${API_BASE}/activity-records`, {
      headers: bearer(token),
      data: {
        subsidiaryId: SUB.energy,
        locationId,
        reportingYear: YEAR,
        reportingPeriod: 'annual',
        periodValue: 'Annual',
        category: 'Refrigerants',
        activityType: E2E_TR_INPUTS.refrigerant,
        activityValue: 10,
        activityUnit: 'kg',
        parameters: { equipment: [{ equipmentType: 'split_air_conditioner', capacityKg: 10, refillKg: 0, leakRateChoice: 'default' }] },
        varianceReason: null,
        input: null,
      },
    });
    if (!res.ok()) throw new Error(`create failed: ${res.status()} ${await res.text()}`);
    return ((await res.json()) as { id: string }).id;
  };
  const open = async (locationId: string) => {
    const query = new URLSearchParams({
      subsidiaryId: SUB.energy,
      category: 'Refrigerants',
      year: String(YEAR),
      locationId,
      period: 'annual',
      periodValue: 'Annual',
    });
    await page.goto(`/data-entry?${query}`);
    await expect(page.getByTestId('evidence-vault')).toHaveAttribute('data-mode', 'record');
  };
  try {
    await draft(ISTANBUL_HQ);
    await login(page, ENTRY_EMAIL);

    // One gas record that year: the documents are listed, and there is nothing to share with.
    await open(ISTANBUL_HQ);
    const note = page.getByTestId('evidence-required-note');
    for (const item of Object.values(evidenceEn.refrigerantNote)) await expect(note).toContainText(item);
    await expect(note).not.toContainText(evidenceEn.requiredNote);
    await expect(page.getByTestId('evidence-share-with-year')).toHaveCount(0);

    // A second gas record: the shortcut ticks both and one file backs both —
    // even from a table narrowed to an empty category, where the rows on
    // screen are not the ones the shortcut asks for until the refetch lands
    // (qa-auditor P2-1).
    await draft(ANKARA_PLANT);

    // The year's read is slowed, so the upload lands while it is still
    // running: its old count must not be written back over the new one
    // (review findings: a stale evidence count, then a stale year read).
    const slowYear = '**/api/v1/activity-records?*';
    const isYearRead = (u: string) => {
      const url = new URL(u);
      return url.searchParams.get('category') === 'Refrigerants' && url.searchParams.get('limit') === '100';
    };
    // Only the first read is slow, and slow on its way BACK: the server reads
    // the count before the upload, and the answer lands after it.
    let yearReads = 0;
    let staleAnswered!: () => void;
    const staleRead = new Promise<void>((resolve) => (staleAnswered = resolve));
    const slowYearHandler = async (route: Route) => {
      if (!isYearRead(route.request().url()) || yearReads++ > 0) return route.continue();
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await route.fulfill({ response });
      staleAnswered();
    };
    await page.route(slowYear, slowYearHandler);
    await open(ISTANBUL_HQ);

    // A file added to the open record while that read runs: the shortcut no
    // longer ticks that record, only the other gas, even once the read lands.
    await page.locator('[data-testid="evidence-vault-input"]').setInputFiles(EVIDENCE_FIXTURE);
    await expect(page.getByText(evidenceEn.uploaded)).toBeVisible();
    await staleRead;
    await page.waitForTimeout(300);
    await page.getByTestId('evidence-share-with-year').click();
    await expect(page.getByTestId('evidence-attach-choose')).toHaveText(evidenceEn.attachOne.replace('{count}', '1'));
    await page.unroute(slowYear, slowYearHandler);
    await page.getByTestId('evidence-attach-bar').getByRole('button', { name: 'Cancel' }).click();
    // ...and once it is removed again, both are ticked.
    await page.getByRole('button', { name: /^Remove.*: sample-invoice\.pdf$/ }).click();
    await expect(page.getByText(evidenceEn.detached)).toBeVisible();

    await page
      .getByTestId('records-filters')
      .getByRole('combobox', { name: dataEntryEn.records.filters.category })
      .click();
    await page.getByRole('option', { name: enCategories.Electricity, exact: true }).click();
    await expect(page.getByTestId('records-table-empty')).toBeVisible();

    // The table reads one row per page, and its second page is slow: the file
    // cannot be chosen until every requested record is ticked (review
    // finding: an upload before the ticking finished).
    const tablePages = '**/api/v1/activity-records?*';
    const tablePagesHandler = async (route: Route) => {
      const url = new URL(route.request().url());
      const tablePage =
        route.request().method() === 'GET' &&
        url.searchParams.get('category') === 'Refrigerants' &&
        !url.searchParams.has('limit');
      if (!tablePage) return route.continue();
      url.searchParams.set('limit', '1');
      if (url.searchParams.has('cursor')) await new Promise((resolve) => setTimeout(resolve, 2_500));
      // Fetched from the test runner and handed back, so the browser's CORS
      // preflight still matches the URL it asked for.
      const response = await route.fetch({ url: url.toString() });
      // The page answers the limit the browser asked for (none, so the
      // default), as the client checks; only its rows are one per page.
      const body = { ...((await response.json()) as Record<string, unknown>), limit: DEFAULT_PAGE_LIMIT };
      const origin = (await route.request().headerValue('origin')) ?? 'http://localhost:3000';
      await route.fulfill({
        status: response.status(),
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
        body: JSON.stringify(body),
      });
    };
    await page.route(tablePages, tablePagesHandler);
    await page.getByTestId('evidence-share-with-year').click();
    const bar = page.getByTestId('evidence-attach-bar');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('evidence-preselect-loading')).toBeVisible();
    await expect(page.getByTestId('evidence-attach-choose')).toBeDisabled();
    await expect(page.getByTestId('evidence-preselect-loading')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('evidence-attach-choose')).toBeEnabled();
    await expect(page.getByTestId('evidence-attach-choose')).toContainText('2');
    await expect(page.getByTestId('evidence-preselect-missing')).toHaveCount(0);
    await page.unroute(tablePages, tablePagesHandler);
    await page.getByTestId('evidence-attach-input').setInputFiles(EVIDENCE_FIXTURE);
    await page.getByTestId('evidence-attach-confirm').click();
    await expect(page.getByText(/now backs 2 records/)).toBeVisible();

    const ids = await laneRecordIds(request, token, lane);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const res = await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
      expect(((await res.json()) as { evidenceCount: number }).evidenceCount).toBe(1);
    }
  } finally {
    await deleteRecordsAsService(request, await laneRecordIds(request, token, lane).catch(() => []));
  }
});
