import { test, expect } from '@playwright/test';
import enReview from '../apps/web/messages/en/review.json';
import {
  login,
  switchUser,
  bearer,
  getAccessToken,
  backdateCreatedAt,
  createCommittedRecord,
  ADMIN_EMAIL,
  APPROVER_EMAIL,
  AUDITOR_EMAIL,
  ENTRY_EMAIL,
  VIEWER_EMAIL,
  API_BASE,
  SUB,
  seenSubmittedAt,
  selectSubsidiary,
  deleteRecordsAsService,
  E2E_YEAR,
} from './helpers';

/**
 * WP7 PR 3 — the reviewer UI at `/review`.
 *
 * The rule this file exists to defend is who decides, against the real guard
 * rather than mocks: only a record's approver (`recordApprover`, INC-2.6 §1.1)
 * takes it into review, sends it back or approves it — the company's
 * super_admin for a standard user's record, the masterkey for a super_admin's
 * record (and for a company with no super_admin), and a masterkey alone for
 * its own record, as a self-approval. Nobody but a masterkey decides a record
 * they created (D01), and an auditor decides nothing. Unit tests could not
 * have caught a guard wired to the wrong role set.
 *
 * Two collision rules, both learned by breaking them: every test writes a tuple
 * (subsidiary+category+period) no other spec touches — sharing one is a 409 on
 * create and a shared anomaly baseline that trips the variance gate on submit —
 * and every row locator is scoped by SUBSIDIARY as well as period, because in a
 * full-suite run the queue also holds records other specs left behind. A row
 * matched on period alone rejected a different spec's record and left this
 * test's own record untouched.
 */

test("a super admin's record waits for the masterkey, and the masterkey's approval clears it", async ({
  page,
  request,
}) => {
  // A super_admin's record is decided by a masterkey (`recordApprover`).
  const token = await getAccessToken(request, APPROVER_EMAIL);
  // Gas·Natural Gas·Q1: Mfg's Natural Gas is `review-gate`'s whole cell, and
  // `review-queue-races` writes Q3 and Q4 here.
  const id = await createCommittedRecord(request, token, {
    subsidiaryId: SUB.gas,
    category: 'Natural Gas',
    periodValue: 'Q1',
    activityValue: 7400,
    // A committed neighbour in the lane may flag it; the reason keeps submit open.
    varianceReason: 'e2e: approval chain lane',
  });
  const gasRow = () =>
    page.locator('table tbody tr', { hasText: 'TonyAI Gas' }).filter({ hasText: 'Natural Gas' }).filter({ hasText: 'Q1 2026' });

  // The creator's default view is what awaits THEIR decision, so their own
  // record is not in it; "every pending record" shows it, with whom it awaits.
  await login(page, APPROVER_EMAIL);
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();
  await expect(page.getByTestId('review-queue-total')).not.toContainText('—');
  await expect(gasRow()).toHaveCount(0);
  await page.getByTestId('review-show-all').click();
  await expect(gasRow().getByTestId('review-row-awaits')).toHaveText(enReview.awaits.masterkey);
  await gasRow().click();
  await expect(page.getByTestId('review-sheet-own-record')).toHaveText(enReview.sheet.selfApproval);
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Return', exact: true })).toHaveCount(0);
  // Opening it took nothing into review: it is not theirs to decide.
  await expect(page.getByTestId('review-sheet-status')).toContainText('submitted');
  await page.keyboard.press('Escape');
  // ...and the API says the same, by the routing's own code.
  const own = await request.post(`${API_BASE}/activity-records/${id}/approve`, {
    headers: bearer(token),
    data: { seenSubmittedAt: await seenSubmittedAt(request, token, id) },
  });
  expect(own.status()).toBe(403);
  expect((await own.json()).code).toBe('self_approval_forbidden');

  // The masterkey's default view holds it.
  await switchUser(page, ADMIN_EMAIL);
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();

  const row = gasRow();
  await expect(row).toContainText('submitted');
  await expect(row.getByTestId('review-row-awaits')).toHaveCount(0);
  // The Waiting cell reads a real number, not an em dash. That is the whole
  // chain: the submit path stamped `submitted_at`, the DTO carried it, and the
  // column counted from it. Before the column existed this cell counted from
  // `createdAt` and was honestly headed "Age" for that reason.
  //
  // `0d` specifically — the record was submitted seconds ago. Every record that
  // reaches this queue got here through the submit path, so it always has a
  // stamp; the em-dash branch is for records the backfill could not reach, and
  // those are all `approved`, which this queue filters out.
  await expect(row).toContainText('0d');

  // THE DISCRIMINATING CASE, and the one this column exists for. Pull the
  // draft's creation a month into the past and leave the submission where it
  // is: the two answers now differ by 30 days, so a screen that quietly fell
  // back to `created_at` reads "30d" and one that reads the real stamp reads
  // "0d". Without this, every assertion above passes on both implementations,
  // because a test-created record is drafted and submitted in the same second.
  await backdateCreatedAt(request, id, 30);
  await page.reload();
  const backdated = gasRow();
  await expect(backdated).toContainText('0d');
  await expect(backdated).not.toContainText('30d');

  await backdated.click();

  // Both actors in the detail sheet, including the one nobody has filled in:
  // "not reviewed yet" is a fact about the record, and a field that appeared
  // only once populated would hide it.
  //
  // Labels only here; the VALUE is asserted in the super admin's test below
  // and in the readback at the end of this one.
  // Scoped to the sheet, not the page: renaming the queue's column header to
  // "Entered by" put a second copy of that exact string in the table head, and
  // an unscoped `getByText` is then a strict-mode violation. The same duplicate
  // -label hazard `pickByFieldLabel` already carries for the two `Unit` fields
  // on /data-entry.
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Entered by')).toBeVisible();
  await expect(sheet.getByText('Reviewed by')).toBeVisible();
  // Created AND Submitted, because they answer different questions and — on
  // this back-dated record — carry different dates. A sheet showing one value
  // against both labels would mean it is reading a single field for the pair.
  await expect(sheet.getByText('Submitted', { exact: true })).toBeVisible();
  await expect(sheet.getByText('not recorded')).toHaveCount(0);

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Record approved')).toBeVisible();

  // The queue is defined by status, so an approved record must be gone from it.
  await expect(gasRow()).toHaveCount(0);

  // Cross-check the actual state rather than trusting the screen.
  const after = await request.get(`${API_BASE}/activity-records/${id}`, {
    headers: bearer(token),
  });
  const approved = await after.json();
  expect(approved.status).toBe('approved');
  expect(approved.reviewedByName).toBe('Tony Admin');
  expect(approved.createdByName).toBe('Arda Approver');
});

