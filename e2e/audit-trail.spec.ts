import { test, expect } from '@playwright/test';
import {
  login,
  bearer,
  getAccessToken,
  createCommittedRecord,
  ADMIN_EMAIL,
  ENTRY_EMAIL,
  API_BASE,
  SUB,
} from './helpers';

/**
 * WP7 PR 2 — the audit-trail viewer.
 *
 * The acceptance criteria recorded in the roadmap are: read-only, tenant-scoped,
 * and it must display the actor's role **as it was at the time**. The last one
 * is the whole reason the `role` column exists, so it is asserted on a row this
 * spec creates rather than on seeded data.
 */

test('super_admin reads the trail; the newest entry is the action just performed', async ({
  page,
  request,
}) => {
  // Arrange via the API (the skill's rule: heavy state through the API), in the
  // quarterly space so teardown reclaims it.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await createCommittedRecord(request, token, {
    subsidiaryId: SUB.trading,
    category: 'Electricity',
    periodValue: 'Q2',
    activityValue: 5100,
  });

  await login(page, ADMIN_EMAIL);
  await page.goto('/audit');

  await expect(page.getByRole('heading', { name: 'Audit Trail' })).toBeVisible();

  // The submit we just did is a `submit` action — proving the taxonomy reaches
  // the viewer, not just the database (before WP7 every transition said `update`).
  const firstRow = page.locator('table tbody tr').first();
  await expect(firstRow).toContainText('submit');
  await expect(firstRow).toContainText('activity record');
  // The actor's role at the time, read from the row.
  await expect(firstRow).toContainText('super_admin');
});

test('the viewer paginates rather than loading the whole trail', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Audit Trail' })).toBeVisible();

  // Wait for the first page to actually arrive: both pagination buttons are
  // disabled while loading, so asserting on them earlier races the fetch.
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toContainText(/create|update|submit|approve|generate/);

  await expect(page.getByText(/Page 1 of/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();

  const next = page.getByRole('button', { name: 'Next', exact: true });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByText(/Page 2 of/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
});

test('data_entry is told why the trail is closed, not shown a broken page', async ({
  page,
}) => {
  // The API 403s this role (matching the RLS policy). The page must explain
  // that rather than render an error — a blank screen reads as a bug.
  await login(page, ENTRY_EMAIL);
  await page.goto('/audit');

  await expect(
    page.getByText(/Only a super_admin can read the audit trail/i),
  ).toBeVisible();
  await expect(page.locator('table')).toHaveCount(0);
});

test('the audit API is read-only and tenant-gated', async ({ request }) => {
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const entry = await getAccessToken(request, ENTRY_EMAIL);

  const ok = await request.get(`${API_BASE}/audit?limit=5`, { headers: bearer(admin) });
  expect(ok.status()).toBe(200);
  const page1 = await ok.json();
  expect(page1.items.length).toBeLessThanOrEqual(5);
  expect(page1.total).toBeGreaterThan(0);

  // Role gate, not a tenancy gate: the trail exists, this role may not read it.
  const refused = await request.get(`${API_BASE}/audit`, { headers: bearer(entry) });
  expect(refused.status()).toBe(403);

  // Filters actually narrow the result, and the envelope's `total` reflects the
  // filter rather than the whole trail.
  const filtered = await request.get(`${API_BASE}/audit?entity=report&limit=5`, {
    headers: bearer(admin),
  });
  expect(filtered.status()).toBe(200);
  const reports = await filtered.json();
  for (const row of reports.items) expect(row.entity).toBe('report');
  expect(reports.total).toBeLessThan(page1.total);

  // A mistyped filter must fail loudly — silently ignoring it would return the
  // UNFILTERED trail to someone who thinks they narrowed it.
  const typo = await request.get(`${API_BASE}/audit?entty=subsidiary`, {
    headers: bearer(admin),
  });
  expect(typo.status()).toBe(400);

  // The page size is capped server-side.
  const tooBig = await request.get(`${API_BASE}/audit?limit=500`, {
    headers: bearer(admin),
  });
  expect(tooBig.status()).toBe(400);

  // There is no write verb on this resource at all.
  for (const method of ['post', 'patch', 'delete'] as const) {
    const res = await request[method](`${API_BASE}/audit`, { headers: bearer(admin) });
    expect(res.status()).toBe(404);
  }
});
