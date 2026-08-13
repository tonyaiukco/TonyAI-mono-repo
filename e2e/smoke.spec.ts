import { test, expect } from '@playwright/test';
import {
  login,
  pickByFieldLabel,
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

    // EDIT (WP7 PR 4 / round-1 UAT SUB-1): a subsidiary must be editable.
    const renamed = `${uniqueName} Renamed`;
    await page.locator('tr', { hasText: uniqueName }).getByRole('button', { name: 'Edit subsidiary' }).click();
    await expect(dialog.getByText('Edit subsidiary')).toBeVisible();
    // The dialog opens populated, not blank — otherwise "edit" silently means
    // "retype everything", and any field left alone would be wiped.
    await expect(dialog.getByRole('textbox').first()).toHaveValue(uniqueName);
    await dialog.getByRole('textbox').first().fill(renamed);

    // Changing the geography must be confirmed, not saved silently.
    await pickByFieldLabel(page, 'Geography', 'United Kingdom (UK)');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    const geoAlert = page.getByRole('alertdialog');
    await expect(geoAlert.getByText(/Change geography from TR to UK\?/)).toBeVisible();
    await expect(
      geoAlert.getByText(/will change the configured factor basis/),
    ).toBeVisible();
    // The reassurance that makes the warning safe to accept.
    await expect(
      geoAlert.getByText(/records already committed keep the emission factor/i),
    ).toBeVisible();

    // Cancelling must not save — a warning the user declined is not a save.
    // Asserted against the SERVER, not the table still on screen: the dialog
    // does not refresh on cancel, so checking the current DOM passes even if the
    // cancel button wrote to the API (proven by mutation — that exact test was
    // green while a cancelled edit persisted).
    await geoAlert.getByRole('button', { name: 'Cancel' }).click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.reload();
    await expect(page.getByRole('cell', { name: uniqueName })).toBeVisible();
    await expect(page.getByRole('cell', { name: renamed })).toHaveCount(0);
    await expect(page.locator('tr', { hasText: uniqueName })).toContainText('TR');

    // Re-open and redo the edit, this time confirming it.
    await page.locator('tr', { hasText: uniqueName }).getByRole('button', { name: 'Edit subsidiary' }).click();
    await dialog.getByRole('textbox').first().fill(renamed);
    await pickByFieldLabel(page, 'Geography', 'United Kingdom (UK)');

    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Subsidiary settings updated successfully.')).toBeVisible();
    await expect(page.getByRole('cell', { name: renamed })).toBeVisible();
    await expect(page.locator('tr', { hasText: renamed })).toContainText('UK');
    await expect(subsidiaryRows(page)).toHaveCount(6);

    // DELETE: trigger the delete on the new row, confirm in the alert dialog.
    const newRow = page.locator('tr', { hasText: renamed });
    await newRow.getByRole('button', { name: 'Delete subsidiary' }).click();
    const alert = page.getByRole('alertdialog');
    await expect(alert.getByText('Delete subsidiary?')).toBeVisible();
    await alert.getByRole('button', { name: 'Delete' }).click();

    // The row is gone and the count returns to 5.
    await expect(page.getByRole('cell', { name: renamed })).toHaveCount(0);
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
