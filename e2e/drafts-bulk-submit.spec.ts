import { test, expect } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_BASE,
  bearer,
  deleteRecordsAsService,
  E2E_PERIOD as PERIOD,
  E2E_BULK_CATEGORY,
  E2E_BULK_UNIT,
  E2E_PERIOD,
  E2E_YEAR,
  ENTRY_EMAIL,
  getAccessToken,
  login,
  switchUser,
  selectSubsidiary,
  serviceReadRecords,
  SUB,
} from './helpers';

/**
 * Bulk submit from "Previous submissions" — drafts nobody imported (WP8 PR 2c).
 *
 * The unit suite owns most of the rules (`lib/bulk-submit-view.spec.ts`). What
 * only a browser can answer is whether they are WIRED:
 * that the checkbox a rule allows actually appears, that ticking it reaches
 * the endpoint, and that a rule's refusal reaches the screen as a sentence
 * rather than as a missing control with no explanation. None of that is
 * reachable from `lib/` — `vitest.config.ts` collects only `lib/**`, so the
 * component is permanently uncovered in both directions.
 *
 * Lane: `SUB.logistics` / quarterly `E2E_YEAR` / Q1, Q3 and Q4, category
 * `Waste` — the fixture-factor category, because every category the seed's
 * factor library covers is evidence-required and would be held back by the
 * very rule under test.
 *
 * Two things about that lane, stated rather than assumed. Q2 is avoided
 * deliberately: it is the period `bulk-submit-refusals` LOCKS, and a lock its
 * teardown failed to remove would fail this file for a reason that names
 * neither. And Q3/Q4 `Waste` in this subsidiary are the SAME tuples that file
 * writes — it sorts immediately before this one and clears them in its
 * `finally`, but "an earlier file cleaned up" is a dependency, not a fact, and
 * the failure it produces here is a 409 from an arrange step. So `beforeAll`
 * sweeps the lane itself, with the service role, over the exact tuples this
 * file uses.
 */
const SUBSIDIARY = SUB.logistics;
const OPTION = 'TonyAI Logistics (TR)';

test.describe.configure({ mode: 'serial' });

/** Every tuple this file writes, so the sweep below is exactly its own lane. */
const LANE_QUERY =
  `subsidiary_id=eq.${SUBSIDIARY}&reporting_year=eq.${E2E_YEAR}` +
  `&reporting_period=eq.${PERIOD}&period_value=in.(Q1,Q3,Q4)` +
  `&category=in.(${E2E_BULK_CATEGORY},Electricity)`;

