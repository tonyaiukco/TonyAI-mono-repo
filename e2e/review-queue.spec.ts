import { test, expect } from '@playwright/test';
import {
  login,
  switchUser,
  bearer,
  getAccessToken,
  createCommittedRecord,
  ADMIN_EMAIL,
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

  await login(page, ADMIN_EMAIL);
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();

  const row = page
    .locator('table tbody tr', { hasText: 'TonyAI Trading' })
    .filter({ hasText: 'Q4 2026' });
  await expect(row).toContainText('submitted');
  await row.click();

  // Both actors in the detail sheet, including the one nobody has filled in:
  // "not reviewed yet" is a fact about the record, and a field that appeared
  // only once populated would hide it.
  //
  // Labels only, deliberately. Here the viewer IS the creator, so asserting the
  // VALUE could not tell "shows the record's author" apart from "shows whoever
  // is logged in" — an implementation rendering `user.fullName` would pass. The
  // value is asserted in the consultant test below, where the two differ.
  // Scoped to the sheet, not the page: renaming the queue's column header to
  // "Entered by" put a second copy of that exact string in the table head, and
  // an unscoped `getByText` is then a strict-mode violation. The same duplicate
  // -label hazard `pickByFieldLabel` already carries for the two `Unit` fields
  // on /data-entry.
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Entered by')).toBeVisible();
  await expect(sheet.getByText('Reviewed by')).toBeVisible();

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

test('the queue is ordered oldest-first', async ({ page, request }) => {
  // Asserted on two records this test creates, in a known creation order, so it
  // holds whether or not other specs have left rows behind. Reversing the sort
  // left the suite green before this existed.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await createCommittedRecord(request, token, {
    subsidiaryId: SUB.energy,
    category: 'Natural Gas',
    periodValue: 'Q2',
    activityValue: 1200,
    activityUnit: 'm3',
  });
  await createCommittedRecord(request, token, {
    subsidiaryId: SUB.energy,
    category: 'Fuel',
    periodValue: 'Q2',
    activityValue: 800,
    activityUnit: 'litres',
  });

  await login(page, ADMIN_EMAIL);
  await page.goto('/review');
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible();

  const text = await rows.allInnerTexts();
  const older = text.findIndex((t) => t.includes('Natural Gas') && t.includes('Q2 2026'));
  const newer = text.findIndex((t) => t.includes('Fuel') && t.includes('Q2 2026'));
  expect(older).toBeGreaterThanOrEqual(0);
  expect(newer).toBeGreaterThan(older);
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
