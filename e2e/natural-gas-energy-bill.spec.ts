import { test, expect, type Page } from '@playwright/test';
import enCategories from '../apps/web/messages/en/categories.json';
import enDataEntry from '../apps/web/messages/en/dataEntry.json';
import enPeriods from '../apps/web/messages/en/periods.json';
import enReview from '../apps/web/messages/en/review.json';
import enUnits from '../apps/web/messages/en/units.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  CONSULTANT_EMAIL,
  E2E_TR_INPUTS,
  E2E_TR_INPUTS_YEAR,
  ENTRY_EMAIL,
  SUB,
  approveRecord,
  attachEvidence,
  bearer,
  cleanupE2ELocations,
  cleanupTrInputsFixture,
  deleteRecordsAsService,
  findRecordId,
  getAccessToken,
  login,
  pickByFieldLabel,
  postBulkImport,
  seedTrInputsFixture,
  switchUser,
} from './helpers';

/**
 * UAT round 3, LP4-06 (Decisions 2026-11-20 D2): a TR natural gas bill in kWh.
 * `ng-kwh-engine`: imported with its calorific basis, then opened on Data
 * Entry, which carries the stored basis through an unrelated edit, the save
 * and the submit, and the review sheet shows it, so the reviewer can check it
 * against the bill. `ng-kwh-form`: entered on the form, which asks for the
 * basis with no default and shows a gross bill's net figure before save.
 *
 * Priced by the TR inputs fixture (`seedTrInputsFixture`: reference NCV 9,000,
 * GCV 10,000, gas factor 0.2), never the TR package: 1,000 kWh gross is
 * 1,000 × 0.9 × 0.2 = 180 kg here. The package's 182.17 kg is asserted against
 * the real release in `tr-factor-package.int.spec.ts`.
 *
 * Lane: `SUB.logistics` (TR), Natural Gas, quarterly Q1 of `E2E_TR_INPUTS_YEAR`,
 * which no other spec writes. The record is deleted in `finally`.
 */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => seedTrInputsFixture());
test.afterAll(async ({ request }) => {
  await cleanupE2ELocations(request);
  await cleanupTrInputsFixture();
});

/** The records a test imported, removed after it whatever its outcome. */
const created: string[] = [];
test.afterEach(async ({ request }) => {
  if (created.length > 0) await deleteRecordsAsService(request, created.splice(0));
});

const SUBSIDIARY_OPTION = 'TonyAI Logistics (TR)';
const LOGISTICS = 'TonyAI Logistics';
const EXPECTED_KG = 1000 * (E2E_TR_INPUTS.referenceNcv / E2E_TR_INPUTS.referenceGcv) * E2E_TR_INPUTS.gasFactor;

const csv = (cvBasis: string, periodValue = 'Q1', locationId = '') =>
  Buffer.from(
    [
      'subsidiaryId,locationId,reportingYear,reportingPeriod,periodValue,category,activityValue,activityUnit,varianceReason,cvBasis',
      [SUB.logistics, locationId, String(E2E_TR_INPUTS_YEAR), 'quarterly', periodValue, 'Natural Gas', '1000', 'kWh', '', cvBasis].join(','),
    ].join('\n'),
    'utf8',
  );

async function post(request: import('@playwright/test').APIRequestContext, token: string, path: string, data?: unknown) {
  const res = await request.post(`${API_BASE}${path}`, { headers: bearer(token), ...(data ? { data } : {}) });
  if (!res.ok()) throw new Error(`POST ${path} failed: ${res.status()} ${await res.text()}`);
}

const listOf = (page: Page) => page.locator('[data-testid="previous-submissions"]');
const basis = (page: Page, value: 'net' | 'gross') =>
  page.getByTestId('gas-energy-basis').getByRole('radio', { name: enDataEntry.inputs.cvBasis[value], exact: true });

