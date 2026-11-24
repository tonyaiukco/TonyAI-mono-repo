import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
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
  auditRowsFor,
  bearer,
  cleanupE2ELocations,
  cleanupTrInputsFixture,
  deleteRecordsAsService,
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
 * against the bill. `ng-kwh-form`: entered on the form, which shows a gross
 * bill's net figure before save. `uat4-quick-fixes` (UAT round 4, BUG-11): the
 * form offers the bill's own figure first and comes with it selected (gross),
 * so a bill nobody clicked on is saved as gross; net comes only from the
 * record or from the author's click.
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

/**
 * Saves the form's draft and returns the stored record. Its id comes from the
 * create's own answer and joins the teardown at once, before anything else is
 * asserted: a missed toast or a failed lookup cannot leak a draft that would
 * collide with the next run, and no list search by period can pick another
 * year's record up for deletion (ng-kwh-form review).
 */
const saveDraft = async (page: Page, request: APIRequestContext) => {
  const createdResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/activity-records'),
  );
  await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();
  const response = await createdResponse;
  expect(response.status()).toBe(201);
  const id = (await response.json()).id as string;
  created.push(id);
  await expect(page.getByText(enDataEntry.draftSaved)).toBeVisible();
  const token = await getAccessToken(request, ENTRY_EMAIL);
  return (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
};

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

/**
 * A net kWh draft made through the record API, not an import: the import route
 * allows five a minute per user, and this file already spends them.
 */
async function createNetDraft(request: APIRequestContext, token: string, periodValue: string) {
  const res = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUB.logistics, locationId: null, reportingYear: E2E_TR_INPUTS_YEAR, reportingPeriod: 'quarterly',
      periodValue, category: 'Natural Gas', activityType: null, activityValue: 1000, activityUnit: 'kWh',
      varianceReason: null, input: null, parameters: { cvBasis: 'net' },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const record = await res.json();
  created.push(record.id as string);
  return record;
}

const listOf = (page: Page) => page.locator('[data-testid="previous-submissions"]');
/** One of the two basis options, by the words the form shows for the record's unit. */
const basis = (page: Page, value: 'net' | 'gross', unit: 'kWh' | 'MWh' = 'kWh') =>
  page.getByTestId('gas-energy-basis').getByRole('radio', {
    name: enDataEntry.inputs.cvBasis[`${value}Option`].replace('{unit}', enUnits.label[unit]),
    exact: true,
  });

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
  // never priced as net when the copy comes back (qa-auditor S1). Back under
  // the TR rules the choice comes with gross selected, never the record's old
  // net (uat4-quick-fixes, BUG-11), and the figure is priced as a gross bill.
  const previews: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/calculations/preview')) previews.push(r.postData() ?? '');
  });
  await value.fill('1109.7');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await expect(page.getByTestId('gas-energy-basis')).toBeVisible();
  await expect(basis(page, 'gross')).toBeChecked();
  await expect(basis(page, 'net')).not.toBeChecked();
  await expect(page.getByTestId('gas-energy-basis-missing')).toHaveCount(0);
  // 1,109.7 kWh gross × 0.9 = 998.73 kWh net.
  await expect(page.getByTestId('gas-energy-derived-net')).toContainText('998.73 kWh');
  await expect(page.getByTestId('preview-tco2e')).toBeVisible();
  // No preview sent under the TR rules ever carried net.
  const underTr = previews.filter((body) => body.includes('"cvBasis"'));
  expect(underTr.length).toBeGreaterThan(0);
  expect(underTr.every((body) => body.includes('"cvBasis":"gross"'))).toBe(true);
  await expect(page.getByRole('button', { name: enDataEntry.saveDraft, exact: true })).toBeEnabled();
});

