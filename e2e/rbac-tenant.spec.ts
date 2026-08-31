import { test, expect } from '@playwright/test';
import {
  login,
  subsidiaryRows,
  bearer,
  getAccessToken,
  ENTRY_EMAIL,
  ADMIN_EMAIL,
  API_BASE,
  SUB,
  OUT_OF_SCOPE_SUB,
  findRecordId,
} from './helpers';

/**
 * RBAC + tenant isolation from the data_entry user's perspective: scoped reads,
 * the period-lock WRITE action gated in the UI, and a hard 403 at the API even
 * if the UI is bypassed.
 */
test('data_entry: scoped reads + period-lock write gated in the UI', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto('/subsidiaries');
  await expect(page.getByRole('heading', { name: 'Subsidiaries' })).toBeVisible();

  // Sees exactly the 2 subsidiaries it has access to (Energy + Logistics).
  await expect(subsidiaryRows(page)).toHaveCount(2);

  // super_admin-only write controls are hidden for data_entry (the API also 403s).
  // Admin visibility of these is covered by smoke.spec's create/delete flow.
  await expect(page.getByRole('button', { name: 'Add Subsidiary' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete subsidiary' })).toHaveCount(0);
  // "Edit subsidiary" used to be asserted here. WP16 PR 2b removed that button
  // for EVERY role — editing moved to `/subsidiaries/[id]` — so the assertion
  // would have kept passing while proving nothing about permissions. The real
  // question, "can a data_entry user change a subsidiary", is now answered
  // against the panel in `subsidiary-panel.spec.ts`; what belongs here is that
  // the register does not offer them a way in.
  await expect(page.getByRole('button', { name: 'Open subsidiary' })).toHaveCount(0);

  // The read-only drawers stay available: the period-locks drawer opens (locked
  // list) but the lock/unlock form is gated — no "Lock period" button, and an
  // explicit super_admin-only message.
  await page.getByRole('button', { name: 'Manage period locks' }).first().click();
  await expect(page.getByText(/only a super_admin can lock or unlock/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock period' })).toHaveCount(0);
});

test('data_entry: locking a period is rejected at the API (403)', async ({ request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await request.post(`${API_BASE}/period-locks`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUB.energy, // even an accessible subsidiary — RBAC forbids the action
      reportingYear: 2026,
      reportingPeriod: 'quarterly',
      periodValue: 'Q4',
    },
  });
  expect(res.status()).toBe(403);
});

/**
 * The 404-vs-403 rule, decided 2026-07-30 and documented in
 * permissions_and_roles.md §6.2: crossing the TENANT boundary is
 * indistinguishable from "does not exist"; being blocked by your ROLE is a 403.
 * Neither leg had any coverage before WP7 — CROSS_TENANT_SUB was defined in the
 * helpers and never used.
 */
test('out-of-scope access 404s (never 403 — no existence oracle)', async ({ request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);

  // A real subsidiary, outside entry's access set. (The seed has one
  // organisation, so this is access-set isolation; cross-ORG isolation is
  // proven at the RLS layer by the audit_log probe.)
  const read = await request.get(`${API_BASE}/subsidiaries/${OUT_OF_SCOPE_SUB}`, {
    headers: bearer(token),
  });
  expect(read.status()).toBe(404);

  // A completely made-up id must be indistinguishable from the above.
  const missing = await request.get(
    `${API_BASE}/subsidiaries/00000000-0000-0000-0000-0000000000ff`,
    { headers: bearer(token) },
  );
  expect(missing.status()).toBe(read.status());
});

test('super_admin cannot write to another organisation (tenant check on update/delete)', async ({
  request,
}) => {
  // Regression guard: update/remove used to check the ROLE only, so a
  // super_admin could edit or delete a subsidiary in another organisation.
  // Every seeded subsidiary belongs to one org, so we use an id that exists
  // for nobody — the same 404 path the tenant check now enforces.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const foreignId = '00000000-0000-0000-0000-0000000000fe';

  const patch = await request.patch(`${API_BASE}/subsidiaries/${foreignId}`, {
    headers: bearer(token),
    data: { legalName: 'Hijacked Ltd' },
  });
  expect(patch.status()).toBe(404);

  const del = await request.delete(`${API_BASE}/subsidiaries/${foreignId}`, {
    headers: bearer(token),
  });
  expect(del.status()).toBe(404);
});

test('a non-approver role is refused with 403, not 404 (approval is super_admin only)', async ({
  request,
}) => {
  // Decision 2026-07-30: the seat that prepares data does not approve it.
  // Asserted at the boundary that matters: the record IS visible to this user
  // (so not a 404) — their ROLE simply may not approve it. Uses a seeded
  // record, so no writes and no interaction with the anomaly baseline.
  //
  // `data_entry` rather than the consultant deliberately: the consultant's own
  // approve-403 is covered in `review-queue.spec.ts`, and this is the seat that
  // enters data, which is where "prepared it, therefore may approve it" would
  // actually be assumed.
  //
  // THE SERIES IS PART OF THE FIXTURE, not an arbitrary pick. WP18 made
  // site-reported months exclusive, so the seed SKIPS the company-level row for
  // six (subsidiary, category, month) tuples — Energy·Electricity and
  // Logistics·Fuel, January through March (`seed.ts`, `siteReportedKeys`). This
  // test asked for Energy·Electricity·January, which is one of them, so
  // `findRecordId` threw before the assertion below ever ran. Natural Gas keeps
  // all twelve company-level months and is in no `LOCATION_ACTIVITY` entry.
  //
  // It broke silently for a reason worth knowing: on a long-lived dev database
  // the yielded row still existed as `voided`, the list endpoint does not
  // filter voided rows, and `approve()` checks role BEFORE status — so the test
  // passed there and failed only after a fresh `pnpm db:reset`.
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const id = await findRecordId(request, token, {
    subsidiaryId: SUB.energy,
    category: 'Natural Gas',
    periodValue: 'January',
    reportingPeriod: 'monthly',
  });

  const res = await request.post(`${API_BASE}/activity-records/${id}/approve`, {
    headers: bearer(token),
  });
  expect(res.status()).toBe(403);
});
