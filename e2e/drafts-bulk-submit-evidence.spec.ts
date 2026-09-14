import { test, expect, type APIRequestContext, type Request } from '@playwright/test';
import { WHOLE_COMPANY_ENTITY_LABEL } from '@tonyai/shared-types';
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
 * only thing that updates it in place. The page writes the vault's count onto the
 * one row being edited rather than refetching. If that is unwired, attaching the
 * invoice leaves the row saying "Needs an evidence file." until something
 * reloads it. The test pins each part of that sentence:
 * - The vault's count, not a constant: the draft is still held back after the
 *   vault's first load reports 0.
 * - The one row: a second Fuel draft, which never gets a file, stays held back.
 * - In place: the document never reloads, and neither the list nor the record
 *   is re-requested between opening the draft and the checkbox arriving.
 *   Either check alone would let a refetch take the credit.
 *
 * Lane: `SUB.energy` / quarterly `E2E_YEAR` / `Fuel`, whole subsidiary. Q3 is
 * the draft that gets the file; Q4 is the one that does not. No other spec
 * writes either tuple or holds a lock on either period (`rbac-tenant` tries to
 * lock Energy Q4 as data_entry and is refused). The other Energy Q3/Q4 rows are
 * in other categories, and the specs that write them also delete them. The anomaly
 * rule needs three committed priors in the same series, and a draft never
 * counts. The only quarterly Energy Fuel record any spec commits belongs to
 * `review-queue`, which runs after this file, so the rule cannot hold the
 * submit back.
 */
const SUBSIDIARY = SUB.energy;
const OPTION = 'TonyAI Energy (TR)';
const CATEGORY = 'Fuel';
/** The draft that gets the file, and is sent. */
const ATTACHED = 'Q3';
/** The draft that never gets a file. */
const UNATTACHED = 'Q4';
/** The list's GET, or one record's. Nothing else on this page requests either. */
const RECORDS_PATH = /\/activity-records(\/[0-9a-f-]{36})?$/;

async function createDraft(
  request: APIRequestContext,
  token: string,
  periodValue: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUBSIDIARY,
      reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD,
      periodValue,
      category: CATEGORY,
      activityValue: 640,
      activityUnit: 'litres',
    },
  });
  if (!res.ok()) throw new Error(`createDraft failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).id as string;
}

test('attaching the file in the vault makes a Fuel draft sendable in place, and it sends', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const created: string[] = [];

  try {
    // Each id is pushed as soon as it exists, so a throw on the second create still cleans up the first.
    const id = await createDraft(request, token, ATTACHED);
    created.push(id);
    created.push(await createDraft(request, token, UNATTACHED));

    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await selectSubsidiary(page, OPTION);

    const list = page.locator('[data-testid="previous-submissions"]');
    // Period AND category: other specs leave Energy rows of their own in Q3 and Q4.
    const rowFor = (periodValue: string) =>
      list
        .locator('button')
        .filter({ hasText: `${periodValue} ${E2E_YEAR}` })
        .filter({ hasText: CATEGORY });
    // The entity comes from the constant the list renders. This name used to say
    // "Whole subsidiary". When #104 renamed the label, every `toHaveCount(0)` below
    // kept passing on a name nothing carried, and the checkbox check failed as
    // "not found", which is also how an unwired `onCountChange` fails.
    const checkboxFor = (periodValue: string) =>
      list.getByRole('checkbox', {
        name: `Select ${periodValue} ${E2E_YEAR} ${CATEGORY}, ${WHOLE_COMPANY_ENTITY_LABEL}`,
        exact: true,
      });
    // Held back, with the row saying why. The reason is the positive anchor,
    // because a zero checkbox count on its own also matches a list still loading.
    const expectHeldBack = async (periodValue: string) => {
      await expect(rowFor(periodValue)).toContainText('Needs an evidence file.');
      await expect(checkboxFor(periodValue)).toHaveCount(0);
    };
    const row = rowFor(ATTACHED);
    const checkbox = checkboxFor(ATTACHED);

    await expectHeldBack(ATTACHED);
    await expectHeldBack(UNATTACHED);

    // From here until the checkbox arrives: one document, and no records request.
    await page.evaluate(() => {
      Object.assign(window, { e2eSameDocument: true });
    });
    const recordRequests: string[] = [];
    const onRequest = (r: Request) => {
      if (r.method() === 'GET' && RECORDS_PATH.test(new URL(r.url()).pathname)) {
        recordRequests.push(r.url());
      }
    };
    page.on('request', onRequest);

    await row.click();
    await expect(page.getByText(/Editing draft/)).toBeVisible();
    // The notice appears in the same render that applies the vault's first load:
    // `setFiles`, `onCountChange` and `setLoading(false)` run back to back and
    // React batches them. So by now the row carries the count that load
    // reported (0), and a patch that wrote any other value would already show a
    // checkbox. Waiting here also stops that load from landing after the
    // upload's count. (`next dev` runs the first load twice under StrictMode,
    // and both runs report 0.)
    await expect(page.getByText(/requires at least one supporting file/)).toBeVisible();
    await expectHeldBack(ATTACHED);

    await page.locator('[data-testid="evidence-vault-input"]').setInputFiles(EVIDENCE_FIXTURE);
    await expect(page.getByText('sample-invoice.pdf')).toBeVisible();

    // After: the reason is gone, and the row is offered, unticked and still a draft.
    // The reason is checked first. One `selectableDrafts` pass decides both the
    // reason and the checkbox, so a failure on the reason means the vault's count
    // never reached the row. A failure on the checkbox after it means the locator
    // no longer names the row's checkbox.
    await expect(row).not.toContainText('Needs an evidence file.');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
    await expect(row).toContainText('Draft');
    // Only that row changed. The other draft has no file and must still be held back.
    await expectHeldBack(UNATTACHED);

    page.off('request', onRequest);
    expect(
      await page.evaluate(() => 'e2eSameDocument' in window),
      'the page reloaded, so the checkbox proves nothing about onCountChange',
    ).toBe(true);
    expect(
      recordRequests,
      'records were re-requested, so the checkbox may have come from that rather than onCountChange',
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

    // Check the database, not the verdict. For Fuel, `submitted` also confirms
    // the upload landed on the server, because `submit` refuses an
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