test('switching an imported net kWh bill to Sm³ clears its figure and basis; back on its own unit its net returns, on MWh the form shows gross (ng-kwh-engine review, BUG-11)', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const res = await postBulkImport(request, token, { buffer: csv('net', 'Q3'), dryRun: 'false' });
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
  // The record stores net, so this is not the form's default showing through.
  await expect(basis(page, 'net')).toBeChecked();
  await expect(basis(page, 'gross')).not.toBeChecked();
  await value.fill('1000');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.2');

  // The same detour onto the other energy unit: the form holds no basis there, so it shows
  // gross, never the record's net carried to a unit it was not stored in.
  await unit.click();
  await page.getByRole('option', { name: enUnits.label.standard_cubic_metres, exact: true }).click();
  await unit.click();
  await page.getByRole('option', { name: 'MWh', exact: true }).click();
  await expect(unit).toHaveText('MWh');
  await expect(basis(page, 'gross', 'MWh')).toBeChecked();
  await expect(basis(page, 'net', 'MWh')).not.toBeChecked();
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

test('a TR gas bill entered on the form in kWh comes with gross selected, shows its net figure, and is saved as gross with no click (BUG-11)', async ({ page, request }) => {
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

  // The choice, in plain words with the unit: the bill's own figure first and selected, net second.
  const choice = page.getByTestId('gas-energy-basis-choice');
  await expect(choice.getByRole('radio')).toHaveCount(2);
  await expect(choice.locator('label')).toHaveText(['kWh on the bill (upper calorific value)', 'Net kWh (lower calorific value)']);
  await expect(basis(page, 'gross')).toBeChecked();
  await expect(basis(page, 'net')).not.toBeChecked();
  await expect(page.getByTestId('gas-energy-basis-missing')).toHaveCount(0);

  // A detour through a volume unit and back lands on gross again, never net.
  await unit.click();
  await page.getByRole('option', { name: enUnits.label.standard_cubic_metres, exact: true }).click();
  await expect(page.getByTestId('gas-energy-basis')).toHaveCount(0);
  await unit.click();
  await page.getByRole('option', { name: enUnits.label.kWh, exact: true }).click();
  await expect(basis(page, 'gross')).toBeChecked();
  await expect(basis(page, 'net')).not.toBeChecked();

  // Every preview the page sends, to prove what the untouched choice prices as.
  const previews: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/calculations/preview')) previews.push(r.postData() ?? '');
  });
  const value = page.getByPlaceholder(enDataEntry.activityValuePlaceholder);
  await value.fill('1000');
  // No volume field; the net figure and the release's ratio are shown before save
  // (fixture 9,000 / 10,000), with nothing clicked.
  await expect(page.getByTestId('gas-inputs')).toHaveCount(0);
  const derived = page.getByTestId('gas-energy-derived-net');
  await expect(derived).toContainText('900 kWh');
  await expect(derived).toContainText('× 0.9 (9,000 / 10,000');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.18');
  expect(previews.length).toBeGreaterThan(0);
  expect(previews.every((body) => body.includes('"cvBasis":"gross"'))).toBe(true);
  await expect(page.getByRole('button', { name: enDataEntry.saveDraft, exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Submit for review', exact: true })).toBeEnabled();

  // Saved as it stands: the preselected basis is the record's, and its audit row holds it.
  const saved = await saveDraft(page, request);
  expect(saved).toMatchObject({ activityUnit: 'kWh', activityValue: 1000, parameters: { cvBasis: 'gross' } });
  expect(saved.calculation.kgCo2e).toBeCloseTo(EXPECTED_KG, 9);
  const audit = await auditRowsFor('create', saved.id as string);
  expect((audit.at(-1)!.diff as { after: { parameters: unknown } }).after.parameters).toEqual({ cvBasis: 'gross' });
});

test('the basis is corrected, not the bill: net is priced as net, gross as gross, the figure kept (ng-kwh-form)', async ({ page, request }) => {
  await newBill(page, 'kWh');
  const value = page.getByPlaceholder(enDataEntry.activityValuePlaceholder);
  await value.fill('1000');
  const derived = page.getByTestId('gas-energy-derived-net');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.18');
  await basis(page, 'net').click();
  await expect(value).toHaveValue('1000');
  await expect(derived).toHaveCount(0);
  // 1,000 kWh net × 0.2 = 200 kg.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.2');
  await basis(page, 'gross').click();
  await expect(value).toHaveValue('1000');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.18');
  const saved = await saveDraft(page, request);
  expect(saved).toMatchObject({ activityUnit: 'kWh', activityValue: 1000, parameters: { cvBasis: 'gross' } });
});

test('a gross MWh bill comes selected in its own unit\'s words, shows its net figure in MWh and is saved in MWh (ng-kwh-form, BUG-11)', async ({ page, request }) => {
  await newBill(page, 'MWh');
  await page.getByPlaceholder(enDataEntry.activityValuePlaceholder).fill('1');
  await expect(page.getByTestId('gas-energy-basis-choice').locator('label')).toHaveText([
    'MWh on the bill (upper calorific value)',
    'Net MWh (lower calorific value)',
  ]);
  // Nothing clicked: gross is the bill's own figure.
  await expect(basis(page, 'gross', 'MWh')).toBeChecked();
  await expect(page.getByTestId('gas-energy-derived-net')).toContainText('0.9 MWh');
  // 1 MWh gross × 0.9 × 0.2 = 180 kg.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.18');
  const saved = await saveDraft(page, request);
  expect(saved).toMatchObject({ activityUnit: 'MWh', activityValue: 1, parameters: { cvBasis: 'gross' } });
  expect(saved.calculation.kgCo2e).toBeCloseTo(EXPECTED_KG, 9);
});

test('a change of scale keeps the basis, and a net kWh bill is saved as entered (ng-kwh-form)', async ({ page, request }) => {
  await newBill(page, 'MWh');
  const value = page.getByPlaceholder(enDataEntry.activityValuePlaceholder);
  await value.fill('1');
  // The author's own choice, which a change of scale must not turn back into the default.
  await basis(page, 'net', 'MWh').click();
  // A change of scale asks for the figure again and keeps the basis.
  const unit = page.getByRole('combobox', { name: enDataEntry.unit, exact: true });
  await unit.click();
  await page.getByRole('option', { name: 'kWh', exact: true }).click();
  await expect(value).toHaveValue('');
  await expect(basis(page, 'net')).toBeChecked();
  await expect(basis(page, 'gross')).not.toBeChecked();

  await value.fill('1000');
  // 1,000 kWh net × 0.2 = 200 kg.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.2');
  const saved = await saveDraft(page, request);
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

test('a stored net bill stays net through an unrelated edit, with no click on the basis (BUG-11)', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const imported = await createNetDraft(request, token, 'Q2');
  const id = imported.id as string;
  expect(imported.parameters).toEqual({ cvBasis: 'net' });
  // 1,000 kWh net × 0.2 = 200 kg.
  expect(imported.calculation.kgCo2e).toBeCloseTo(1000 * E2E_TR_INPUTS.gasFactor, 9);

  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));
  await listOf(page).getByRole('button', { name: `Edit Q2 ${E2E_TR_INPUTS_YEAR} Natural Gas` }).click();
  await expect(page.getByTestId('edit-mode-band')).toBeVisible();
  // The record's own basis, not the form's default.
  await expect(basis(page, 'net')).toBeChecked();
  await expect(basis(page, 'gross')).not.toBeChecked();
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.2');

  const previews: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/calculations/preview')) previews.push(r.postData() ?? '');
  });
  await page.getByRole('button', { name: enDataEntry.context.title }).click();
  await page.getByPlaceholder(enDataEntry.context.other.notes.placeholder).fill('e2e: net bill, note only');
  await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();
  await expect(page.getByText('Changes saved to the record.')).toBeVisible();
  expect(previews.every((body) => !body.includes('"cvBasis":"gross"'))).toBe(true);

  const saved = await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
  expect(saved).toMatchObject({ id, activityUnit: 'kWh', activityValue: 1000, parameters: { cvBasis: 'net' } });
  expect(saved.calculation.kgCo2e).toBeCloseTo(imported.calculation.kgCo2e, 9);
});

