import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import en from '../apps/web/messages/en/dataEntry.json';
import enCategories from '../apps/web/messages/en/categories.json';
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
 * UAT round 4, BUG-12 (OpenSpec `uat4-fire-suppression-entry`, task 6.2): the
 * Fire Suppression entry on Data Entry, priced from the TR inputs fixture
 * (`seedTrInputsFixture`: CO2 at 10 kgCO2e/kg, dry powder or foam at 0, the
 * fire extinguisher at 10%), never the fire edition.
 *
 * Lane: `SUB.logistics` (TR, entry-accessible) in `E2E_TR_INPUTS_YEAR`, Annual,
 * category Fire Suppression, which no other spec writes and no spec locks
 * (the Logistics locks are on `E2E_YEAR`). Each test deletes its own draft.
 */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => seedTrInputsFixture());
test.afterAll(async () => cleanupTrInputsFixture());

const SUBSIDIARY = 'TonyAI Logistics (TR)';
const fire = en.inputs.fireSuppression;
const QUERY = { category: 'Fire Suppression', reportingPeriod: 'annual', periodValue: 'Annual' } as const;

async function openForm(page: Page, category: keyof typeof enCategories): Promise<void> {
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, en.subsidiary, SUBSIDIARY);
  await pickByFieldLabel(page, en.category, enCategories[category]);
  await pickByFieldLabel(page, en.reportingYear, String(E2E_TR_INPUTS_YEAR));
}

/** A new Fire Suppression record of `gas` with one fire extinguisher line. */
async function startFire(page: Page, gas: string): Promise<void> {
  await openForm(page, 'Fire Suppression');
  await pickByFieldLabel(page, en.fuelOrGas, gas);
  await expect(page.getByTestId('equipment-lines')).toBeVisible();
  await page.getByRole('combobox', { name: `${en.inputs.equipmentType} 1` }).click();
  await page.getByRole('option', { name: en.equipmentTypes.fire_extinguisher, exact: true }).click();
}

async function deleteSaved(request: APIRequestContext): Promise<void> {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const id = await findRecordId(request, token, { subsidiaryId: SUB.logistics, ...QUERY });
  const removed = await request.delete(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
  expect(removed.ok()).toBe(true);
}

test('a new line starts on grams; 6000 g previews and saves as 6 kg', async ({ page, request }) => {
  await startFire(page, en.activityTypes.CO2);
  const unit = page.getByRole('combobox', { name: `${fire.unit} 1` });
  await expect(unit).toHaveText(fire.units.g);
  await page.getByLabel(`${fire.capacity} (g)`).fill('6000');
  await expect(page.getByTestId('equipment-kg').first()).toHaveText('= 6 kg');
  await expect(page.getByTestId('equipment-total')).toHaveValue('6');
  // 6 kg × 10% × 10 kgCO2e/kg = 6 kgCO2e = 0.006 tCO2e.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.006');

  await page.getByRole('button', { name: en.saveDraft }).click();
  await expect(page.getByText(en.draftSaved)).toBeVisible();
  const token = await getAccessToken(request, ENTRY_EMAIL);
  let id: string | null = null;
  try {
    id = await findRecordId(request, token, { subsidiaryId: SUB.logistics, ...QUERY });
    const record = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
    expect(record.activityValue).toBe(6);
    expect(record.activityUnit).toBe('kg');
    expect(record.parameters).toEqual({
      equipment: [{ equipmentType: 'fire_extinguisher', capacityKg: 6, refillKg: 0, leakRateChoice: 'default' }],
    });
    expect(record.calculation.kgCo2e).toBeCloseTo(6, 9);

    // Opened again: kilograms as stored, its selector on kilograms; a new line starts on grams.
    await page.goto(`/data-entry?subsidiaryId=${SUB.logistics}&category=Fire%20Suppression&year=${E2E_TR_INPUTS_YEAR}`);
    await page.getByRole('button', { name: new RegExp(`^Annual ${E2E_TR_INPUTS_YEAR}`) }).click();
    await expect(page.getByText(/Editing draft/)).toBeVisible();
    await expect(page.getByRole('combobox', { name: `${fire.unit} 1` })).toHaveText(fire.units.kg);
    await expect(page.getByLabel(`${fire.capacity} (kg)`)).toHaveValue('6');
    await page.getByRole('button', { name: en.inputs.addLine }).click();
    await expect(page.getByRole('combobox', { name: `${fire.unit} 2` })).toHaveText(fire.units.g);
  } finally {
    if (id) await request.delete(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
    else await deleteSaved(request).catch(() => {});
  }
});

test('a unit change clears its line and leaves the other line alone', async ({ page }) => {
  await startFire(page, en.activityTypes.CO2);
  await page.getByLabel(`${fire.capacity} (g)`).fill('6000');
  // A second line, a system of 50 kg.
  await page.getByRole('button', { name: en.inputs.addLine }).click();
  await page.getByRole('combobox', { name: `${en.inputs.equipmentType} 2` }).click();
  await page.getByRole('option', { name: en.equipmentTypes.fire_suppression_system, exact: true }).click();
  await page.getByRole('combobox', { name: `${fire.unit} 2` }).click();
  await page.getByRole('option', { name: fire.units.kg, exact: true }).click();
  await page.getByLabel(`${fire.capacity} (kg)`).fill('50');
  await expect(page.getByTestId('equipment-total')).toHaveValue('56');
  // Line 1 to kilograms: its figure goes, line 2 keeps its 50 kg.
  await page.getByRole('combobox', { name: `${fire.unit} 1` }).click();
  await page.getByRole('option', { name: fire.units.kg, exact: true }).click();
  const kgFields = page.getByLabel(`${fire.capacity} (kg)`);
  await expect(kgFields).toHaveCount(2);
  await expect(kgFields.nth(0)).toHaveValue('');
  await expect(kgFields.nth(1)).toHaveValue('50');
  await expect(page.getByTestId('equipment-kg')).toHaveCount(0);
  await expect(page.getByRole('button', { name: en.saveDraft })).toBeDisabled();
});

test('"Other gas" states the refusal and holds the preview and the save', async ({ page }) => {
  await startFire(page, en.activityTypes.CO2);
  await page.getByLabel(`${fire.capacity} (g)`).fill('6000');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.006');

  // Nothing is sent while "Other gas" is chosen: no preview carries it.
  const previews: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/calculations\/preview$/.test(new URL(r.url()).pathname)) previews.push(r.postData() ?? '');
  });
  await pickByFieldLabel(page, en.fuelOrGas, fire.otherGas);
  await expect(page.getByTestId('other-gas-statement')).toHaveText(fire.otherGasStatement);
  await expect(page.getByRole('button', { name: en.saveDraft })).toBeDisabled();
  await expect(page.getByTestId('preview-tco2e')).toHaveCount(0);

  await pickByFieldLabel(page, en.fuelOrGas, en.activityTypes['HFC-227ea']);
  await expect(page.getByTestId('other-gas-statement')).toHaveCount(0);
  await expect(page.getByRole('button', { name: en.saveDraft })).toBeEnabled();
  expect(previews.every((body) => !body.includes('__other_gas__'))).toBe(true);
});