/** A new Data Entry form on the lane's Natural Gas Q1, with the user's unit picked. */
async function newBill(page: Page, unit: 'kWh' | 'MWh') {
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.category, enCategories['Natural Gas']);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));
  await pickByFieldLabel(page, enDataEntry.period, enPeriods.granularity.quarterly);
  await pickByFieldLabel(page, enDataEntry.periodValue, enPeriods.values.Q1);
  const unitSelect = page.getByRole('combobox', { name: enDataEntry.unit, exact: true });
  await unitSelect.click();
  await page.getByRole('option', { name: unit, exact: true }).click();
  await expect(unitSelect).toHaveText(unit);
}

test('an imported gross kWh bill keeps its basis through an edit on Data Entry, the submit and the review sheet', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await postBulkImport(request, token, { buffer: csv('GROSS'), dryRun: 'false' });
  expect(res.ok(), await res.text()).toBe(true);
  const report = await res.json();
  expect(report.errors).toEqual([]);
  const id = report.accepted[0].recordId as string;
  created.push(id);
  const imported = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
  expect(imported.parameters).toEqual({ cvBasis: 'gross' });
  expect(imported.calculation.kgCo2e).toBeCloseTo(EXPECTED_KG, 9);
  // Natural Gas needs its evidence at submit (K3).
  await attachEvidence(request, token, id);

  // Data Entry: the stored basis comes selected, with no volume field to edit.
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));
  await listOf(page).getByRole('button', { name: `Edit Q1 ${E2E_TR_INPUTS_YEAR} Natural Gas` }).click();
  await expect(page.getByTestId('edit-mode-band')).toBeVisible();
  await expect(basis(page, 'gross')).toBeChecked();
  await expect(basis(page, 'net')).not.toBeChecked();
  await expect(page.getByTestId('gas-inputs')).toHaveCount(0);
  // The preview prices the bill on its stored basis, not as a missing one.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.18');
  // It names the reduction to net (the fixture's 9,000 / 10,000), never "kWh to kWh".
  await expect(page.getByTestId('gross-to-net-note')).toContainText('× 0.9');
  await expect(page.getByText('Unit converted from kWh to kWh', { exact: false })).toHaveCount(0);

  // An unrelated edit: a note in Additional context.
  await page.getByRole('button', { name: enDataEntry.context.title }).click();
  await page.getByPlaceholder(enDataEntry.context.other.notes.placeholder).fill('e2e: meter read from the bill');
  await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();
  await expect(page.getByText('Changes saved to the record.')).toBeVisible();

  const saved = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
  expect(saved).toMatchObject({ id, status: 'draft', activityUnit: 'kWh', activityValue: 1000, parameters: { cvBasis: 'gross' } });
  expect(saved.calculation.kgCo2e).toBeCloseTo(imported.calculation.kgCo2e, 9);

  // Submit from the form: the recompute agrees with the stored figure.
  await listOf(page).getByRole('button', { name: `Edit Q1 ${E2E_TR_INPUTS_YEAR} Natural Gas` }).click();
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByText('Submitted for review', { exact: true })).toBeVisible();
  const submitted = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
  expect(submitted).toMatchObject({ status: 'submitted', parameters: { cvBasis: 'gross' } });

  // The review sheet shows the basis beside the quantity.
  await switchUser(page, CONSULTANT_EMAIL);
  await page.goto('/review');
  await page
    .locator('table tbody tr')
    .filter({ hasText: LOGISTICS })
    .filter({ hasText: `Q1 ${E2E_TR_INPUTS_YEAR}` })
    .filter({ hasText: 'Natural Gas' })
    .click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(enReview.sheet.calorificBasis, { exact: true })).toBeVisible();
  await expect(sheet.getByTestId('review-calorific-basis')).toHaveText(enReview.sheet.calorificBasisValue.gross);
});

