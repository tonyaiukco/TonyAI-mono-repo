import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import en from '../apps/web/messages/en/dataEntry.json';
import enFuel from '../apps/web/messages/en/fuelFiles.json';
import trFuel from '../apps/web/messages/tr/fuelFiles.json';
import enNav from '../apps/web/messages/en/nav.json';
import trNav from '../apps/web/messages/tr/nav.json';
import enCategories from '../apps/web/messages/en/categories.json';
import enPeriods from '../apps/web/messages/en/periods.json';
import enUnits from '../apps/web/messages/en/units.json';
import enErrors from '../apps/web/messages/en/errors.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  E2E_YEAR,
  FUEL_FIXTURES,
  SUB,
  bearer,
  cleanupFuelData,
  cleanupFuelFactorFixture,
  deleteRecordsAsService,
  getAccessToken,
  login,
  pickByFieldLabel,
  seedFuelFactorFixture,
  listFuelUploads,
} from './helpers';

/**
 * inc28-fuel-bulk task 10.3: Data Entry's fuel and usage for a company on the
 * Türkiye factor set — the usage is mandatory, a stationary pair is filed as a
 * `Fuel` record (LPG in kg), marine gas oil's usage is fixed, another fuel is
 * added for the same period, and the card-fuel note reads in Turkish and
 * English — and the tanker file: read first, declared per delivery, with its
 * `TOPLAM` row refused.
 *
 * Lane: TonyAI Energy (TR), `E2E_YEAR` Q4 (and Q3) quarterly, drafts only, deleted in
 * `afterAll` (and swept by the quarterly teardown). The tanker upload is the
 * super_admin's (its import budget is its own); its rows wait for accounts and
 * are removed by `cleanupFuelData`. The fixture release prices the pairs where
 * no TR release exists (CI).
 */
test.describe.configure({ mode: 'serial' });

const COMPANY = 'TonyAI Energy (TR)';
const PERIOD_VALUE = 'Q4';
const CATEGORIES_USED = ['Fuel', 'Mobile Combustion'];

interface EntryRecord {
  id: string;
  category: string;
  activityType: string | null;
  activityValue: number;
  activityUnit: string;
}

/** The lane's records of one category, read through the API. */
async function laneRecords(request: APIRequestContext, category: string, periodValue = PERIOD_VALUE): Promise<EntryRecord[]> {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const query = new URLSearchParams({
    subsidiaryId: SUB.energy, year: String(E2E_YEAR), period: 'quarterly', periodValue, category, locationId: 'none', limit: '50',
  });
  const res = await request.get(`${API_BASE}/activity-records?${query}`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { items: EntryRecord[] }).items;
}

async function clearLane(request: APIRequestContext): Promise<void> {
  const ids: string[] = [];
  for (const periodValue of [PERIOD_VALUE, 'Q3']) {
    for (const category of CATEGORIES_USED) ids.push(...(await laneRecords(request, category, periodValue)).map((r) => r.id));
  }
  await deleteRecordsAsService(request, ids);
}

test.beforeAll(async ({ request }) => {
  await clearLane(request);
  await cleanupFuelData(request);
  await seedFuelFactorFixture();
});
test.afterAll(async ({ request }) => {
  await clearLane(request);
  await cleanupFuelData(request);
  await cleanupFuelFactorFixture();
});

const fuelSelect = (page: Page) => page.getByTestId('fuel-pair-fuel');
const usageSelect = (page: Page) => page.getByTestId('fuel-pair-usage');
const unitSelect = (page: Page) => page.getByRole('combobox', { name: en.unit, exact: true });
const quantity = (page: Page) => page.getByPlaceholder(en.activityValuePlaceholder);
const saveDraft = (page: Page) => page.getByRole('button', { name: en.saveDraft });

async function choose(page: Page, trigger: Locator, option: string): Promise<void> {
  await trigger.click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(page.getByRole('option', { name: option, exact: true })).toBeHidden();
}

async function openMobileCombustion(page: Page): Promise<void> {
  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, en.subsidiary, COMPANY);
  await pickByFieldLabel(page, en.category, enCategories['Mobile Combustion']);
  await pickByFieldLabel(page, en.reportingYear, String(E2E_YEAR));
  await pickByFieldLabel(page, en.period, enPeriods.granularity.quarterly);
  await pickByFieldLabel(page, en.periodValue, enPeriods.values[PERIOD_VALUE]);
}

async function save(page: Page): Promise<void> {
  await saveDraft(page).click();
  await expect(page.getByText(en.draftSaved)).toBeVisible();
}