test('a dry powder or foam record saves with a figure of zero, and its matrix cell is no longer missing', async ({ page, request }) => {
  await startFire(page, en.activityTypes.dry_powder_or_foam);
  await page.getByLabel(`${fire.capacity} (g)`).fill('12000');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0');
  await expect(page.getByTestId('preview-no-ghg')).toHaveText(fire.noGreenhouseGas);

  await page.getByRole('button', { name: en.saveDraft }).click();
  await expect(page.getByText(en.draftSaved)).toBeVisible();
  const token = await getAccessToken(request, ENTRY_EMAIL);
  try {
    const id = await findRecordId(request, token, { subsidiaryId: SUB.logistics, ...QUERY });
    const record = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
    expect(record.activityType).toBe(E2E_TR_INPUTS.fireNoGas);
    expect(record.calculation.kgCo2e).toBe(0);
    expect(record.calculation.factorValue).toBe(0);

    const matrix = await request.get(`${API_BASE}/emissions/tracking-matrix?year=${E2E_TR_INPUTS_YEAR}`, { headers: bearer(token) });
    expect(matrix.ok()).toBe(true);
    const row = ((await matrix.json()) as {
      rows: { subsidiaryId: string; cells: { category: string; status: string }[] }[];
    }).rows.find((r) => r.subsidiaryId === SUB.logistics);
    expect(row?.cells.find((c) => c.category === 'Fire Suppression')?.status).not.toBe('missing');
  } finally {
    await deleteSaved(request);
  }
});

test('the refrigerant form lists no fire device for a new line and no fire gas for a new record', async ({ page }) => {
  await openForm(page, 'Refrigerants');
  await page.getByRole('combobox', { name: en.fuelOrGas }).click();
  const gases = page.getByRole('option');
  await expect(gases.filter({ hasText: en.activityTypes['R-410A'] })).toHaveCount(1);
  await expect(gases.filter({ hasText: 'HFC-227ea' })).toHaveCount(0);
  await expect(gases.filter({ hasText: 'SF6' })).toHaveCount(0);
  await gases.filter({ hasText: en.activityTypes['R-410A'] }).click();

  await page.getByRole('combobox', { name: `${en.inputs.equipmentType} 1` }).click();
  const devices = page.getByRole('option');
  await expect(devices.filter({ hasText: en.equipmentTypes.chiller })).toHaveCount(1);
  for (const device of ['fire_extinguisher', 'fire_suppression_system', 'transformer_breaker'] as const) {
    await expect(devices.filter({ hasText: new RegExp(`^${en.equipmentTypes[device]}$`) })).toHaveCount(0);
  }
  // Kilograms, and no unit selector, on a refrigerant line.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: `${fire.unit} 1` })).toHaveCount(0);
});
