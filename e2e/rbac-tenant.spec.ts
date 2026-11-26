import { test, expect } from '@playwright/test';
import {
  login,
  subsidiaryRows,
  bearer,
  getAccessToken,
  ENTRY_EMAIL,
  ADMIN_EMAIL,
  APPROVER_EMAIL,
  AUDITOR_EMAIL,
  VIEWER_EMAIL,
  API_BASE,
  SUB,
  OUT_OF_SCOPE_SUB,
  findRecordId,
  SEED_NODE_COUNT,
  SEED_APPROVER_GRANTS,
} from './helpers';

/**
 * RBAC + tenant isolation on the four roles (INC-2.6 §1, §6): scoped reads for
 * the two granted roles — the standard user's two companies, the super_admin's
 * four — the whole organisation for the masterkey and the auditor; company
 * and period-lock writes the masterkey's alone, gated in the UI and a hard 403
 * at the API even if the UI is bypassed.
 */
test('a standard user: scoped reads + period-lock write gated in the UI', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto('/subsidiaries');
  await expect(page.getByRole('heading', { name: 'Subsidiaries' })).toBeVisible();

  // Sees exactly the 2 subsidiaries it has access to: its main company Energy and its grant company Logistics.
  await expect(subsidiaryRows(page)).toHaveCount(2);

  // masterkey-only write controls are hidden for a standard user (the API also 403s).
  // Admin visibility of these is covered by smoke.spec's create/delete flow.
  await expect(page.getByRole('button', { name: 'Add Subsidiary' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete subsidiary' })).toHaveCount(0);
  // "Edit subsidiary" used to be asserted here. WP16 PR 2b removed that button
  // for EVERY role — editing moved to `/subsidiaries/[id]` — so the assertion
  // would have kept passing while proving nothing about permissions. The real
  // question, "can a standard user change a subsidiary", is now answered
  // against the panel in `subsidiary-panel.spec.ts`; what belongs here is that
  // the register does not offer them a way in.
  await expect(page.getByRole('button', { name: 'Open subsidiary' })).toHaveCount(0);

  // The read-only drawers stay available: the period-locks drawer opens (locked
  // list) but the lock/unlock form is gated — no "Lock period" button, and an
  // explicit masterkey-only message.
  await page.getByRole('button', { name: 'Manage period locks' }).first().click();
  await expect(page.getByText(/only a masterkey can lock or unlock/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock period' })).toHaveCount(0);
});

test('a super admin sees its companies and may add only a child company; an auditor sees the whole tree and writes none', async ({ page }) => {
  await login(page, APPROVER_EMAIL);
  await page.goto('/subsidiaries');
  await expect(page.getByRole('heading', { name: 'Subsidiaries' })).toBeVisible();
  // Every seed company but TonyAI Trading, the fallback company, and the
  // child company it created under TonyAI Energy (inc26-group-tree).
  await expect(subsidiaryRows(page)).toHaveCount(SEED_APPROVER_GRANTS.length);
  await expect(subsidiaryRows(page).filter({ hasText: 'TonyAI Trading' })).toHaveCount(0);
  // A super_admin creates child companies under its own (inc26-group-tree, R6),
  // and changes or deletes none.
  await expect(page.getByRole('button', { name: 'Add Subsidiary' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Delete subsidiary' })).toHaveCount(0);

  await page.getByTestId('sign-out').click();
  await page.waitForURL('**/login');
  await login(page, AUDITOR_EMAIL);
  await page.goto('/subsidiaries');
  await expect(page.getByRole('heading', { name: 'Subsidiaries' })).toBeVisible();
  await expect(subsidiaryRows(page).filter({ hasText: 'TonyAI Trading' })).toHaveCount(1);
  await expect(subsidiaryRows(page)).toHaveCount(SEED_NODE_COUNT);
  await expect(page.getByRole('button', { name: 'Add Subsidiary' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete subsidiary' })).toHaveCount(0);
});

test('only a masterkey locks a period: the standard user, the super admin and the auditor are refused at the API (403)', async ({ request }) => {
  for (const email of [ENTRY_EMAIL, APPROVER_EMAIL, AUDITOR_EMAIL]) {
    const token = await getAccessToken(request, email);
    const res = await request.post(`${API_BASE}/period-locks`, {
      headers: bearer(token),
      data: {
        subsidiaryId: SUB.energy, // a subsidiary every one of them reads — RBAC forbids the action
        reportingYear: 2026,
        reportingPeriod: 'quarterly',
        periodValue: 'Q4',
      },
    });
    expect(res.status(), email).toBe(403);
  }
});

test('only a masterkey creates, updates or deletes a subsidiary: every other role gets 403, nothing changes', async ({ request }) => {
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const before = await (await request.get(`${API_BASE}/subsidiaries/${SUB.energy}`, { headers: bearer(admin) })).json();
  for (const email of [APPROVER_EMAIL, ENTRY_EMAIL, AUDITOR_EMAIL, VIEWER_EMAIL]) {
    const token = await getAccessToken(request, email);
    const create = await request.post(`${API_BASE}/subsidiaries`, {
      headers: bearer(token),
      data: { legalName: 'E2E Test Co Refused', geographyCode: 'TR', reportingStatus: 'active' },
    });
    expect(create.status(), `create as ${email}`).toBe(403);
    // Energy: a company every one of these roles reads, so the 403 is the role's.
    const update = await request.patch(`${API_BASE}/subsidiaries/${SUB.energy}`, {
      headers: bearer(token),
      data: { legalName: 'Renamed by a role that may not' },
    });
    expect(update.status(), `update as ${email}`).toBe(403);
    const remove = await request.delete(`${API_BASE}/subsidiaries/${SUB.energy}`, { headers: bearer(token) });
    expect(remove.status(), `delete as ${email}`).toBe(403);
  }
  const after = await (await request.get(`${API_BASE}/subsidiaries/${SUB.energy}`, { headers: bearer(admin) })).json();
  expect(after.legalName).toBe(before.legalName);
  const all = (await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(admin) })).json()) as { legalName: string }[];
  expect(all.filter((s) => s.legalName === 'E2E Test Co Refused')).toHaveLength(0);
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

  // The super admin is scoped the same way: TonyAI Trading is outside its
  // grants, and reads as missing. (A Trading record reading as missing to it
  // is `roles-approval-chain.spec.ts`'s fallback case: the seed holds none.)
  const superAdmin = await getAccessToken(request, APPROVER_EMAIL);
  const trading = await request.get(`${API_BASE}/subsidiaries/${SUB.trading}`, { headers: bearer(superAdmin) });
  expect(trading.status()).toBe(404);
  const list = await request.get(`${API_BASE}/activity-records?subsidiaryId=${SUB.trading}&limit=1`, { headers: bearer(superAdmin) });
  if (list.ok()) expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0);
  else expect(list.status()).toBe(404);
});

test('masterkey cannot write to another organisation (tenant check on update/delete)', async ({
  request,
}) => {
  // Regression guard: update/remove used to check the ROLE only, so a
  // masterkey could edit or delete a subsidiary in another organisation.
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

test('a role that decides nothing is refused with 403, not 404 (a standard user or an auditor may not approve)', async ({
  request,
}) => {
  // Decision 2026-07-30: the seat that prepares data does not approve it, and
  // an auditor reads without deciding (INC-2.6 §1). Asserted at the boundary
  // that matters: the record IS visible to these users (so not a 404) — their
  // ROLE simply may not approve it. Uses a seeded record, so no writes and no
  // interaction with the anomaly baseline. Who decides what among the
  // deciding roles is `review-queue.spec.ts`'s and `roles-approval-chain.spec.ts`'s.
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
  for (const email of [ENTRY_EMAIL, AUDITOR_EMAIL, VIEWER_EMAIL]) {
    const token = await getAccessToken(request, email);
    const id = await findRecordId(request, token, {
      subsidiaryId: SUB.energy,
      category: 'Natural Gas',
      periodValue: 'January',
      reportingPeriod: 'monthly',
    });

    const res = await request.post(`${API_BASE}/activity-records/${id}/approve`, {
      headers: bearer(token),
    });
    expect(res.status(), email).toBe(403);
  }
});