test('rejecting requires a reason, and that reason reaches the submitter', async ({
  page,
  request,
}) => {
  // The admin's own record: a masterkey decides its own (`recordApprover`), so
  // the admin both enters and returns it.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createCommittedRecord(request, token, {
    // Logistics is inside the standard user's access set, so a colleague can
    // actually open the rejected record afterwards — the point of the test.
    subsidiaryId: SUB.logistics,
    category: 'Electricity',
    periodValue: 'Q3',
    activityValue: 3300,
  });

  await login(page, ADMIN_EMAIL);
  await page.goto('/review');
  await page
    .locator('table tbody tr', { hasText: 'TonyAI Logistics' })
    .filter({ hasText: 'Q3 2026' })
    .click();

  // No reason typed yet: rejecting is not offered, because a rejection with no
  // explanation tells the submitter nothing about what to fix.
  const reject = page.getByRole('button', { name: 'Return', exact: true });
  await expect(reject).toBeDisabled();

  await page.getByLabel('Reason (required to return)').fill('Invoice total does not match the meter reading');
  await expect(reject).toBeEnabled();
  await reject.click();
  await expect(page.getByText(/Record returned/)).toBeVisible();

  const after = await request.get(`${API_BASE}/activity-records/${id}`, {
    headers: bearer(token),
  });
  const record = await after.json();
  expect(record.status).toBe('rejected');
  // Written to reviewNote, NOT over the submitter's own varianceReason.
  expect(record.reviewNote).toBe('Invoice total does not match the meter reading');

  // FR §6.5 — the submitter must be able to read why it came back.
  await switchUser(page, ENTRY_EMAIL);
  await page.goto('/emissions');
  await page.getByRole('tab', { name: /History/i }).click();
  // No `.first()`: strict mode should fail loudly if a second row ever matches,
  // rather than silently deciding which record the assertion is about.
  await page
    .locator('table tbody tr', { hasText: 'TonyAI Logistics' })
    .filter({ hasText: 'Q3 2026' })
    .click();
  await expect(
    page.getByText('Invoice total does not match the meter reading'),
  ).toBeVisible();

  // The discriminating placement for `/emissions`: this drawer is open as the
  // ENTRY user on a record the ADMIN created, so the name has to be the
  // author's and not the viewer's. `/review` is covered the same way in the
  // super admin's test; this is the other screen that renders actors.
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Entered by')).toBeVisible();
  // The admin both entered and rejected this record, so the name stands twice.
  await expect(drawer.getByText('Tony Admin')).toHaveCount(2);
  // The discriminator: the VIEWER is Eda Entry, and her name must appear
  // nowhere in this drawer. Without it, an implementation rendering the
  // logged-in user rather than the record's actors would pass everything else.
  await expect(drawer.getByText('Eda Entry')).toHaveCount(0);

  // Resubmitting reverses a reviewer's decision, so it is gated on authorship.
  // This user can SEE the subsidiary but did not author the record; without the
  // gate they could make the rejection disappear while remaining forbidden from
  // editing the number — the capability has no other use.
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const byOther = await request.post(
    `${API_BASE}/activity-records/${id}/submit`,
    { headers: bearer(entryToken) },
  );
  expect(byOther.status()).toBe(403);

  // Reading why is half the loop. Until this was fixed, `submit` accepted only
  // `draft`, so a rejected record could never come back — it dropped out of the
  // inventory permanently while the test above still passed.
  const resubmit = await request.post(
    `${API_BASE}/activity-records/${id}/submit`,
    { headers: bearer(token) },
  );
  expect(resubmit.status()).toBe(200);
  const back = await resubmit.json();
  expect(back.status).toBe('submitted');
  // The note SURVIVES: it is the reviewer's only in-record signal that this
  // record has been round the loop before. Hiding it from the submitter is a
  // rendering rule, not a reason to destroy it.
  expect(back.reviewNote).toBe('Invoice total does not match the meter reading');
});

