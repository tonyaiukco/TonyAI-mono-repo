import { test, expect } from '@playwright/test';
import {
  login,
  switchUser,
  bearer,
  getAccessToken,
  backdateCreatedAt,
  createCommittedRecord,
  ADMIN_EMAIL,
  APPROVER_EMAIL,
  CONSULTANT_EMAIL,
  ENTRY_EMAIL,
  API_BASE,
  SUB,
} from './helpers';

/**
 * WP7 PR 3 — the reviewer UI at `/review`.
 *
 * The rule this file exists to defend is the one that was previously asserted
 * only against mocks: a consultant may take a record into review and send it
 * back, but may NOT approve it. Until the seed grew a consultant user there was
 * no way to exercise that branch against the real guard, so "review-only" rested
 * entirely on unit tests that could not have caught a guard wired to the wrong
 * role set.
 *
 * Two collision rules, both learned by breaking them: every test writes a tuple
 * (subsidiary+category+period) no other spec touches — sharing one is a 409 on
 * create and a shared anomaly baseline that trips the variance gate on submit —
 * and every row locator is scoped by SUBSIDIARY as well as period, because in a
 * full-suite run the queue also holds records other specs left behind. A row
 * matched on period alone rejected a different spec's record and left this
 * test's own record untouched.
 */

test('a submitted record reaches the queue and approving clears it', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createCommittedRecord(request, token, {
    subsidiaryId: SUB.trading,
    category: 'Natural Gas',
    periodValue: 'Q4',
    activityValue: 7400,
  });

  // The OTHER super_admin reviews it: nobody approves a record they created
  // (D01), and the API refuses the creator's Approve with a 403.
  await login(page, APPROVER_EMAIL);
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();

  const row = page
    .locator('table tbody tr', { hasText: 'TonyAI Trading' })
    .filter({ hasText: 'Q4 2026' });
  await expect(row).toContainText('submitted');
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
  const backdated = page
    .locator('table tbody tr', { hasText: 'TonyAI Trading' })
    .filter({ hasText: 'Q4 2026' });
  await expect(backdated).toContainText('0d');
  await expect(backdated).not.toContainText('30d');

  await backdated.click();

  // Both actors in the detail sheet, including the one nobody has filled in:
  // "not reviewed yet" is a fact about the record, and a field that appeared
  // only once populated would hide it.
  //
  // Labels only here; the VALUE is asserted in the consultant test below. (The
  // viewer used to BE the creator, which made a value assertion unable to tell
  // "shows the record's author" from "shows whoever is logged in".)
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
  await expect(sheet.getByText('Submitted')).toBeVisible();
  await expect(sheet.getByText('not recorded')).toHaveCount(0);

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Record approved')).toBeVisible();

  // The queue is defined by status, so an approved record must be gone from it.
  await expect(
    page
      .locator('table tbody tr', { hasText: 'TonyAI Trading' })
      .filter({ hasText: 'Q4 2026' }),
  ).toHaveCount(0);

  // Cross-check the actual state rather than trusting the screen.
  const after = await request.get(`${API_BASE}/activity-records/${id}`, {
    headers: bearer(token),
  });
  expect((await after.json()).status).toBe('approved');
});

