import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import en from '../apps/web/messages/en/dataEntry.json';
import enCategories from '../apps/web/messages/en/categories.json';
import enPeriods from '../apps/web/messages/en/periods.json';
import enUnits from '../apps/web/messages/en/units.json';
import {
  API_BASE,
  E2E_TR_INPUTS,
  E2E_TR_INPUTS_YEAR,
  ENTRY_EMAIL,
  SUB,
  bearer,
  cleanupTrInputsFixture,
  findRecordId,
  getAccessToken,
  login,
  pickByFieldLabel,
  seedTrInputsFixture,
} from './helpers';

/**
 * LP4-02 PR4: the Data Entry forms of the TR rules, one flow each — natural gas
 * with a billed GCV, a refrigerant on its alternative leak rate, a vehicle mode
 * and gas-network leakage — priced from a fixture release (`seedTrInputsFixture`),
 * never the TR package.
 *
 * Lane: `SUB.logistics` (TR, entry-accessible) in `E2E_TR_INPUTS_YEAR`, which
 * no other spec writes and the seed holds no record or TR factor in. Each test
 * deletes its own draft in `finally`, since the teardown reclaims only
 * `E2E_YEAR`'s quarterly rows.
 */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => seedTrInputsFixture());
test.afterAll(async () => cleanupTrInputsFixture());

const SUBSIDIARY = 'TonyAI Logistics (TR)';

async function openForm(page: Page, category: keyof typeof enCategories): Promise<void> {
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, en.subsidiary, SUBSIDIARY);
  await pickByFieldLabel(page, en.category, enCategories[category]);
  await pickByFieldLabel(page, en.reportingYear, String(E2E_TR_INPUTS_YEAR));
}