test('a net the author chose does not outlive its record: a category round trip and a new record both start on gross (BUG-11)', async ({ page, request }) => {
  await newBill(page, 'kWh');
  const unit = page.getByRole('combobox', { name: enDataEntry.unit, exact: true });
  const pickKwh = async () => {
    await unit.click();
    await page.getByRole('option', { name: enUnits.label.kWh, exact: true }).click();
    await expect(unit).toHaveText('kWh');
  };
  await basis(page, 'net').click();
  await expect(basis(page, 'net')).toBeChecked();

  // Another category and back: the choice starts again.
  await pickByFieldLabel(page, enDataEntry.category, enCategories.Electricity);
  await expect(page.getByTestId('gas-energy-basis')).toHaveCount(0);
  await pickByFieldLabel(page, enDataEntry.category, enCategories['Natural Gas']);
  await pickKwh();
  await expect(basis(page, 'gross')).toBeChecked();
  await expect(basis(page, 'net')).not.toBeChecked();

  // Saved as net by the author's own click, then a new record: gross again.
  await basis(page, 'net').click();
  await page.getByPlaceholder(enDataEntry.activityValuePlaceholder).fill('1000');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.2');
  const saved = await saveDraft(page, request);
  expect(saved).toMatchObject({ parameters: { cvBasis: 'net' } });
  await page.getByRole('button', { name: enDataEntry.startNewRecord, exact: true }).click();
  await pickByFieldLabel(page, enDataEntry.category, enCategories['Natural Gas']);
  await pickKwh();
  await expect(basis(page, 'gross')).toBeChecked();
  await expect(basis(page, 'net')).not.toBeChecked();
});

test('an opened net bill carried to another period keeps its unit, figure and basis, as a copy does (BUG-11)', async ({ page, request }) => {
  await createNetDraft(request, await getAccessToken(request, ENTRY_EMAIL), 'Q1');

  await login(page, ENTRY_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));
  // Opened by its row, not by Edit: changing its period enters a new record.
  await listOf(page).getByRole('button', { name: new RegExp(`^Q1 ${E2E_TR_INPUTS_YEAR} Natural Gas`) }).click();
  const value = page.getByPlaceholder(enDataEntry.activityValuePlaceholder);
  await expect(value).toHaveValue('1000');
  await expect(basis(page, 'net')).toBeChecked();
  await pickByFieldLabel(page, enDataEntry.periodValue, enPeriods.values.Q2);
  await expect(page.getByText(enDataEntry.nowEnteringNew)).toBeVisible();
  // Every field stays as it was, the basis with the figure it describes.
  await expect(page.getByRole('combobox', { name: enDataEntry.unit, exact: true })).toHaveText('kWh');
  await expect(value).toHaveValue('1000');
  await expect(basis(page, 'net')).toBeChecked();
  await expect(basis(page, 'gross')).not.toBeChecked();
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.2');
});
