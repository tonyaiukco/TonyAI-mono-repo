import { test, expect, request as playwrightRequest } from '@playwright/test';
import anomalyEn from '../apps/web/messages/en/anomaly.json';
import anomalyTr from '../apps/web/messages/tr/anomaly.json';
import periodsTr from '../apps/web/messages/tr/periods.json';
import {
  API_BASE,
  bearer,
  E2E_YEAR,
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
 * No other spec COMMITS a record in this series, and only a committed record
 * is history. `gates.spec.ts` leaves a Q1 draft here and
 * `turkish-filenames.spec.ts` a Q3 draft; `review-queue.spec.ts` posts a Q4 as
 * the consultant and is refused; `reports.spec.ts` writes its Q2 at the London
 * site, a different series. All of them run after this file (one worker, in
 * file order). Everything written here is deleted in the `finally`, by its
 * place in the lane and not by an id collected on the way, so a step that
 * fails after a save still cleans up: a committed record left behind is
 * history for whoever uses this lane next.
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
  try {
    // Q2: the first period of the series, committed through the API.
    await createCommittedRecord(request, token, { ...LANE, periodValue: 'Q2', activityValue: 10_000 });

    await login(page, ADMIN_EMAIL);
    await page.goto('/data-entry');

    // Q3 at twice Q2. One earlier period is enough for the rule to run.
    await selectSubsidiary(page, OPTION);
    await pickByFieldLabel(page, 'Value', 'Q3');
    await page.getByPlaceholder('e.g. 45000').fill('20000');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();

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

    await expect(page.getByText(anomalyEn.cleanLimited.headline, { exact: false })).toBeVisible();
    await expect(page.getByText(/the average of the 2 earlier periods/)).toBeVisible();
    await expect(page.getByText(/limited history \(2 periods\)/)).toBeVisible();
    await expect(page.getByLabel('Reason for variance *')).toHaveCount(0);

    // No flag, so no reason is asked for: with its file, Q4 goes to review.
    await page.locator('[data-testid="evidence-vault-input"]').setInputFiles(EVIDENCE_FIXTURE);
    await expect(page.getByText('Evidence uploaded')).toBeVisible();
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByText('Submitted for review')).toBeVisible();

    // The reviewer reads the same basis on the flagged record, with the reason.
    await switchUser(page, CONSULTANT_EMAIL);
    await page.goto('/review');
    const row = (period: string) =>
      page.locator('table tbody tr', { hasText: 'TonyAI Gas' }).filter({ hasText: period });
    await row(`Q3 ${E2E_YEAR}`).click();
    await expect(page.getByText(anomalyEn.flagged.headline)).toBeVisible();
    await expect(page.getByText(/limited history \(1 period\)/)).toBeVisible();
    await expect(page.getByText(VARIANCE, { exact: false })).toBeVisible();
    await page.keyboard.press('Escape');

    // ...and on the unflagged one: "nothing was flagged" is not left to stand
    // for a check against two periods.
    await row(`Q4 ${E2E_YEAR}`).click();
    await expect(page.getByText(anomalyEn.cleanLimited.headline, { exact: true })).toBeVisible();
    await expect(page.getByText(/limited history \(2 periods\)/)).toBeVisible();
    await expect(page.getByText(anomalyEn.flagged.headline)).toHaveCount(0);
    await page.keyboard.press('Escape');

    // ...and in Turkish, from the catalogue: the same record, the same basis.
    await setReviewerLanguage('tr');
    await page.goto('/review');
    await row(periodsTr.values.Q3).click();
    await expect(page.getByText(anomalyTr.flagged.headline)).toBeVisible();
    await expect(page.getByText(/kısıtlı geçmişe dayanıyor \(1 dönem\)/)).toBeVisible();
    await page.keyboard.press('Escape');

    // The unflagged one too: the Turkish reviewer is told it was checked
    // against two periods, in the catalogue's words.
    await row(periodsTr.values.Q4).click();
    await expect(page.getByText(anomalyTr.cleanLimited.headline, { exact: true })).toBeVisible();
    await expect(page.getByText(/kısıtlı geçmişe dayanıyor \(2 dönem\)/)).toBeVisible();
    await expect(page.getByText(anomalyTr.flagged.headline)).toHaveCount(0);
  } finally {
    await setReviewerLanguage('en');
    // By tuple, so a record saved just before a failed step is found too.
    const ids: string[] = [];
    for (const periodValue of ['Q2', 'Q3', 'Q4']) {
      const id = await findRecordId(request, token, { ...LANE, periodValue }).catch(() => null);
      if (id) ids.push(id);
    }
    await deleteRecordsAsService(request, ids);
  }
});
