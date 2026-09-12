import { test, expect } from '@playwright/test';
import {
  login,
  selectSubsidiary,
  ADMIN_EMAIL,
  EVIDENCE_FIXTURE,
  getAccessToken,
  findRecordId,
  approveRecord,
  SUB,
} from './helpers';

/**
 * The end-to-end demo flow (Phase-1 exit gate rehearsal): a super_admin enters
 * activity data, sees a live tCO₂e preview, saves a draft, attaches the required
 * evidence, submits, then approves it (via the API — the UI path is covered
 * by `review-queue.spec.ts`) and
 * the record shows as Approved. Uses TonyAI Energy · Electricity · 2026 · Q1 —
 * an unseeded quarterly tuple with no baseline, so nothing is flagged anomalous.
 */
test('data entry: draft → live preview → evidence → submit → approve → visible', async ({
  page,
  request,
}) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');

  // Reporting scope: Energy (TR) · Electricity · 2026 · quarterly · Q1 (defaults
  // already are Electricity / 2026 / Quarterly / Q1 / kWh).
  await selectSubsidiary(page, 'TonyAI Energy (TR)');

  // Activity value → live preview (the "Emission factor" row only renders on a
  // successful calculation).
  await page.getByPlaceholder('e.g. 45000').fill('12500');
  await expect(page.getByText('Emission factor')).toBeVisible();

  // Save draft — the evidence vault appears once the record has an id.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();

  // "No baseline" is stated, not left blank. This spec's own header names the
  // condition — an unseeded quarterly tuple — and until WP21 the screen showed
  // NOTHING for it, which reads as "checked, fine" about a value the rule never
  // ran on. Neutral, not the amber anomaly banner: a short window is the normal
  // state of a new series, and the two must not look alike.
  await expect(page.getByText('Not checked for anomalies')).toBeVisible();
  await expect(
    page.getByText(/no earlier committed period exists for this reporting entity/i),
  ).toBeVisible();
  await expect(page.getByLabel('Reason for variance *')).toHaveCount(0);

  // Attach the required evidence (hidden file input under the vault).
  // Scoped to the vault: the page now also carries the bulk-import input, and
  // a bare `input[type="file"]` matches both, which is a strict-mode failure.
  await page
    .locator('[data-testid="evidence-vault-input"]')
    .setInputFiles(EVIDENCE_FIXTURE);
  await expect(page.getByText('Evidence uploaded')).toBeVisible();
  await expect(page.getByText('sample-invoice.pdf')).toBeVisible();

  // Submit for review.
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Submitted for review')).toBeVisible();

  // Approve via the API (super_admin; no UI path exists for approval).
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await findRecordId(request, token, {
    subsidiaryId: SUB.energy,
    category: 'Electricity',
    periodValue: 'Q1',
  });
  await approveRecord(request, token, id);

  // Reload, re-select Energy (the page defaults to the first subsidiary), and
  // confirm the record now reads as Approved in Previous submissions. Scope to
  // the single Q1 2026 row — addressed by role now that a submission row is a
  // real button (it reopens the record), not a styled div. A
  // seeded "Approved" elsewhere on the page can't satisfy this — the badge must
  // be in the same row as our record.
  await page.reload();
  await selectSubsidiary(page, 'TonyAI Energy (TR)');
  const row = page.getByRole('button', { name: /Q1 2026/ });
  await expect(row).toContainText('Approved');
});
