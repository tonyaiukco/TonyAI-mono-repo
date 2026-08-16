import { test, expect } from '@playwright/test';
import {
  login,
  subsidiaryRows,
  ADMIN_EMAIL,
  ENTRY_EMAIL,
} from './helpers';

test.describe('Milestone-1 slice', () => {
  test('admin: login -> dashboard KPI -> subsidiaries CRUD', async ({ page }) => {
    await login(page, ADMIN_EMAIL);

    // Dashboard KPI: the live "Total Subsidiaries" card shows 5 for the
    // super_admin (sees all org subsidiaries). The value lives in a
    // font-mono/tabular-nums div within the card; scope to that card's value to
    // avoid matching unrelated "5"s in the demo section below.
    const totalCard = page
      .locator('.rounded-\\[18px\\]')
      .filter({ has: page.getByText('Total Subsidiaries', { exact: true }) })
      .first();
    await expect(totalCard.locator('.font-mono')).toHaveText('5');

    // Navigate to the subsidiaries register.
    await page.goto('/subsidiaries');
    await expect(page.getByRole('heading', { name: 'Subsidiaries' })).toBeVisible();
    await expect(subsidiaryRows(page)).toHaveCount(5);

    // CREATE: open the dialog, fill the form, add a location, submit.
    const uniqueName = `E2E Test Co ${Date.now()}`;
    await page.getByRole('button', { name: 'Add Subsidiary' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Add subsidiary')).toBeVisible();
    // First text input in the dialog is "Legal name *".
    await dialog.getByRole('textbox').first().fill(uniqueName);
    // Round-1 SUB-3: the form asks for at least one operational location, and
    // refuses without one.
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Add at least one operational location')).toBeVisible();
    await dialog.getByLabel('Location name').fill('E2E Smoke Site');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await dialog.getByRole('button', { name: 'Create' }).click();

    // Creating lands on the new subsidiary's own page, with the location it was
    // created with already there — one transaction, not a follow-up write.
    await expect(page).toHaveURL(/\/subsidiaries\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: uniqueName })).toBeVisible();
    await expect(page.getByText('E2E Smoke Site')).toBeVisible();

    // Back on the register the new row is there and the count grows to 6.
    await page.goto('/subsidiaries');
    await expect(page.getByRole('cell', { name: uniqueName })).toBeVisible();
    await expect(subsidiaryRows(page)).toHaveCount(6);

    // EDIT moved to `subsidiary-panel.spec.ts` (WP16 PR 2b): a subsidiary is
    // now edited on its own page, not in a dialog on the register. What stays
    // here is the register's own job — create, list, delete.

    // DELETE: one step again. The subsidiary's own record-free locations go
    // with it, each with its own audit row — so the "typo in the create form"
    // the guard's message names is undone in one action, not six.
    const newRow = page.locator('tr', { hasText: uniqueName });
    await newRow.getByRole('button', { name: 'Delete subsidiary' }).click();
    const alert = page.getByRole('alertdialog');
    await expect(alert.getByText('Delete subsidiary?')).toBeVisible();
    await alert.getByRole('button', { name: 'Delete' }).click();

    // The row is gone and the count returns to 5.
    await expect(page.getByRole('cell', { name: uniqueName })).toHaveCount(0);
    await expect(subsidiaryRows(page)).toHaveCount(5);
  });

  test('data_entry: tenant isolation -> only 2 subsidiaries visible', async ({ page }) => {
    await login(page, ENTRY_EMAIL);
    await page.goto('/subsidiaries');
    await expect(page.getByRole('heading', { name: 'Subsidiaries' })).toBeVisible();
    // entry@tonyai.local has explicit access to exactly 2 subsidiaries.
    await expect(subsidiaryRows(page)).toHaveCount(2);
  });
});