test('a voided net kWh bill is copied with its unit, quantity and basis, and moving the copy outside Türkiye asks for the gross figure', async ({ page, request }) => {
  // The admin authors it, so the admin may copy it, and may pick a UK subsidiary.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const res = await postBulkImport(request, token, { buffer: csv('net', 'Q2'), dryRun: 'false' });
  expect(res.ok(), await res.text()).toBe(true);
  const report = await res.json();
  expect(report.errors).toEqual([]);
  const id = report.accepted[0].recordId as string;
  created.push(id);
  await attachEvidence(request, token, id);
  await post(request, token, `/activity-records/${id}/submit`);
  // A second super_admin approves: nobody approves their own record.
  await approveRecord(request, await getAccessToken(request, APPROVER_EMAIL), id);
  await post(request, token, `/activity-records/${id}/void`, { voidReason: 'e2e: copied to a new draft' });

  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));
  await listOf(page).getByRole('button', { name: `Copy Q2 ${E2E_TR_INPUTS_YEAR} Natural Gas to a new draft` }).click();
  await expect(page.getByText(enDataEntry.copy.loaded)).toBeVisible();

  // The copy keeps the bill as it was: kWh, 1,000 and its net basis, not Sm³.
  const value = page.getByPlaceholder(enDataEntry.activityValuePlaceholder);
  await expect(page.getByRole('combobox', { name: enDataEntry.unit, exact: true })).toHaveText('kWh');
  await expect(value).toHaveValue('1000');
  await expect(basis(page, 'net')).toBeChecked();
  // 1,000 kWh net × 0.2 = 200 kg.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.2');

  // Outside Türkiye an energy bill is priced as gross: the net figure is asked for again.
  await pickByFieldLabel(page, enDataEntry.subsidiary, 'TonyAI Gas (UK)');
  await expect(page.getByText(enDataEntry.inputs.basisReset)).toBeVisible();
  await expect(value).toHaveValue('');
  await expect(page.getByTestId('gas-energy-basis')).toHaveCount(0);

  // The basis went with the figure: the gross figure typed outside Türkiye is
  // never priced as net when the copy comes back (qa-auditor S1). The choice
  // is asked for again, with neither option selected (ng-kwh-form).
  await value.fill('1109.7');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await expect(page.getByTestId('gas-energy-basis')).toBeVisible();
  await expect(basis(page, 'net')).not.toBeChecked();
  await expect(basis(page, 'gross')).not.toBeChecked();
  await expect(page.getByTestId('gas-energy-basis-missing')).toBeVisible();
  await expect(page.getByTestId('preview-tco2e')).toHaveCount(0);
  await expect(page.getByRole('button', { name: enDataEntry.saveDraft, exact: true })).toBeDisabled();
});

test('switching an imported kWh bill to Sm³ clears its figure and basis, and kWh stays on offer (ng-kwh-engine review)', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await postBulkImport(request, token, { buffer: csv('gross', 'Q3'), dryRun: 'false' });
  expect(res.ok(), await res.text()).toBe(true);
  const report = await res.json();
  expect(report.errors).toEqual([]);
  created.push(report.accepted[0].recordId as string);

  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));
  await listOf(page).getByRole('button', { name: `Edit Q3 ${E2E_TR_INPUTS_YEAR} Natural Gas` }).click();
  const value = page.getByPlaceholder(enDataEntry.activityValuePlaceholder);
  await expect(value).toHaveValue('1000');

  // 1,000 kWh is not 1,000 Sm³: the figure and the basis go, never priced as a volume.
  const unit = page.getByRole('combobox', { name: enDataEntry.unit, exact: true });
  await unit.click();
  await page.getByRole('option', { name: enUnits.label.standard_cubic_metres, exact: true }).click();
  await expect(page.getByText(enDataEntry.inputs.unitChangeReset)).toBeVisible();
  await expect(value).toHaveValue('');
  await expect(page.getByTestId('preview-tco2e')).toHaveCount(0);

  // The record's own unit is still listed, so the change can be undone.
  await unit.click();
  await expect(page.getByRole('option', { name: 'kWh', exact: true })).toBeVisible();
  await page.getByRole('option', { name: 'kWh', exact: true }).click();
  await expect(unit).toHaveText('kWh');
  // Undoing brings the record's own basis back: the figure entered again is priced as before (third review).
  await expect(basis(page, 'gross')).toBeChecked();
  await value.fill('1000');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.18');
});

