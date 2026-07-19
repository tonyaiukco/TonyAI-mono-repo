import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { login, ADMIN_EMAIL, ENTRY_EMAIL } from './helpers';

/**
 * Reports (WP6, FR §5): the page renders live data and each export button
 * produces a real, non-empty downloaded artifact. Generation is read-only
 * (plus an audit row), so no teardown is needed.
 */

test('reports: live preview + PDF/Excel/CSV downloads', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/reports');

  // Live preview: branded header, a real status badge (exact status depends on
  // what other serial tests have committed this run) and committed totals.
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await expect(page.getByText('TonyAI Holding')).toBeVisible();
  await expect(
    page.getByText(/^(Approved|Draft — pending review|Contains incomplete data)$/).first(),
  ).toBeVisible();
  await expect(page.getByText('Committed records', { exact: false })).toBeVisible();

  // Each export produces a real download with the expected extension + content.
  // Exact server-chosen filenames (proves Content-Disposition survives CORS)
  // plus a magic-byte check that the artifact really is what it claims to be.
  const cases = [
    { button: 'Download PDF', file: 'tonyai-executive_summary-2024.pdf', magic: '%PDF', toast: 'PDF report generated' },
    { button: 'Export Excel', file: 'tonyai-executive_summary-2024.xlsx', magic: 'PK', toast: 'EXCEL report generated' },
    { button: 'Export CSV', file: 'tonyai-executive_summary-2024.csv', magic: 'subsidiary,', toast: 'CSV report generated' },
  ] as const;

  for (const c of cases) {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: c.button }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(c.file);
    const path = await download.path();
    expect(path).toBeTruthy();
    const head = readFileSync(path!).subarray(0, 16).toString('utf8');
    expect(head.startsWith(c.magic)).toBe(true);
    await expect(page.getByText(c.toast).first()).toBeVisible();
  }
});

test('reports: data_entry can view report data but has no export controls', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  // Permissions matrix: "Generate and export reports" is denied to data_entry.
  await expect(page.getByText(/cannot generate or export reports/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download PDF' })).toHaveCount(0);
});
