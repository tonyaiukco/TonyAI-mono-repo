import { test, expect, type Page, type Request } from '@playwright/test';
import enEntry from '../apps/web/messages/en/dataEntry.json';
import enErrors from '../apps/web/messages/en/errors.json';
import { ENTRY_EMAIL, login, pickByFieldLabel } from './helpers';

/**
 * The live preview asks the API with the record's reporting period, because the
 * TR capacity method refuses any period but annual (LP4-02, D7, D11). So a change
 * of period must ask again, or the form keeps showing the old answer.
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
  await pickByFieldLabel(page, 'Category', 'Refrigerants');
  await pickByFieldLabel(page, 'Fuel or gas', 'R-134a');
  await pickByFieldLabel(page, 'Period', 'Quarterly');

  const refusal = page.getByText(enErrors.codes.reporting_period_not_annual);
  await previewAsked(page, 'quarterly', () => page.getByPlaceholder(enEntry.activityValuePlaceholder).fill('5'));
  await expect(refusal).toBeVisible();

  await previewAsked(page, 'annual', () => pickByFieldLabel(page, 'Period', 'Annual'));
  await expect(refusal).toBeHidden();
});