test('a net kWh draft on a site created and re-classified after the page loaded asks for the gross figure, once (ng-kwh-engine reviews)', async ({ page, request }) => {
  // The page loads its sites first; the site below does not exist yet.
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));

  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const made = await request.post(`${API_BASE}/locations`, {
    headers: bearer(admin),
    data: { subsidiaryId: SUB.logistics, name: 'E2E ng-kwh re-classified site', geographyCode: 'TR' },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const site = (await made.json()) as { id: string };
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await postBulkImport(request, token, { buffer: csv('net', 'Q4', site.id), dryRun: 'false' });
  expect(res.ok(), await res.text()).toBe(true);
  const report = await res.json();
  expect(report.errors).toEqual([]);
  created.push(report.accepted[0].recordId as string);
  // Re-classified after the draft was priced under the TR rules (subsidiary: TR, site: now UK).
  const moved = await request.patch(`${API_BASE}/locations/${site.id}`, { headers: bearer(admin), data: { geographyCode: 'UK' } });
  expect(moved.ok(), await moved.text()).toBe(true);

  // The records list is read again by switching the subsidiary away and back,
  // without reloading the page: its list of sites is still the one it opened with.
  await pickByFieldLabel(page, enDataEntry.subsidiary, 'TonyAI Energy (TR)');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await listOf(page).getByRole('button', { name: new RegExp(`^Edit Q4 ${E2E_TR_INPUTS_YEAR} Natural Gas`) }).click();

  // Outside Türkiye the stored net figure would be priced as gross: cleared on opening, with its basis.
  const value = page.getByPlaceholder(enDataEntry.activityValuePlaceholder);
  await expect(page.getByText(enDataEntry.inputs.basisReset)).toBeVisible();
  await expect(value).toHaveValue('');
  await expect(page.getByTestId('gas-energy-basis')).toHaveCount(0);
  // Typing the gross figure does not set it off again.
  await value.fill('1109.7');
  await expect(value).toHaveValue('1109.7');
  await expect(page.getByText(enDataEntry.inputs.basisReset)).toHaveCount(1);
});

