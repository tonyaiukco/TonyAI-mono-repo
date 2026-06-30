import { test, expect } from '@playwright/test';
import { login, subsidiaryRows, ADMIN_EMAIL, ENTRY_EMAIL } from './helpers';

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

    // CREATE: open the dialog, fill the form, submit.
    const uniqueName = `E2E Test Co ${Date.now()}`;
    await page.getByRole('button', { name: 'Add Subsidiary' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Add subsidiary')).toBeVisible();
    // First text input in the dialog is "Legal name *".
    await dialog.getByRole('textbox').first().fill(uniqueName);
    await dialog.getByRole('button', { name: 'Create' }).click();

    // The new row appears and the count grows to 6.
    await expect(page.getByRole('cell', { name: uniqueName })).toBeVisible();
    await expect(subsidiaryRows(page)).toHaveCount(6);

    // DELETE: trigger the delete on the new row, confirm in the alert dialog.
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
