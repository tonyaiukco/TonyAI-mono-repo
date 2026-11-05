import { test, expect, type Page, type Request } from '@playwright/test';
import enEntry from '../apps/web/messages/en/dataEntry.json';
import enErrors from '../apps/web/messages/en/errors.json';
import { ENTRY_EMAIL, login, pickByFieldLabel } from './helpers';

/**
 * The live preview asks the API with the record's reporting period, because the
 * TR capacity method refuses any period but annual (LP4-02, D7, D11). So a change
 * of period must ask again, or the form keeps showing the old answer. Since PR4
 * the form files a new TR refrigerant record on the year itself, so the period
 * change is exercised on Water, and the refrigerant form is held to annual.
 *
 * Lane: none. Nothing is saved; a preview writes nothing.
 */
const isPreview = (period: string) => (req: Request) =>
  req.method() === 'POST' &&
  req.url().endsWith('/calculations/preview') &&
  (req.postDataJSON() as { reportingPeriod?: string }).reportingPeriod === period;

async function previewAsked(page: Page, period: string, change: () => Promise<void>): Promise<void> {
  const asked = page.waitForRequest(isPreview(period));
  await change();
  await asked;
}

test('a change of reporting period asks for a new preview', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, 'Subsidiary', 'TonyAI Logistics (TR)');
  await pickByFieldLabel(page, 'Category', 'Water');
  await pickByFieldLabel(page, 'Period', 'Quarterly');

  await previewAsked(page, 'quarterly', () => page.getByPlaceholder(enEntry.activityValuePlaceholder).fill('5'));
  await previewAsked(page, 'monthly', () => pickByFieldLabel(page, 'Period', 'Monthly'));
});

test('a new TR refrigerant record is annual, and its preview says so', async ({ page }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, 'Subsidiary', 'TonyAI Logistics (TR)');
  await pickByFieldLabel(page, 'Category', 'Refrigerants');
  await pickByFieldLabel(page, 'Fuel or gas', 'R-134a');

  const period = page.locator('div.space-y-2', { has: page.getByText('Period', { exact: true }) }).getByRole('combobox');
  await expect(period).toBeDisabled();
  await expect(period).toHaveText('Annual');
  await expect(page.getByText(enEntry.inputs.annualOnly)).toBeVisible();
  await expect(page.getByText(enErrors.codes.reporting_period_not_annual)).toHaveCount(0);
  await previewAsked(page, 'annual', async () => {
    await page.getByRole('combobox', { name: `${enEntry.inputs.equipmentType} 1` }).click();
    await page.getByRole('option', { name: enEntry.equipmentTypes.refrigerator, exact: true }).click();
    await page.getByLabel(enEntry.inputs.capacity).fill('5');
  });
});