test("the company's super admin takes a standard user's record into review and approves it", async ({
  page,
  request,
}) => {
  // A standard user's record in a company with an active super_admin is that
  // super_admin's to decide (`recordApprover`). Energy·Fuel·Q1 is no other
  // spec's tuple (Q2 is the ordering test's, Q3 and Q4 `drafts-bulk-submit-evidence`'s).
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  const id = await createCommittedRecord(request, entry, {
    subsidiaryId: SUB.energy,
    category: 'Fuel',
    periodValue: 'Q1',
    activityValue: 700,
    activityUnit: 'litres',
    varianceReason: 'e2e: approval chain lane',
  });
  try {
    const record = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(entry) })).json();
    expect(record.approver).toBe('super_admin');

    await login(page, APPROVER_EMAIL);
    await page.goto('/review');
    await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();

    // In the default view: it awaits this user's decision.
    const row = page
      .locator('table tbody tr', { hasText: 'TonyAI Energy' })
      .filter({ hasText: 'Fuel' })
      .filter({ hasText: 'Q1 2026' });

    // The discriminating case for the actor column: this record was created
    // with the STANDARD USER's token and is being read by the SUPER ADMIN. So
    // the name has to be the author's, and must NOT be the viewer's.
    await expect(row).toContainText('Eda Entry');
    // The negative is only meaningful because the positive above runs first on
    // the SAME locator: `not.toContainText` passes vacuously against a locator
    // matching zero elements. Do not reorder these.
    await expect(row).not.toContainText('Arda Approver');
    await expect(row.getByTestId('review-row-awaits')).toHaveCount(0);

    await row.click();

    // Approve is offered, and neither the own-record note nor the "decided by
    // someone else" note is shown.
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(page.getByTestId('review-sheet-own-record')).toHaveCount(0);
    await expect(page.getByTestId('review-sheet-awaits')).toHaveCount(0);
    await expect(page.getByTestId('review-sheet-self-approval-note')).toHaveCount(0);

    // The sheet must carry what a decision needs: the file and the factor.
    await expect(page.getByText('sample-invoice.pdf')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText(`${record.calculation.source} v${record.calculation.version}`);

    // Opening it took it into review (WP5): no button, no toast — the status is the news.
    await expect(page.getByTestId('review-sheet-status')).toContainText('under review');
    await expect(page.getByRole('button', { name: 'Start review' })).toHaveCount(0);

    // `review` leaves the record PENDING, so it must stay in the queue and
    // change status, with its author still named (the write response is
    // spliced straight into the row, and once omitted the names).
    await expect(row).toBeVisible();
    await expect(row).toContainText('under review');
    await expect(row).toContainText('Eda Entry');

    const mid = await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(entry) });
    expect((await mid.json()).status).toBe('under_review');

    // The super admin then approves it from the same sheet; the queue, defined
    // by status, drops it, and the stored record names them as reviewer.
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText('Record approved')).toBeVisible();
    await expect(row).toHaveCount(0);
    const after = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(entry) })).json();
    expect(after.status).toBe('approved');
    expect(after.reviewedByName).toBe('Arda Approver');
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('the queue is ordered by longest WAIT, not by oldest draft', async ({ page, request }) => {
  // Asserted on two records this test creates, in a known order, so it holds
  // whether or not other specs have left rows behind. Reversing the sort left
  // the suite green before this existed.
  //
  // The back-dating is what makes it discriminating. Both records are created
  // and submitted back-to-back, so `created_at` order and `submitted_at` order
  // are IDENTICAL — a version of this test without it passes whichever field
  // the queue sorts on, which is exactly what it did before the column moved.
  // Pulling the SECOND record's draft a year into the past inverts the two
  // orders against each other: sorted by draft age it comes first, sorted by
  // wait it comes last. Only one of those is the queue this screen claims.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await createCommittedRecord(request, token, {
    subsidiaryId: SUB.trading,
    category: 'Natural Gas',
    periodValue: 'Q2',
    activityValue: 1200,
    activityUnit: 'm3',
  });
  const draftedLongAgo = await createCommittedRecord(request, token, {
    subsidiaryId: SUB.energy,
    category: 'Fuel',
    periodValue: 'Q2',
    activityValue: 800,
    activityUnit: 'litres',
  });
  await backdateCreatedAt(request, draftedLongAgo, 365);

  await login(page, ADMIN_EMAIL);
  await page.goto('/review');
  const rows = page.locator('table tbody tr');

  // Wait for the TWO ROWS THIS TEST ASSERTS ON, not merely for "a row".
  //
  // `allInnerTexts()` does NOT auto-wait — it reads every current match once
  // and never retries — so `expect(rows.first()).toBeVisible()` followed by a
  // bulk read is a race: the first row can be on screen while the rest of the
  // queue is still being committed, and the read then returns a set these
  // records are not in yet. It is the only `allInnerTexts()` in the suite.
  //
  // It cost two CI runs to see, because the failure LOOKS impossible: the
  // error-context snapshot, captured after the assertion, shows both rows
  // present, so the page was right and only the moment of reading was wrong.
  // Being ordered by wait is the property under test, so the rows have to be
  // there before the order is read.
  const rowFor = (category: string) =>
    rows.filter({ hasText: category }).filter({ hasText: 'Q2 2026' });
  await expect(rowFor('Natural Gas')).toHaveCount(1);
  await expect(rowFor('Fuel')).toHaveCount(1);

  const text = await rows.allInnerTexts();
  const waitedLonger = text.findIndex((t) => t.includes('Natural Gas') && t.includes('Q2 2026'));
  const draftedEarlier = text.findIndex((t) => t.includes('Fuel') && t.includes('Q2 2026'));
  expect(waitedLonger).toBeGreaterThanOrEqual(0);
  // The year-old DRAFT sorts BELOW the record that has actually waited longer.
  // Sorting on `createdAt` would put it on top, which is the misstatement this
  // column was introduced to end — moved out of the number and into the order.
  expect(draftedEarlier).toBeGreaterThan(waitedLonger);
  // ...and it says so: a year-old draft submitted seconds ago has waited 0 days.
  expect(text[draftedEarlier]).toContain('0d');
  expect(text[draftedEarlier]).not.toContain('365d');
});