/** The draft the flow saved, read back through the API, then deleted. */
async function readAndDelete(
  request: APIRequestContext,
  q: { category: string; reportingPeriod: string; periodValue: string },
  check: (record: { activityValue: number; activityUnit: string; parameters: unknown; calculation: Record<string, unknown> }) => void,
): Promise<void> {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const id = await findRecordId(request, token, { subsidiaryId: SUB.logistics, ...q });
  try {
    const res = await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
    expect(res.status()).toBe(200);
    check(await res.json());
  } finally {
    const removed = await request.delete(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
    expect(removed.ok()).toBe(true);
  }
}

test('natural gas: the NCV opens on the release default, and a billed GCV derives the one priced', async ({ page, request }) => {
  await openForm(page, 'Natural Gas');
  await pickByFieldLabel(page, en.period, enPeriods.granularity.quarterly);
  await pickByFieldLabel(page, en.periodValue, enPeriods.values.Q3);
  await page.getByRole('combobox', { name: en.unit, exact: true }).click();
  await page.getByRole('option', { name: enUnits.label.standard_cubic_metres, exact: true }).click();

  // The default comes from the release, never the form.
  await expect(page.locator('#input-ncv')).toHaveValue(String(E2E_TR_INPUTS.referenceNcv));
  await page.getByPlaceholder(en.activityValuePlaceholder).fill('100');
  await page.locator('#input-gcv').fill('12000');
  await expect(page.locator('#input-ncv')).toBeDisabled();

  // 9,000 × 10,000 / 12,000 = 7,500 kcal/Sm³; 100 Sm³ × 7,500 × 4.184 / 3,600 × 0.2 = 174.333 kg.
  const note = page.getByTestId('conversion-note');
  await expect(note).toContainText('7,500');
  await expect(note).toContainText(en.conversionNote.ncvOrigin.derived);
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.174');

  await page.getByRole('button', { name: en.saveDraft }).click();
  await expect(page.getByText(en.draftSaved)).toBeVisible();
  await readAndDelete(request, { category: 'Natural Gas', reportingPeriod: 'quarterly', periodValue: 'Q3' }, (record) => {
    expect(record.parameters).toEqual({ billedGcvKcalPerSm3: 12000 });
    expect(record.activityUnit).toBe('standard_cubic_metres');
    expect(record.calculation.kgCo2e as number).toBeCloseTo(174.3333333, 5);
  });
});

test('refrigerant: one annual record of equipment lines, priced on the alternative rate', async ({ page, request }) => {
  await openForm(page, 'Refrigerants');
  await pickByFieldLabel(page, en.fuelOrGas, en.activityTypes[E2E_TR_INPUTS.refrigerant]);

  // Annual by the capacity method: the form files it on the year.
  await expect(page.getByTestId('equipment-lines')).toBeVisible();
  await page.getByRole('combobox', { name: `${en.inputs.equipmentType} 1` }).click();
  await page.getByRole('option', { name: en.equipmentTypes.split_air_conditioner, exact: true }).click();
  await page.getByLabel(en.inputs.capacity).fill('10');
  await page.getByLabel(en.inputs.refill).fill('1');
  await page.getByRole('combobox', { name: `${en.inputs.leakRate} 1` }).click();
  await page.getByRole('option', { name: en.inputs.alternativeRate.replace('{rate}', '50%'), exact: true }).click();

  // The quantity is the total capacity; the priced mass is 10 × 0.5 + 1 = 6 kg × 1,000 = 6 t.
  await expect(page.getByTestId('equipment-total')).toHaveValue('10');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('6');

  await page.getByRole('button', { name: en.saveDraft }).click();
  await expect(page.getByText(en.draftSaved)).toBeVisible();
  await readAndDelete(request, { category: 'Refrigerants', reportingPeriod: 'annual', periodValue: 'Annual' }, (record) => {
    expect(record.activityValue).toBe(10);
    expect(record.parameters).toEqual({
      equipment: [{ equipmentType: 'split_air_conditioner', capacityKg: 10, refillKg: 1, leakRateChoice: 'alternative' }],
    });
    expect(record.calculation.kgCo2e).toBe(6000);
  });
});

test('mobile combustion: a TR record names its vehicle mode, in litres', async ({ page, request }) => {
  await openForm(page, 'Mobile Combustion');
  await pickByFieldLabel(page, en.period, enPeriods.granularity.quarterly);
  await pickByFieldLabel(page, en.periodValue, enPeriods.values.Q3);
  await pickByFieldLabel(page, en.vehicleMode, en.activityTypes[E2E_TR_INPUTS.mode]);
  await page.getByPlaceholder(en.activityValuePlaceholder).fill('100');
  // 100 L × 3 = 300 kg.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.3');

  await page.getByRole('button', { name: en.saveDraft }).click();
  await expect(page.getByText(en.draftSaved)).toBeVisible();
  await readAndDelete(request, { category: 'Mobile Combustion', reportingPeriod: 'quarterly', periodValue: 'Q3' }, (record) => {
    expect(record.activityUnit).toBe('litres');
    expect(record.calculation.kgCo2e).toBe(300);
  });
});

test('gas-network leakage: a Fugitive Gas record in Sm³', async ({ page, request }) => {
  await openForm(page, 'Fugitive Gas');
  await pickByFieldLabel(page, en.period, enPeriods.granularity.quarterly);
  await pickByFieldLabel(page, en.periodValue, enPeriods.values.Q3);
  await page.getByPlaceholder(en.activityValuePlaceholder).fill('50');
  // 50 Sm³ × 20 = 1,000 kg.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('1');

  await page.getByRole('button', { name: en.saveDraft }).click();
  await expect(page.getByText(en.draftSaved)).toBeVisible();
  await readAndDelete(request, { category: 'Fugitive Gas', reportingPeriod: 'quarterly', periodValue: 'Q3' }, (record) => {
    expect(record.activityUnit).toBe('standard_cubic_metres');
    expect(record.parameters).toBeNull();
    expect(record.calculation.kgCo2e).toBe(1000);
  });
});
