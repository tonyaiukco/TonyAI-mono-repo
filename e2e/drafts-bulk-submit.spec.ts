import { test, expect } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_BASE,
  bearer,
  deleteRecordsAsService,
  E2E_BULK_CATEGORY,
  E2E_BULK_UNIT,
  E2E_PERIOD,
  E2E_YEAR,
  ENTRY_EMAIL,
  getAccessToken,
  login,
  selectSubsidiary,
  serviceReadRecords,
  SUB,
} from './helpers';

/**
 * Bulk submit from "Previous submissions" — drafts nobody imported (WP8 PR 2c).
 *
 * The unit suite owns the rules (`lib/bulk-submit-view.spec.ts`, seven fatal
 * mutations). What only a browser can answer is whether the rules are WIRED:
 * that the checkbox a rule allows actually appears, that ticking it reaches
 * the endpoint, and that a rule's refusal reaches the screen as a sentence
 * rather than as a missing control with no explanation. None of that is
 * reachable from `lib/` — `vitest.config.ts` collects only `lib/**`, so the
 * component is permanently uncovered in both directions.
 *
 * Lane: `SUB.logistics` / quarterly `E2E_YEAR` / Q1, Q3 and Q4, category
 * `Waste` — the fixture-factor category, because every category the seed's
 * factor library covers is evidence-required and would be held back by the
 * very rule under test. Q2 is avoided deliberately: that is the period
 * `bulk-submit-refusals` LOCKS, and a lock its teardown failed to remove would
 * fail this file for a reason that names neither.
 */
const SUBSIDIARY = SUB.logistics;
const OPTION = 'TonyAI Logistics (TR)';

test.describe.configure({ mode: 'serial' });

async function createDraft(
  request: Parameters<typeof serviceReadRecords>[0],
  token: string,
  over: {
    periodValue: string;
    category?: string;
    activityUnit?: string;
    activityValue?: number;
  },
): Promise<string> {
  const res = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUBSIDIARY,
      reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD,
      periodValue: over.periodValue,
      category: over.category ?? E2E_BULK_CATEGORY,
      activityValue: over.activityValue ?? 3,
      activityUnit: over.activityUnit ?? E2E_BULK_UNIT,
    },
  });
  if (!res.ok()) throw new Error(`createDraft failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).id as string;
}

/** The card, scoped — `page.locator('button')` on this page reaches the form,
 *  the vault and the import panel as well. */
const listOf = (page: Parameters<typeof login>[0]) =>
  page.locator('[data-testid="previous-submissions"]');

test('sends the drafts that were ticked, and leaves the rest a draft', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const created: string[] = [];

  try {
    const ticked = await createDraft(request, token, { periodValue: 'Q3' });
    const untouched = await createDraft(request, token, { periodValue: 'Q4' });
    created.push(ticked, untouched);

    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await selectSubsidiary(page, OPTION);

    const list = listOf(page);
    // The aria-label is the only stable handle on a row's checkbox, and it
    // carries the reporting entity — so ticking the wrong row is not something
    // this test can do by accident.
    await list
      .getByRole('checkbox', { name: `Select Q3 ${E2E_YEAR} ${E2E_BULK_CATEGORY}` })
      .check();
    await expect(page.locator('[data-testid="drafts-submit-bar"]')).toContainText(
      '1 selected',
    );

    await page.locator('[data-testid="drafts-submit-button"]').click();
    // The sentence this dialog exists for: there is no author-side un-submit.
    await expect(page.getByRole('dialog')).toContainText(
      /Only a reviewer can send them back/,
    );
    await page.locator('[data-testid="drafts-submit-confirm"]').click();

    await expect(page.locator('[data-testid="drafts-submit-verdict"]')).toContainText(
      /now in the review queue/i,
    );

    // The database, not the verdict. A screen that reported a submit it never
    // made would look identical here.
    const rows = await serviceReadRecords(request, `id=in.("${ticked}","${untouched}")`);
    const byId = Object.fromEntries(rows.map((r) => [String(r.id), r]));
    expect(byId[ticked].status).toBe('submitted');
    expect(byId[ticked].submitted_at).not.toBeNull();
    // The half that makes the first half mean something: selection is a
    // selection, not "everything on screen".
    expect(byId[untouched].status).toBe('draft');
    expect(byId[untouched].submitted_at).toBeNull();

    // And the row that moved loses its checkbox, because the list refetched.
    await expect(
      list.getByRole('checkbox', { name: `Select Q3 ${E2E_YEAR} ${E2E_BULK_CATEGORY}` }),
    ).toHaveCount(0);
  } finally {
    await deleteRecordsAsService(request, created);
  }
});

test('a draft you cannot send has no checkbox, and the row says why', async ({
  page,
  request,
}) => {
  // The whole point of mirroring the server's gates client-side: a checkbox
  // that would come back refused is never offered, and a missing checkbox is
  // never left unexplained.
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const created: string[] = [];

  try {
    const mine = await createDraft(request, entryToken, { periodValue: 'Q1' });
    const theirs = await createDraft(request, adminToken, { periodValue: 'Q3' });
    const needsInvoice = await createDraft(request, entryToken, {
      periodValue: 'Q4',
      category: 'Electricity',
      activityUnit: 'kWh',
      activityValue: 120000,
    });
    created.push(mine, theirs, needsInvoice);

    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await selectSubsidiary(page, OPTION);

    const list = listOf(page);
    // Period AND category: this list shows every record in the subsidiary, and
    // other specs write their own rows here in other categories. A row locator
    // that matched two of them is a strict-mode failure rather than an
    // assertion.
    const row = (periodValue: string, category: string) =>
      list
        .locator('button')
        .filter({ hasText: `${periodValue} ${E2E_YEAR}` })
        .filter({ hasText: category });

    await expect(row('Q3', E2E_BULK_CATEGORY)).toContainText('Entered by someone else.');
    await expect(row('Q4', 'Electricity')).toContainText('Needs an evidence file.');
    // Not offered, not merely disabled: a disabled checkbox is unfocusable, so
    // the sentence above would never reach anyone who cannot see it.
    await expect(
      list.getByRole('checkbox', { name: `Select Q3 ${E2E_YEAR} ${E2E_BULK_CATEGORY}` }),
    ).toHaveCount(0);
    await expect(
      list.getByRole('checkbox', { name: `Select Q4 ${E2E_YEAR} Electricity` }),
    ).toHaveCount(0);

    // "Select all" means all the ones that CAN go. Asserted on the rows rather
    // than on a count: this list is shared with every other spec that writes to
    // this subsidiary, so a number here would be measuring their leftovers too.
    const mineBox = list.getByRole('checkbox', {
      name: `Select Q1 ${E2E_YEAR} ${E2E_BULK_CATEGORY}`,
    });
    await expect(mineBox).not.toBeChecked();
    await page.locator('[data-testid="drafts-select-all"]').click();
    await expect(mineBox).toBeChecked();
    await expect(page.locator('[data-testid="drafts-submit-bar"]')).toBeVisible();

    // Nothing moved: this test only looked.
    const rows = await serviceReadRecords(request, `id=in.("${theirs}","${needsInvoice}")`);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
    expect(rows).toHaveLength(2);
  } finally {
    await deleteRecordsAsService(request, created);
  }
});