/**
 * "Add another fuel": the same company and period kept; the fuel, usage and
 * quantity cleared in the form's state (the save names the missing fuel). The
 * Fuel control's own display is the test further down.
 */
async function addAnother(page: Page): Promise<void> {
  await page.getByTestId('add-another-fuel').click();
  await expect(page.getByTestId('fuel-pair-missing')).toHaveText(enFuel.entry.chooseFuel);
  await expect(quantity(page)).toHaveValue('');
  await expect(saveDraft(page)).toBeDisabled();
  await expect(page.locator('div.space-y-2', { has: page.getByText(en.subsidiary, { exact: true }) }).getByRole('combobox')).toHaveText(COMPANY);
}

const byType = (records: EntryRecord[]) =>
  records.map((r) => [r.activityType, r.activityValue, r.activityUnit]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

test('the usage is mandatory, and generator diesel is saved as a Fuel record in litres', async ({ page, request }) => {
  await openMobileCombustion(page);

  // ── Nothing preselected; the save waits and names what is missing. The old single select is gone.
  await expect(fuelSelect(page)).toHaveText(en.chooseOne);
  await expect(usageSelect(page)).toBeDisabled();
  await expect(page.getByTestId('fuel-pair-missing')).toHaveText(enFuel.entry.chooseFuel);
  await expect(page.getByText(en.vehicleMode, { exact: true })).toHaveCount(0);
  await expect(saveDraft(page)).toBeDisabled();

  await choose(page, fuelSelect(page), enFuel.fuels.diesel);
  await expect(usageSelect(page)).toHaveText(en.chooseOne);
  await expect(page.getByTestId('fuel-pair-missing')).toHaveText(enFuel.entry.chooseUsage);
  await quantity(page).fill('120');
  await expect(saveDraft(page)).toBeDisabled();
  await usageSelect(page).click();
  for (const usage of [enFuel.usages.on_road, enFuel.usages.off_road, enFuel.usages.stationary]) {
    await expect(page.getByRole('option', { name: usage, exact: true })).toBeVisible();
  }
  await page.getByRole('option', { name: enFuel.usages.stationary, exact: true }).click();

  // ── Generator diesel: the form says it is filed under stationary combustion; the record is Fuel, diesel, litres.
  await expect(page.getByTestId('fuel-pair-missing')).toHaveCount(0);
  await expect(page.getByTestId('fuel-pair-stationary')).toHaveText(enFuel.entry.stationaryLine);
  await expect(page.locator('div.space-y-2', { has: page.getByText(en.category, { exact: true }) }).getByRole('combobox')).toHaveText(enCategories.Fuel);
  await expect(unitSelect(page)).toHaveText(enUnits.label.litres);
  await quantity(page).fill('120');
  await save(page);
  expect(byType(await laneRecords(request, 'Fuel'))).toEqual([['diesel', 120, 'litres']]);
  expect(await laneRecords(request, 'Mobile Combustion')).toEqual([]);
});

test('stationary LPG is entered in kg only, and LPG is offered no off-road', async ({ page, request }) => {
  await openMobileCombustion(page);
  await choose(page, fuelSelect(page), enFuel.fuels.lpg);
  await usageSelect(page).click();
  await expect(page.getByRole('option', { name: enFuel.usages.on_road, exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: enFuel.usages.stationary, exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: enFuel.usages.off_road, exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: enFuel.usages.stationary, exact: true }).click();
  await expect(page.getByTestId('fuel-pair-stationary')).toBeVisible();
  await expect(unitSelect(page)).toHaveText(enUnits.label.kg);
  await unitSelect(page).click();
  await expect(page.getByRole('option', { name: enUnits.label.litres, exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: enUnits.label.kg, exact: true }).click();
  await quantity(page).fill('50');
  await save(page);
  expect(byType(await laneRecords(request, 'Fuel'))).toEqual([
    ['diesel', 120, 'litres'],
    ['lpg', 50, 'kg'],
  ]);
});

test('marine gas oil reads a fixed "Marine (vessel)" usage, in kg or tonnes', async ({ page, request }) => {
  await openMobileCombustion(page);
  await choose(page, fuelSelect(page), enFuel.fuels.marine_gas_oil);
  await expect(page.getByTestId('fuel-pair-marine')).toHaveText(enFuel.usages.marine);
  await expect(usageSelect(page)).toHaveCount(0);
  await expect(page.getByTestId('fuel-pair-missing')).toHaveCount(0);
  await expect(page.getByTestId('fuel-pair-stationary')).toHaveCount(0);
  await expect(page.getByText(en.inputs.marineGasOilScope)).toBeVisible();
  await expect(unitSelect(page)).toHaveText(enUnits.label.kg);
  await unitSelect(page).click();
  await expect(page.getByRole('option', { name: enUnits.label.tonnes, exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: enUnits.label.litres, exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: enUnits.label.kg, exact: true }).click();
  await quantity(page).fill('2');
  await save(page);
  expect(byType(await laneRecords(request, 'Mobile Combustion'))).toEqual([['marine_gas_oil', 2, 'kg']]);
});

test('"Add another fuel" keeps the company and period: a second fuel is its own record in the same period', async ({ page, request }) => {
  await openMobileCombustion(page);
  await choose(page, fuelSelect(page), enFuel.fuels.diesel);
  await choose(page, usageSelect(page), enFuel.usages.on_road);
  await expect(page.getByTestId('fuel-pair-stationary')).toHaveCount(0);
  await expect(unitSelect(page)).toHaveText(enUnits.label.litres);
  await quantity(page).fill('100');
  await save(page);

  // Off-road petrol, not the spec's on-road petrol: choosing the usage just
  // saved again is the test below.
  await addAnother(page);
  await choose(page, fuelSelect(page), enFuel.fuels.petrol);
  await choose(page, usageSelect(page), enFuel.usages.off_road);
  await expect(page.getByTestId('fuel-pair-missing')).toHaveCount(0);
  await quantity(page).fill('80');
  await save(page);

  // Each fuel its own record, both in Q4: the period, company and site were kept.
  expect(byType(await laneRecords(request, 'Mobile Combustion'))).toEqual([
    ['marine_gas_oil', 2, 'kg'],
    ['off_road_petrol', 80, 'litres'],
    ['on_road_diesel', 100, 'litres'],
  ]);
  expect(byType(await laneRecords(request, 'Fuel'))).toEqual([
    ['diesel', 120, 'litres'],
    ['lpg', 50, 'kg'],
  ]);
});

// Regression guard (inc28-fuel-bulk): after "Add another fuel" both controls show their placeholder
// again (a cleared Radix Select needs "", never undefined), so the same fuel and usage can be chosen.
test('after "Add another fuel" both controls are cleared: on-road petrol follows on-road diesel, and the same fuel can be chosen again', async ({ page, request }) => {
  await openMobileCombustion(page);
  await pickByFieldLabel(page, en.periodValue, enPeriods.values.Q3);
  await choose(page, fuelSelect(page), enFuel.fuels.diesel);
  await choose(page, usageSelect(page), enFuel.usages.on_road);
  await quantity(page).fill('10');
  await save(page);
  await addAnother(page);
  await expect(fuelSelect(page)).toHaveText(en.chooseOne);
  await expect(usageSelect(page)).toHaveText(en.chooseOne);
  await choose(page, fuelSelect(page), enFuel.fuels.diesel);
  await expect(page.getByTestId('fuel-pair-missing')).toHaveText(enFuel.entry.chooseUsage);
  await expect(usageSelect(page)).toBeEnabled();
  await choose(page, fuelSelect(page), enFuel.fuels.petrol);
  await choose(page, usageSelect(page), enFuel.usages.on_road);
  await expect(page.getByTestId('fuel-pair-missing')).toHaveCount(0);
  await quantity(page).fill('8');
  await save(page);
  expect(byType(await laneRecords(request, 'Mobile Combustion', 'Q3'))).toEqual([
    ['on_road_diesel', 10, 'litres'],
    ['on_road_petrol', 8, 'litres'],
  ]);
});

test('the card-fuel note shows on Mobile Combustion and Fuel, in English and Turkish; a company off the TR set keeps the old entry', async ({ page }) => {
  await openMobileCombustion(page);
  const note = page.getByTestId('card-fuel-note');
  await expect(note).toContainText(enFuel.entry.cardFuelNote);
  await expect(note.getByRole('link', { name: enFuel.entry.fuelFilesLink })).toHaveAttribute('href', '/fuel-files');
  await pickByFieldLabel(page, en.category, enCategories.Fuel);
  await expect(note).toContainText(enFuel.entry.cardFuelNote);

  await page.getByRole('button', { name: enNav.languages.tr }).click();
  try {
    await expect(note).toContainText(trFuel.entry.cardFuelNote);
    await expect(note.getByRole('link', { name: trFuel.entry.fuelFilesLink })).toBeVisible();
  } finally {
    await page.getByRole('button', { name: trNav.languages.en }).click();
  }
  await expect(note).toContainText(enFuel.entry.cardFuelNote);

  // A company on another factor set: no note, no fuel-and-usage pair; Mobile Combustion asks its type as before.
  await pickByFieldLabel(page, en.subsidiary, 'TonyAI Gas (UK)');
  await pickByFieldLabel(page, en.category, enCategories['Mobile Combustion']);
  await expect(note).toHaveCount(0);
  await expect(fuelSelect(page)).toHaveCount(0);
  await expect(page.getByText(en.fuelOrGas, { exact: true })).toBeVisible();
});

test('a tanker file is read first and declared per delivery; its TOPLAM row is refused', async ({ page, request }) => {
  await login(page, APPROVER_EMAIL);
  await page.goto('/fuel-files');
  await expect(page.getByRole('heading', { name: enFuel.title })).toBeVisible();
  await page.locator('#fuel-source').click();
  await page.getByRole('option', { name: enFuel.sources.tanker, exact: true }).click();
  // A tanker file declares its usage per delivery, not for the file.
  await expect(page.locator('#fuel-usage')).toHaveCount(0);
  await page.locator('#fuel-file').setInputFiles(FUEL_FIXTURES.tanker);
  await page.getByRole('button', { name: enFuel.upload.read }).click();

  // ── The first read stores nothing: five deliveries ask for a declaration; the total row is refused.
  await expect(page.getByText('6 rows read · 1 refused · 0 already stored or repeated')).toBeVisible();
  await expect(page.getByText(`Row 9: ${enErrors.bulkUploadIssues.fuel_key_missing}`)).toBeVisible();
  const deliveries = page.locator('table tbody tr', { has: page.getByRole('combobox', { name: enFuel.upload.fuel }) });
  await expect(deliveries).toHaveCount(5);
  await expect(page.locator('table tbody tr', { hasText: 'TOPLAM' })).toHaveCount(0);
  for (const name of [enFuel.upload.fuel, enFuel.upload.usage, enFuel.upload.year, enFuel.upload.month]) {
    const controls = deliveries.getByRole('combobox', { name, exact: true });
    await expect(controls).toHaveCount(5);
    for (let i = 0; i < 5; i += 1) await expect(controls.nth(i)).toHaveText(enFuel.upload.choose);
  }
  await expect(page.getByText(enFuel.upload.declareAll)).toBeVisible();
  const apply = page.getByRole('button', { name: enFuel.upload.apply });
  await expect(apply).toBeDisabled();
  const token = await getAccessToken(request, APPROVER_EMAIL);
  expect(await listFuelUploads(request, token)).toEqual([]);

  // ── One delivery declared: generator diesel, March 2025. The rest still hold the apply.
  const first = deliveries.filter({ hasText: '000101' });
  await expect(first).toContainText('ÖRNEK DEPO A.Ş.');
  await expect(first).toContainText('10,000 L');
  await choose(page, first.getByRole('combobox', { name: enFuel.upload.fuel, exact: true }), enFuel.fuels.diesel);
  await choose(page, first.getByRole('combobox', { name: enFuel.upload.usage, exact: true }), enFuel.usages.stationary);
  await choose(page, first.getByRole('combobox', { name: enFuel.upload.year, exact: true }), '2025');
  await choose(page, first.getByRole('combobox', { name: enFuel.upload.month, exact: true }), enPeriods.values.March);
  await expect(apply).toBeDisabled();
  await expect(page.getByText(enFuel.upload.declareAll)).toBeVisible();

  // "Copy to all" repeats its choices; every delivery is declared and the file can be applied.
  await first.getByRole('button', { name: enFuel.upload.copyToAll }).click();
  await expect(page.getByText(enFuel.upload.declareAll)).toHaveCount(0);
  await expect(deliveries.getByRole('combobox', { name: enFuel.upload.usage, exact: true }).nth(4)).toHaveText(enFuel.usages.stationary);
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.getByText('5 rows stored.')).toBeVisible();

  // Stored, one row per delivery; no account maps these receiving companies yet, so they wait.
  const listed = await listFuelUploads<{
    createdAt: string; source: string; rowsRead: number; rowsRefused: number; rowsDuplicate: number; rows: Record<string, { rows: number; litres: string }>;
  }>(request, token);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ source: 'tanker', rowsRead: 6, rowsRefused: 1, rowsDuplicate: 0 });
  expect(listed[0].rows.waiting_account.rows).toBe(5);
  expect(Number(listed[0].rows.waiting_account.litres)).toBeCloseTo(42750.75, 6);
});
