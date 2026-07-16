import { test, expect } from '@playwright/test';
import {
  login,
  pickByFieldLabel,
  selectSubsidiary,
  ADMIN_EMAIL,
  EVIDENCE_FIXTURE,
  getAccessToken,
  createCommittedRecord,
  lockPeriod,
  SUB,
} from './helpers';

/**
 * The three submit/write gates surfaced in the UI (each unit-tested at the
 * service layer; here we prove the page enforces + toasts them). Each gate uses
 * its own subsidiary so tuples and anomaly baselines never overlap.
 */

async function selectScope(page: import('@playwright/test').Page, subsidiaryOption: string, periodValue: string) {
  await selectSubsidiary(page, subsidiaryOption);
  if (periodValue !== 'Q1') await pickByFieldLabel(page, 'Value', periodValue);
}

test('gate: evidence-required category blocks submit until a file is attached', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');

  // Gas (UK) · Electricity · Q1 — evidence-required, no baseline.
  await selectScope(page, 'TonyAI Gas (UK)', 'Q1');
  await page.getByPlaceholder('e.g. 45000').fill('8000');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();

  // Submit without uploading evidence → API 400, surfaced as a toast.
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText(/requires at least one evidence file/i)).toBeVisible();
});

test('gate: anomalous value shows the banner and blocks submit without a variance comment', async ({
  page,
  request,
}) => {
  // Arrange a baseline via the API: two committed quarterly priors at a normal value.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await createCommittedRecord(request, token, {
    subsidiaryId: SUB.mfg,
    category: 'Electricity',
    periodValue: 'Q1',
    activityValue: 10_000,
  });
  await createCommittedRecord(request, token, {
    subsidiaryId: SUB.mfg,
    category: 'Electricity',
    periodValue: 'Q2',
    activityValue: 10_000,
  });

  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');

  // Mfg (EU) · Electricity · Q3 with a value ~50× the baseline → anomalous.
  await selectScope(page, 'TonyAI Mfg (EU)', 'Q3');
  await page.getByPlaceholder('e.g. 45000').fill('500000');
  await page.getByRole('button', { name: 'Save draft' }).click();

  // Anomaly banner + mandatory variance field appear.
  await expect(page.getByText(/deviates significantly from the historical average/i)).toBeVisible();
  const variance = page.getByLabel('Reason for variance *');
  await expect(variance).toBeVisible();

  // Attach evidence (Electricity is evidence-required) so only the anomaly gate remains.
  await page.locator('input[type="file"]').setInputFiles(EVIDENCE_FIXTURE);
  await expect(page.getByText('Evidence uploaded')).toBeVisible();

  // Submit with an empty variance → blocked by the client anomaly guard.
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText(/looks anomalous — add a variance comment/i)).toBeVisible();

  // Provide the variance, resubmit → succeeds.
  await variance.fill('New production line commissioned this quarter.');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Submitted for review')).toBeVisible();
});

test('gate: a locked reporting period rejects new records', async ({ page, request }) => {
  // Lock Trading (UK) · Electricity space by locking the Q1 period (empty → allowed).
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await lockPeriod(request, token, { subsidiaryId: SUB.trading, periodValue: 'Q1' });

  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');

  await selectScope(page, 'TonyAI Trading (UK)', 'Q1');
  await page.getByPlaceholder('e.g. 45000').fill('4000');
  // Save draft → create blocked by the period-lock gate (409), surfaced as a toast.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(/is locked/i)).toBeVisible();
});
