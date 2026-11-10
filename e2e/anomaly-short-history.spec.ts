import { test, expect, request as playwrightRequest } from '@playwright/test';
import anomalyEn from '../apps/web/messages/en/anomaly.json';
import anomalyTr from '../apps/web/messages/tr/anomaly.json';
import periodsTr from '../apps/web/messages/tr/periods.json';
import {
  API_BASE,
  bearer,
  login,
  switchUser,
  pickByFieldLabel,
  selectSubsidiary,
  ADMIN_EMAIL,
  CONSULTANT_EMAIL,
  EVIDENCE_FIXTURE,
  getAccessToken,
  createCommittedRecord,
  deleteRecordsAsService,
  findRecordId,
  SUB,
} from './helpers';

/**
 * The short-history anomaly check (BUG-R2-07, owner decision 2026-11-11;
 * OpenSpec `uat2-anomaly-short-history`): one or two earlier periods are enough
 * for the rule to run, a flag on them blocks submit like any other, and every
 * screen says the verdict rests on limited history.
 *
 * The rule itself is pinned by the unit and integration suites. This proves the
 * page: the second period of a series shows the limited-history banner and its
 * gate, the reviewer reads the same sentence, and a third period that is within
 * range says "on limited history" instead of saying nothing.
 *
 * Lane: `SUB.gas` / quarterly `E2E_YEAR` / Electricity, whole company, Q2–Q4.
 * No other spec commits a record in this series: `gates.spec.ts` leaves a Q1
 * DRAFT here, which is no one's history, and `reports.spec.ts` writes its Q2
 * at the London site, which is a different series. Q1 is left alone so that
 * draft and this series never meet. Everything written here is deleted in the
 * `finally`, because a committed record left behind is history for whoever
 * uses this lane next.
 */

const OPTION = 'TonyAI Gas (UK)';
const LANE = { subsidiaryId: SUB.gas, category: 'Electricity' } as const;
const VARIANCE = 'Second production shift added this quarter.';

/** The reviewer's own language, set on a request context of its own so the
 *  reset below still runs after a timed-out test. */
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

// The seed's reviewer is shared by every spec after this one.
test.afterAll(async () => setReviewerLanguage('en'));

test('the second period is gated on limited history, and the third says what it was compared with', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const ids: string[] = [];
  try {
    // Q2: the first period of the series, committed through the API.
    ids.push(await createCommittedRecord(request, token, { ...LANE, periodValue: 'Q2', activityValue: 10_000 }));

    await login(page, ADMIN_EMAIL);
    await page.goto('/data-entry');

    // Q3 at twice Q2. One earlier period is enough for the rule to run.
    await selectSubsidiary(page, OPTION);
    await pickByFieldLabel(page, 'Value', 'Q3');
    await page.getByPlaceholder('e.g. 45000').fill('20000');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
    ids.push(await findRecordId(request, token, { ...LANE, periodValue: 'Q3' }));

    // The banner names its basis: the only earlier period, limited history.
    await expect(page.getByText(/the only earlier period for this reporting entity/)).toBeVisible();
    await expect(page.getByText(/limited history \(1 period\)/)).toBeVisible();
    const variance = page.getByLabel('Reason for variance *');
    await expect(variance).toBeVisible();

    // Electricity needs a file; attached so only the anomaly gate remains.
    await page.locator('[data-testid="evidence-vault-input"]').setInputFiles(EVIDENCE_FIXTURE);
    await expect(page.getByText('Evidence uploaded')).toBeVisible();

    // The same gate as a full-history flag: no reason, no submit.
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByText(/looks anomalous — add a variance comment/i)).toBeVisible();

    await variance.fill(VARIANCE);
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByText('Submitted for review')).toBeVisible();

    // Q4 at 14,000 against an average of 15,000 over two periods: within
    // range, and the form says on how much history instead of saying nothing.
    await page.goto('/data-entry');
    await selectSubsidiary(page, OPTION);
    await pickByFieldLabel(page, 'Value', 'Q4');
    await page.getByPlaceholder('e.g. 45000').fill('14000');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
    ids.push(await findRecordId(request, token, { ...LANE, periodValue: 'Q4' }));

    await expect(page.getByText(anomalyEn.cleanLimited.headline, { exact: false })).toBeVisible();
    await expect(page.getByText(/the average of the 2 earlier periods/)).toBeVisible();
    await expect(page.getByText(/limited history \(2 periods\)/)).toBeVisible();
    await expect(page.getByLabel('Reason for variance *')).toHaveCount(0);

    // The reviewer reads the same basis on the flagged record, with the reason.
    await switchUser(page, CONSULTANT_EMAIL);
    await page.goto('/review');
    await page
      .locator('table tbody tr', { hasText: 'TonyAI Gas' })
      .filter({ hasText: 'Q3 2026' })
      .click();
    await expect(page.getByText(anomalyEn.flagged.headline)).toBeVisible();
    await expect(page.getByText(/limited history \(1 period\)/)).toBeVisible();
    await expect(page.getByText(VARIANCE, { exact: false })).toBeVisible();

    // ...and in Turkish, from the catalogue: the same record, the same basis.
    await setReviewerLanguage('tr');
    await page.goto('/review');
    await page
      .locator('table tbody tr', { hasText: 'TonyAI Gas' })
      .filter({ hasText: periodsTr.values.Q3 })
      .click();
    await expect(page.getByText(anomalyTr.flagged.headline)).toBeVisible();
    await expect(page.getByText(/kısıtlı geçmişe dayanıyor \(1 dönem\)/)).toBeVisible();
  } finally {
    await setReviewerLanguage('en');
    await deleteRecordsAsService(request, ids);
  }
});