test('rejecting requires a reason, and that reason reaches the submitter', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createCommittedRecord(request, token, {
    // Logistics is inside the data_entry user's access set, so the submitter can
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
  const reject = page.getByRole('button', { name: 'Reject' });
  await expect(reject).toBeDisabled();

  await page.getByLabel('Reason (required to reject)').fill('Invoice total does not match the meter reading');
  await expect(reject).toBeEnabled();
  await reject.click();
  await expect(page.getByText(/Record rejected/)).toBeVisible();

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
  // consultant test; this is the other screen that renders actors.
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

test('a consultant may send a record back but is not offered Approve', async ({
  page,
  request,
}) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createCommittedRecord(request, token, {
    subsidiaryId: SUB.gas,
    category: 'Natural Gas',
    periodValue: 'Q1',
    activityValue: 5200,
    activityUnit: 'm3',
  });

  await login(page, CONSULTANT_EMAIL);
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();

  const row = page
    .locator('table tbody tr', { hasText: 'TonyAI Gas' })
    .filter({ hasText: 'Natural Gas' })
    .filter({ hasText: 'Q1 2026' });

  // The discriminating case for the actor column: this record was created with
  // the ADMIN's token and is being read by the CONSULTANT. So the name has to
  // be the author's, and must NOT be the viewer's — an implementation that
  // rendered the logged-in user would be indistinguishable from a correct one
  // in the two tests above, where the viewer is also the creator.
  await expect(row).toContainText('Tony Admin');
  // The negative is only meaningful because the positive above runs first on
  // the SAME locator: `not.toContainText` passes vacuously against a locator
  // matching zero elements. Do not reorder these.
  await expect(row).not.toContainText('Cem Consultant');

  await row.click();

  // The control a consultant may not use is absent, and the page says why
  // rather than leaving its absence to be read as a bug.
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  await expect(page.getByText(/Approval is reserved for a super_admin/)).toBeVisible();

  // The sheet must carry what a decision needs. Both of these were implemented
  // and asserted by nothing — removing either left the suite green.
  await expect(page.getByText('sample-invoice.pdf')).toBeVisible();
  await expect(page.getByText(/prototype demo factors.*v2026\.1/)).toBeVisible();

  await page.getByRole('button', { name: 'Start review' }).click();
  await expect(page.getByText('Taken into review')).toBeVisible();

  // `review` leaves the record PENDING, so it must stay in the queue and change
  // status. Dropping it instead also passed before this assertion existed —
  // a reviewer would have watched a record they had merely opened vanish.
  await expect(row).toBeVisible();
  await expect(row).toContainText('under review');
  // ...and the author is STILL named. This is the exact click at which the
  // actor column emptied: `review` leaves the record pending, so the write
  // response is spliced straight into the row, and while the name fields were
  // optional that response omitted them — the column fell back to an em dash on
  // the very action that made this consultant the reviewer. Three review seats
  // found it independently; the fields are required now, so there is no shape
  // a write path can forget to fill.
  await expect(row).toContainText('Tony Admin');

  const mid = await request.get(`${API_BASE}/activity-records/${id}`, {
    headers: bearer(token),
  });
  expect((await mid.json()).status).toBe('under_review');
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
    subsidiaryId: SUB.energy,
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

test('the API — not the UI — is what stops a consultant approving', async ({
  request,
}) => {
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const consultant = await getAccessToken(request, CONSULTANT_EMAIL);
  const id = await createCommittedRecord(request, admin, {
    subsidiaryId: SUB.gas,
    category: 'Fuel',
    periodValue: 'Q1',
    activityValue: 900,
    activityUnit: 'litres',
  });

  // Hiding the button is a courtesy; this is the actual boundary.
  const approve = await request.post(`${API_BASE}/activity-records/${id}/approve`, {
    headers: bearer(consultant),
  });
  expect(approve.status()).toBe(403);

  // Still 403 once the record is under review — the refusal is about the role,
  // not about the record being in the wrong state.
  const review = await request.post(`${API_BASE}/activity-records/${id}/review`, {
    headers: bearer(consultant),
  });
  expect(review.status()).toBe(200);
  const approveAgain = await request.post(
    `${API_BASE}/activity-records/${id}/approve`,
    { headers: bearer(consultant) },
  );
  expect(approveAgain.status()).toBe(403);

  // And a consultant cannot write data either (review-only, decision 2026-07-30).
  const write = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(consultant),
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

  const reject = await request.post(`${API_BASE}/activity-records/${id}/reject`, {
    headers: bearer(consultant),
    data: { varianceReason: 'meter reading missing' },
  });
  expect(reject.status()).toBe(200);
  expect((await reject.json()).status).toBe('rejected');
});

test('data_entry is told the decision is not theirs, not shown a broken page', async ({
  page,
}) => {
  await login(page, ENTRY_EMAIL);
  await page.goto('/review');

  await expect(
    page.getByText(/Reviewing is done by a consultant or a super_admin/i),
  ).toBeVisible();
  await expect(page.locator('table')).toHaveCount(0);
});
