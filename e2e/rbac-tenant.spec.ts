import { test, expect } from '@playwright/test';
import {
  login,
  subsidiaryRows,
  bearer,
  getAccessToken,
  ENTRY_EMAIL,
  API_BASE,
  SUB,
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
      reportingYear: 2024,
      reportingPeriod: 'quarterly',
      periodValue: 'Q4',
    },
  });
  expect(res.status()).toBe(403);
});
