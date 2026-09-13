import { test, expect, type Request } from '@playwright/test';
import {
  API_BASE,
  bearer,
  deleteRecordsAsService,
  E2E_PERIOD,
  E2E_YEAR,
  ENTRY_EMAIL,
  EVIDENCE_FIXTURE,
  getAccessToken,
  login,
  selectSubsidiary,
  serviceReadRecords,
  SUB,
} from './helpers';

/**
 * Bulk submit on an EVIDENCE-REQUIRED category, with the file attached through
 * the Evidence vault on Data Entry. This is the path an Electricity or Fuel author
 * actually takes.
 *
 * No other spec walks it. `drafts-bulk-submit` sends `Waste`, the fixture-factor
 * category, precisely because it needs no file. `bulk-submit-refusals` attaches
 * evidence through the API, to a `Waste` import that would submit without it.
 *
 * The wiring under test: `evidenceCount` is a snapshot from when the list
 * loaded, and the row's checkbox reads it. `EvidenceVault.onCountChange` is the
 * only thing that updates it in place: the page patches the one row rather
 * than refetching the list. If that is unwired, attaching the invoice leaves the row
 * saying "Needs an evidence file." until something reloads it. So the test
 * pins both halves of "in place": the document never reloads, and the list is
 * never re-requested between opening the draft and the checkbox arriving.
 * Either assertion alone would let a refetch take the credit.
 *
 * Lane: `SUB.energy` / quarterly `E2E_YEAR` / Q3 / `Fuel`, whole subsidiary. No
 * other spec writes that tuple or locks that period. The Energy Q3 rows other
 * specs write are in other categories, and each deletes them in its own `finally`. The
 * anomaly rule needs three committed priors in the same series, and the only
 * quarterly Energy Fuel record any spec commits is one in `review-queue`, which
 * sorts after this file, so the rule cannot hold the submit back.
 */
const SUBSIDIARY = SUB.energy;
const OPTION = 'TonyAI Energy (TR)';
const PERIOD_VALUE = 'Q3';
const CATEGORY = 'Fuel';

test('attaching the file in the vault makes a Fuel draft sendable in place, and it sends', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const created: string[] = [];

  try {
    const res = await request.post(`${API_BASE}/activity-records`, {
      headers: bearer(token),
      data: {
        subsidiaryId: SUBSIDIARY,
        reportingYear: E2E_YEAR,
        reportingPeriod: E2E_PERIOD,
        periodValue: PERIOD_VALUE,
        category: CATEGORY,
        activityValue: 640,
        activityUnit: 'litres',
      },
    });
    if (!res.ok()) throw new Error(`create draft failed: ${res.status()} ${await res.text()}`);
    const id = (await res.json()).id as string;
    created.push(id);

    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await selectSubsidiary(page, OPTION);

    const list = page.locator('[data-testid="previous-submissions"]');
    // Period AND category: other specs leave Energy rows of their own in Q3.
    const row = list
      .locator('button')
      .filter({ hasText: `${PERIOD_VALUE} ${E2E_YEAR}` })
      .filter({ hasText: CATEGORY });
    const checkbox = list.getByRole('checkbox', {
      name: `Select ${PERIOD_VALUE} ${E2E_YEAR} ${CATEGORY}, Whole subsidiary`,
      exact: true,
    });

    // Before: held back, and the row says why. The reason is the positive
    // anchor. A zero checkbox count alone also matches a list that is still loading.
    await expect(row).toContainText('Needs an evidence file.');
    await expect(checkbox).toHaveCount(0);

    // From here until the checkbox arrives: one document, and no list request.
    await page.evaluate(() => {
      Object.assign(window, { e2eSameDocument: true });
    });
    const listRequests: string[] = [];
    const onRequest = (r: Request) => {
      if (r.method() === 'GET' && new URL(r.url()).pathname.endsWith('/activity-records')) {
        listRequests.push(r.url());
      }
    };
    page.on('request', onRequest);

    await row.click();
    await expect(page.getByText(/Editing draft/)).toBeVisible();
    // When the vault's first load lands, it reports a count of 0. Wait for it.
    // If it landed after the upload's count it would put the reason back, and
    // that race would be this test's, not the product's. The notice only renders
    // once that load has finished.
    await expect(page.getByText(/requires at least one supporting file/)).toBeVisible();

    await page.locator('[data-testid="evidence-vault-input"]').setInputFiles(EVIDENCE_FIXTURE);
    await expect(page.getByText('sample-invoice.pdf')).toBeVisible();

    // After: offered, unticked, still a draft, and the reason is gone.
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await expect(row).toContainText('Draft');
    await expect(row).not.toContainText('Needs an evidence file.');

    page.off('request', onRequest);
    expect(
      await page.evaluate(() => 'e2eSameDocument' in window),
      'the page reloaded, so the checkbox proves nothing about onCountChange',
    ).toBe(true);
    expect(
      listRequests,
      'the list was refetched, so the checkbox may have come from that rather than onCountChange',
    ).toEqual([]);

    await checkbox.check();
    const bar = page.locator('[data-testid="drafts-submit-bar"]');
    await expect(bar).toContainText('1 selected');
    await bar.getByRole('button', { name: 'Send 1 record for review', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Send 1 record for review.');
    await dialog.locator('[data-testid="drafts-submit-confirm"]').click();
    await expect(page.locator('[data-testid="drafts-submit-verdict"]')).toContainText(
      '1 record is now in the review queue.',
    );

    // Check the database, not the verdict. For Fuel, `submitted` is also the
    // server's own confirmation that the upload landed: `submit` refuses an
    // evidence-required category with no file.
    const [stored] = await serviceReadRecords(request, `id=eq.${id}`);
    expect(stored.status).toBe('submitted');
    expect(stored.submitted_at).not.toBeNull();

    // The screen agrees once the list refetches: Submitted, with nothing to tick.
    await expect(row).toContainText('Submitted');
    await expect(checkbox).toHaveCount(0);
  } finally {
    // Service role, because the API refuses to delete a submitted record. The
    // helper removes the uploaded object first: deleting the rows cascades away
    // the only record of its key.
    await deleteRecordsAsService(request, created);
  }
});