test.beforeAll(async ({ request }) => {
  // Arrange from a known state rather than from another file's good behaviour.
  const strays = await serviceReadRecords(request, LANE_QUERY);
  await deleteRecordsAsService(request, strays.map((r) => String(r.id)));
});

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
    // Pushed as each is created, not after the last one: a throw on the second
    // would otherwise leave the first outside `created` and outside the
    // `finally` — a stray `Q3`/`Waste` draft that fails this file's own
    // `toHaveCount(0)` on the next run.
    const ticked = await createDraft(request, token, { periodValue: 'Q3' });
    created.push(ticked);
    const untouched = await createDraft(request, token, { periodValue: 'Q4' });
    created.push(untouched);

    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await selectSubsidiary(page, OPTION);

    const list = listOf(page);
    // The aria-label is the only stable handle on a row's checkbox, and it
    // carries the reporting entity — so ticking the wrong row is not something
    // this test can do by accident.
    await list
      // Anchored at both ends: the name carries the reporting entity, and a
      // prefix match stayed green whether this list said "Whole company" — as
      // the template and every report do — or "Whole subsidiary".
      .getByRole('checkbox', {
        name: new RegExp(`^Select Q3 ${E2E_YEAR} ${E2E_BULK_CATEGORY}, Whole company$`),
      })
      .check();
    await expect(page.locator('[data-testid="drafts-submit-bar"]')).toContainText(
      '1 selected',
    );

    await page.locator('[data-testid="drafts-submit-button"]').click();
    // The sentence this dialog exists for: there is no author-side un-submit.
    await expect(page.getByRole('dialog')).toContainText(
      /Only a reviewer can send it back/,
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

    // The row now reads Submitted — which is the assertion, not the absent
    // checkbox. While the list is refetching it renders skeletons, so
    // `toHaveCount(0)` on the checkbox is satisfied by the refetch merely being
    // IN FLIGHT: it would pass for a component that never finished, and it
    // proves nothing about the new status reaching the screen.
    await expect(
      list.locator('button').filter({ hasText: `Q3 ${E2E_YEAR}` }).filter({
        hasText: E2E_BULK_CATEGORY,
      }),
    ).toContainText('Submitted');
    await expect(
      list.getByRole('checkbox', { name: new RegExp(`Select Q3 ${E2E_YEAR}`) }),
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
    created.push(mine);
    const theirs = await createDraft(request, adminToken, { periodValue: 'Q3' });
    created.push(theirs);
    const needsInvoice = await createDraft(request, entryToken, {
      periodValue: 'Q4',
      category: 'Electricity',
      activityUnit: 'kWh',
      activityValue: 120000,
    });
    created.push(needsInvoice);

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

    // Each row is keyed on the gate that held it, not on the sentence that
    // says so: the property is that these two rows are blocked for DIFFERENT
    // reasons and each is told which. `bulk-submit-view.spec.ts` owns the
    // wording, including the author and evidence cases separately.
    await expect(row('Q3', E2E_BULK_CATEGORY)).toContainText(/entered by someone else/i);
    await expect(row('Q4', 'Electricity')).toContainText(/needs an evidence/i);
    // Not offered, not merely disabled: a disabled checkbox is unfocusable, so
    // the sentence above would never reach anyone who cannot see it.
    await expect(
      list.getByRole('checkbox', { name: new RegExp(`Select Q3 ${E2E_YEAR}`) }),
    ).toHaveCount(0);
    await expect(
      list.getByRole('checkbox', { name: new RegExp(`Select Q4 ${E2E_YEAR} Electricity`) }),
    ).toHaveCount(0);

    // "Select all" means all the ones that CAN go. Asserted on the rows rather
    // than on a count: this list is shared with every other spec that writes to
    // this subsidiary, so a number here would be measuring their leftovers too.
    const mineBox = list.getByRole('checkbox', {
      name: new RegExp(`Select Q1 ${E2E_YEAR} ${E2E_BULK_CATEGORY}`),
    });
    await expect(mineBox).not.toBeChecked();
    // Its spoken name starts with the text written beside it (WCAG 2.5.3): a
    // voice-control user says "Select all 2" and has to be understood.
    await expect(page.locator('[data-testid="drafts-select-all"]')).toHaveAccessibleName(
      /^Select all \d+: every draft you entered and can send$/,
    );
    await page.locator('[data-testid="drafts-select-all"]').click();
    await expect(mineBox).toBeChecked();
    await expect(page.locator('[data-testid="drafts-submit-bar"]')).toBeVisible();

    // The admin override permits edits/evidence, but never another author's submit.
    await switchUser(page, ADMIN_EMAIL);
    await page.goto('/data-entry');
    await selectSubsidiary(page, OPTION);
    await expect(row('Q1', E2E_BULK_CATEGORY)).toContainText(/entered by someone else/i);
    await expect(list.getByRole('checkbox', {
      name: new RegExp(`Select Q1 ${E2E_YEAR} ${E2E_BULK_CATEGORY}`),
    })).toHaveCount(0);
    await row('Q1', E2E_BULK_CATEGORY).click();
    await expect(page.getByText(`Editing draft ${mine.slice(0, 8)}` , { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit for review', exact: true })).toHaveCount(0);

    // Nothing moved: this test only looked.
    const rows = await serviceReadRecords(request, `id=in.("${theirs}","${needsInvoice}")`);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
    expect(rows).toHaveLength(2);
  } finally {
    await deleteRecordsAsService(request, created);
  }
});

test('a rejected record is not offered, and the row says to open it alone', async ({
  page,
  request,
}) => {
  // The centrepiece of the design, and until now proved only in `lib/`.
  // `rejected` is EDITABLE — the list gives it the same hover affordance a
  // draft gets — so a missing checkbox there reads as a bug rather than as the
  // deliberate exclusion it is. Resubmitting reverses a reviewer's decision,
  // and a route that would flip a thousand of them at once is not what "the
  // other half of an import" means.
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const created: string[] = [];

  try {
    const id = await createDraft(request, entryToken, { periodValue: 'Q1' });
    created.push(id);

    const submitted = await request.post(`${API_BASE}/activity-records/${id}/submit`, {
      headers: bearer(entryToken),
    });
    if (!submitted.ok()) throw new Error(`submit failed: ${submitted.status()}`);
    const rejected = await request.post(`${API_BASE}/activity-records/${id}/reject`, {
      headers: bearer(adminToken),
      data: { varianceReason: 'E2E: sent back so the row can be looked at.' },
    });
    if (!rejected.ok()) throw new Error(`reject failed: ${rejected.status()}`);

    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await selectSubsidiary(page, OPTION);

    const list = listOf(page);
    const row = list
      .locator('button')
      .filter({ hasText: `Q1 ${E2E_YEAR}` })
      .filter({ hasText: E2E_BULK_CATEGORY });
    await expect(row).toContainText('Rejected');
    await expect(row).toContainText('open it on its own, so the note gets read');
    await expect(
      list.getByRole('checkbox', { name: new RegExp(`Select Q1 ${E2E_YEAR}`) }),
    ).toHaveCount(0);
  } finally {
    await deleteRecordsAsService(request, created);
  }
});