test('a TR gas bill entered on the form in kWh asks for its basis, and a gross one shows its net figure before save (ng-kwh-form)', async ({ page, request }) => {
  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.category, enCategories['Natural Gas']);
  // A new TR gas record still starts on m³, though the form opened on kWh (Decision 1), and
  // offers a bill's units after the volumes.
  const unit = page.getByRole('combobox', { name: enDataEntry.unit, exact: true });
  await expect(unit).toHaveText(enUnits.label.cubic_metres);
  await unit.click();
  await expect(page.getByRole('option')).toHaveText([
    enUnits.label.cubic_metres,
    enUnits.label.standard_cubic_metres,
    enUnits.label.kWh,
    enUnits.label.MWh,
  ]);
  await page.getByRole('option', { name: enUnits.label.kWh, exact: true }).click();
  await expect(unit).toHaveText('kWh');
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));
  await pickByFieldLabel(page, enDataEntry.period, enPeriods.granularity.quarterly);
  await pickByFieldLabel(page, enDataEntry.periodValue, enPeriods.values.Q1);

  const value = page.getByPlaceholder(enDataEntry.activityValuePlaceholder);
  await value.fill('1000');
  // No basis yet: no volume field, neither option chosen, nothing priced, nothing to save.
  await expect(page.getByTestId('gas-inputs')).toHaveCount(0);
  await expect(basis(page, 'net')).not.toBeChecked();
  await expect(basis(page, 'gross')).not.toBeChecked();
  await expect(page.getByTestId('gas-energy-basis-missing')).toHaveText(enDataEntry.inputs.cvBasis.missing);
  await expect(page.getByTestId('preview-tco2e')).toHaveCount(0);
  await expect(page.getByRole('button', { name: enDataEntry.saveDraft, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Submit for review', exact: true })).toBeDisabled();

  // Gross: the net figure and the release's ratio before save (fixture 9,000 / 10,000).
  await basis(page, 'gross').click();
  await expect(page.getByTestId('gas-energy-basis-missing')).toHaveCount(0);
  const derived = page.getByTestId('gas-energy-derived-net');
  await expect(derived).toContainText('900 kWh');
  await expect(derived).toContainText('× 0.9 (9,000 / 10,000');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.18');

  // The basis is corrected, not the bill: the figure stays.
  await basis(page, 'net').click();
  await expect(value).toHaveValue('1000');
  await expect(derived).toHaveCount(0);
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.2');
  await basis(page, 'gross').click();
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.18');

  await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();
  await expect(page.getByText(enDataEntry.draftSaved)).toBeVisible();
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const id = await findRecordId(request, token, { subsidiaryId: SUB.logistics, category: 'Natural Gas', reportingPeriod: 'quarterly', periodValue: 'Q1' });
  created.push(id);
  const saved = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
  expect(saved).toMatchObject({ activityUnit: 'kWh', activityValue: 1000, parameters: { cvBasis: 'gross' } });
  expect(saved.calculation.kgCo2e).toBeCloseTo(EXPECTED_KG, 9);
});

const savedQ1 = async (request: import('@playwright/test').APIRequestContext) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const id = await findRecordId(request, token, { subsidiaryId: SUB.logistics, category: 'Natural Gas', reportingPeriod: 'quarterly', periodValue: 'Q1' });
  created.push(id);
  return (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
};

test('a gross MWh bill shows its net figure in MWh and is saved in MWh (ng-kwh-form)', async ({ page, request }) => {
  await newBill(page, 'MWh');
  await page.getByPlaceholder(enDataEntry.activityValuePlaceholder).fill('1');
  await basis(page, 'gross').click();
  await expect(page.getByTestId('gas-energy-derived-net')).toContainText('0.9 MWh');
  // 1 MWh gross × 0.9 × 0.2 = 180 kg.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.18');
  await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();
  await expect(page.getByText(enDataEntry.draftSaved)).toBeVisible();
  const saved = await savedQ1(request);
  expect(saved).toMatchObject({ activityUnit: 'MWh', activityValue: 1, parameters: { cvBasis: 'gross' } });
  expect(saved.calculation.kgCo2e).toBeCloseTo(EXPECTED_KG, 9);
});

test('a change of scale keeps the basis, and a net kWh bill is saved as entered (ng-kwh-form)', async ({ page, request }) => {
  await newBill(page, 'MWh');
  const value = page.getByPlaceholder(enDataEntry.activityValuePlaceholder);
  await value.fill('1');
  await basis(page, 'gross').click();
  // A change of scale asks for the figure again and keeps the basis.
  const unit = page.getByRole('combobox', { name: enDataEntry.unit, exact: true });
  await unit.click();
  await page.getByRole('option', { name: 'kWh', exact: true }).click();
  await expect(value).toHaveValue('');
  await expect(basis(page, 'gross')).toBeChecked();

  await basis(page, 'net').click();
  await value.fill('1000');
  // 1,000 kWh net × 0.2 = 200 kg.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.2');
  await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();
  await expect(page.getByText(enDataEntry.draftSaved)).toBeVisible();
  const saved = await savedQ1(request);
  expect(saved).toMatchObject({ activityUnit: 'kWh', activityValue: 1000, parameters: { cvBasis: 'net' } });
  expect(saved.calculation.kgCo2e).toBeCloseTo(1000 * E2E_TR_INPUTS.gasFactor, 9);
});

test('an imported net bill\'s basis is corrected to gross on Data Entry, the figure kept (ng-kwh-form)', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await postBulkImport(request, token, { buffer: csv('net'), dryRun: 'false' });
  expect(res.ok(), await res.text()).toBe(true);
  const report = await res.json();
  expect(report.errors).toEqual([]);
  const id = report.accepted[0].recordId as string;
  created.push(id);

  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));
  await listOf(page).getByRole('button', { name: `Edit Q1 ${E2E_TR_INPUTS_YEAR} Natural Gas` }).click();
  await expect(basis(page, 'net')).toBeChecked();
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.2');
  await basis(page, 'gross').click();
  await expect(page.getByPlaceholder(enDataEntry.activityValuePlaceholder)).toHaveValue('1000');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.18');
  await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();
  await expect(page.getByText('Changes saved to the record.')).toBeVisible();
  const saved = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
  expect(saved).toMatchObject({ id, activityUnit: 'kWh', activityValue: 1000, parameters: { cvBasis: 'gross' } });
  expect(saved.calculation.kgCo2e).toBeCloseTo(EXPECTED_KG, 9);
});