test("the API decides who approves: the record's approver, with the submission seen; an auditor, the masterkey and the author no", async ({
  request,
}) => {
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const superAdmin = await getAccessToken(request, APPROVER_EMAIL);
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  // Logistics·Water·Q3: no other spec's tuple. Water is evidence-required and
  // priced by no factor, so nothing in the lane can flag it.
  const id = await createCommittedRecord(request, entry, {
    subsidiaryId: SUB.logistics,
    category: 'Water',
    periodValue: 'Q3',
    activityValue: 120,
    activityUnit: 'cubic_metres',
    varianceReason: 'e2e: approval chain lane',
  });
  try {
    const approveAs = (token: string, data?: Record<string, unknown>) =>
      request.post(`${API_BASE}/activity-records/${id}/approve`, { headers: bearer(token), data });
    const seen = async () => ({ seenSubmittedAt: await seenSubmittedAt(request, admin, id) });

    // Both auditors (a former consultant and a former executive viewer) read
    // it and are refused on the role, before anything else.
    for (const email of [AUDITOR_EMAIL, VIEWER_EMAIL]) {
      const auditor = await getAccessToken(request, email);
      const byAuditor = await approveAs(auditor, await seen());
      expect(byAuditor.status(), email).toBe(403);
      expect((await byAuditor.json()).message).toMatch(/Only a masterkey or a super_admin may approve records/);
      const reviewByAuditor = await request.post(`${API_BASE}/activity-records/${id}/review`, { headers: bearer(auditor), data: await seen() });
      expect(reviewByAuditor.status(), email).toBe(403);
    }
    // The author holds no decision at all.
    const byAuthor = await approveAs(entry, await seen());
    expect(byAuthor.status()).toBe(403);

    // The masterkey decides records, but not this one: Energy and Logistics
    // have an active super_admin, whose decision it is.
    const byMasterkey = await approveAs(admin, await seen());
    expect(byMasterkey.status()).toBe(403);
    const refusal = await byMasterkey.json();
    expect(refusal.code).toBe('not_record_approver');
    expect(refusal.message).toMatch(/decided by a super_admin of its company/);

    // The super admin passes the role check, so a request that names no
    // submission (a review tab from before BUG-R2-03) is `record_changed`, not 403.
    const unnamed = await approveAs(superAdmin);
    expect(unnamed.status()).toBe(409);
    expect((await unnamed.json()).code).toBe('record_changed');

    // An auditor cannot write data either: reading everything is not authoring.
    const write = await request.post(`${API_BASE}/activity-records`, {
      headers: bearer(await getAccessToken(request, AUDITOR_EMAIL)),
      data: {
        subsidiaryId: SUB.gas,
        locationId: null,
        reportingYear: 2026,
        reportingPeriod: 'quarterly',
        periodValue: 'Q4',
        category: 'Electricity',
        activityValue: 10,
        activityUnit: 'kWh',
        varianceReason: null,
        input: null,
      },
    });
    expect(write.status()).toBe(403);

    // The approver returns it; the author resubmits.
    const reject = await request.post(`${API_BASE}/activity-records/${id}/reject`, {
      headers: bearer(superAdmin),
      data: { varianceReason: 'meter reading missing', ...(await seen()) },
    });
    expect(reject.status()).toBe(200);
    expect((await reject.json()).status).toBe('rejected');
    const resubmit = await request.post(`${API_BASE}/activity-records/${id}/submit`, { headers: bearer(entry) });
    expect(resubmit.status()).toBe(200);

    // Naming the submission seen, the approver's approval goes through.
    const approved = await approveAs(superAdmin, await seen());
    expect(approved.status()).toBe(200);
    const body = await approved.json();
    expect(body.status).toBe('approved');
    expect(body.reviewedByName).toBe('Arda Approver');

    // Approving is not voiding: void stays the masterkey's.
    const voided = await request.post(`${API_BASE}/activity-records/${id}/void`, {
      headers: bearer(superAdmin),
      data: { voidReason: 'a super admin tries to withdraw' },
    });
    expect(voided.status()).toBe(403);
    const still = await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(admin) });
    expect((await still.json()).status).toBe('approved');
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

for (const [who, email] of [['a standard user', ENTRY_EMAIL], ['an auditor', AUDITOR_EMAIL]] as const) {
  test(`${who} is told the decision is not theirs, not shown a broken page`, async ({ page }) => {
    await login(page, email);
    await page.goto('/review');

    await expect(page.getByText(enReview.gate.title)).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  });
}

// ---------------------------------------------------------------------------
// WP5 (`uat4-review-resubmit`): opening a record takes it into review; a
// revised record is marked.

const reviewRow = (page: import('@playwright/test').Page, subsidiary: string, period: string, category: string) =>
  page.locator('table tbody tr', { hasText: subsidiary }).filter({ hasText: `${period} ${E2E_YEAR}` }).filter({ hasText: category });

test("a reviewer's open closes the author's recall: the refusal names the status by its label and the list is read again", async ({
  page,
  browser,
  request,
}) => {
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  const id = await createCommittedRecord(request, entry, {
    subsidiaryId: SUB.logistics,
    category: 'Electricity',
    periodValue: 'Q1',
    activityValue: 1100,
    // A committed neighbour in the lane may flag it; the reason keeps submit open.
    varianceReason: 'e2e: WP5 review lane',
  });
  try {
    // The author's list is read while the record still waits.
    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await selectSubsidiary(page, 'TonyAI Logistics (TR)');
    const list = page.locator('[data-testid="previous-submissions"]');
    const recall = list.getByRole('button', { name: `Recall Q1 ${E2E_YEAR} Electricity` });
    await expect(recall).toBeVisible();

    // Its approver, Logistics' super_admin, opens it in the review queue, in a
    // browser of their own.
    const reviewer = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
      const rp = await reviewer.newPage();
      await login(rp, APPROVER_EMAIL);
      await rp.goto('/review');
      const started = rp.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/activity-records/${id}/review`));
      await reviewRow(rp, 'TonyAI Logistics', 'Q1', 'Electricity').click();
      expect((await started).status()).toBe(200);
      await expect(rp.getByTestId('review-sheet-status')).toContainText('under review');
      await expect(reviewRow(rp, 'TonyAI Logistics', 'Q1', 'Electricity')).toContainText('under review');
  } finally {
    await reviewer.close();
  }

  // The author's recall, from the list read before: refused, worded by the label, list read again.
  const reread = page.waitForResponse((r) => r.request().method() === 'GET' && /\/activity-records\?/.test(r.url()));
  await recall.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Recall to draft' }).click();
  await expect(page.getByText(/This one is "Under review"/)).toBeVisible();
  await reread;
  await expect(list.getByRole('button', { name: `Recall Q1 ${E2E_YEAR} Electricity` })).toHaveCount(0);
  const record = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(entry) })).json();
  expect(record.status).toBe('under_review');
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('a super admin opening their own submitted record leaves it submitted, with no Start review', async ({ page, request }) => {
  // Mfg·Water·Q2: Mfg's Electricity is `gates`'s (Q1 to Q4), its Fuel
  // `void-record`'s; `roles-approval-chain` writes Water Q1 and deletes it.
  const own = await getAccessToken(request, APPROVER_EMAIL);
  const id = await createCommittedRecord(request, own, {
    subsidiaryId: SUB.mfg,
    category: 'Water',
    periodValue: 'Q2',
    activityValue: 210,
    activityUnit: 'cubic_metres',
    // A committed neighbour in the lane may flag it; the reason keeps submit open.
    varianceReason: 'e2e: WP5 review lane',
  });
  try {
    const starts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith(`/activity-records/${id}/review`)) starts.push(r.url());
    });

    await login(page, APPROVER_EMAIL);
    await page.goto('/review');
    // Not in the default view (a masterkey decides it): every pending record shows it.
    await page.getByTestId('review-show-all').click();
    const read = page.waitForResponse((r) => r.request().method() === 'GET' && r.url().endsWith(`/activity-records/${id}`));
    await reviewRow(page, 'TonyAI Manufacturing', 'Q2', 'Water').click();
    await read;
    await expect(page.getByText('You cannot approve a record you entered.')).toBeVisible();
    await expect(page.getByTestId('review-sheet-status')).toContainText('submitted');
    await expect(page.getByRole('button', { name: 'Start review' })).toHaveCount(0);
    expect(starts).toEqual([]);

    // ...and the author can still recall it.
    const recalled = await request.post(`${API_BASE}/activity-records/${id}/recall`, { headers: bearer(own) });
    expect(recalled.status()).toBe(200);
    expect((await recalled.json()).status).toBe('draft');
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('a masterkey opening their own submitted record takes it into review, told that approving it is a self-approval', async ({ page, request }) => {
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createCommittedRecord(request, admin, {
    subsidiaryId: SUB.trading,
    category: 'Electricity',
    periodValue: 'Q3',
    activityValue: 2100,
    // A committed neighbour in the lane may flag it; the reason keeps submit open.
    varianceReason: 'e2e: WP5 review lane',
  });
  try {
    const record = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(admin) })).json();
    expect(record.approver).toBe('author');

    await login(page, ADMIN_EMAIL);
    await page.goto('/review');
    // In the default view: a masterkey's own record awaits its own decision.
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/activity-records/${id}/review`));
    await reviewRow(page, 'TonyAI Trading', 'Q3', 'Electricity').click();
    expect((await started).status()).toBe(200);
    await expect(page.getByTestId('review-sheet-status')).toContainText('under review');
    await expect(page.getByTestId('review-sheet-self-approval-note')).toHaveText(enReview.sheet.selfApprovalNote);
    await expect(page.getByTestId('review-sheet-own-record')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('a recalled, edited and resubmitted record is marked Revised in the queue and on the sheet', async ({ page, request }) => {
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  const id = await createCommittedRecord(request, entry, {
    subsidiaryId: SUB.logistics,
    category: 'Electricity',
    periodValue: 'Q4',
    activityValue: 1000,
    // A committed neighbour in the lane may flag it; the reason keeps submit open.
    varianceReason: 'e2e: WP5 review lane',
  });
  try {
    const ok = async (path: string, data?: unknown, method: 'post' | 'patch' = 'post') => {
      const res = await request[method](`${API_BASE}/activity-records/${id}${path}`, { headers: bearer(entry), ...(data ? { data } : {}) });
      expect(res.ok(), await res.text()).toBe(true);
      return res.json();
    };
    await ok('/recall');
    await ok('', { activityValue: 1200 }, 'patch');
    const resubmitted = await ok('/submit');
    expect(resubmitted.submissionCount).toBe(2);

    // Its approver: Logistics' super_admin.
    await login(page, APPROVER_EMAIL);
    await page.goto('/review');
    const row = reviewRow(page, 'TonyAI Logistics', 'Q4', 'Electricity');
    await expect(row.getByTestId('revised-badge')).toHaveText('Revised');
    await expect(row.getByTestId('revised-badge')).toHaveAttribute('title', /^Submission 2/);
    await row.click();
    const sheet = page.getByTestId('review-sheet-status');
    await expect(sheet).toContainText('under review');
    await expect(sheet.getByTestId('revised-badge')).toBeVisible();
    // The sheet keeps current values only.
    await expect(page.getByRole('dialog')).toContainText('1,200');
    await expect(page.getByRole('dialog')).not.toContainText('1,000 kWh');
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('a start of review that fails for another reason keeps the sheet usable, with the fallback button', async ({ page, request }) => {
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  const id = await createCommittedRecord(request, entry, {
    subsidiaryId: SUB.logistics,
    category: 'Electricity',
    periodValue: 'Q1',
    activityValue: 1150,
    varianceReason: 'e2e: WP5 review lane',
  });
  try {
    const REVIEW = `**/api/v1/activity-records/${id}/review`;
    await page.route(REVIEW, (route) => route.abort('connectionfailed'));
    // Counted as the page sees it: the start the open sends, failed.
    let failedStarts = 0;
    page.on('requestfailed', (r) => {
      if (r.method() === 'POST' && r.url().endsWith(`/activity-records/${id}/review`)) failedStarts += 1;
    });
    // Its approver: Logistics' super_admin.
    await login(page, APPROVER_EMAIL);
    await page.goto('/review');
    await reviewRow(page, 'TonyAI Logistics', 'Q1', 'Electricity').click();
    const sheet = page.getByRole('dialog');
    // The reviewer is told, and nothing is taken away: Start review, Return and Approve.
    const start = sheet.getByTestId('review-sheet-start-review');
    await expect(start).toBeVisible();
    await expect.poll(() => failedStarts).toBe(1);
    await expect(sheet.getByTestId('review-sheet-status')).toContainText('submitted');
    await expect(sheet.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
    await expect(sheet.getByRole('button', { name: 'Return', exact: true })).toBeVisible();

    // Once the network is back, the fallback takes it into review.
    await page.unroute(REVIEW);
    await start.click();
    await expect(page.getByText('Taken into review')).toBeVisible();
    await expect(sheet.getByTestId('review-sheet-status')).toContainText('under review');
    await expect(start).toHaveCount(0);
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});
