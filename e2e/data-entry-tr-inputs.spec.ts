import { test, expect, request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import en from '../apps/web/messages/en/dataEntry.json';
import tr from '../apps/web/messages/tr/dataEntry.json';
import trCategories from '../apps/web/messages/tr/categories.json';
import enCategories from '../apps/web/messages/en/categories.json';
import enPeriods from '../apps/web/messages/en/periods.json';
import enUnits from '../apps/web/messages/en/units.json';
import enEvidence from '../apps/web/messages/en/evidence.json';
import enErrors from '../apps/web/messages/en/errors.json';
import enReview from '../apps/web/messages/en/review.json';
import {
  API_BASE,
  E2E_TR_INPUTS,
  E2E_TR_INPUTS_YEAR,
  ADMIN_EMAIL,
  ENTRY_EMAIL,
  EVIDENCE_FIXTURE,
  SUB,
  bearer,
  cleanupTrInputsFixture,
  deleteRecordsAsService,
  findRecordId,
  getAccessToken,
  login,
  pickByFieldLabel,
  seedTrInputsFixture,
  submitAsOwnerPastEvidenceGate,
} from './helpers';

/**
 * LP4-02 PR4: the Data Entry forms of the TR rules, one flow each — natural gas
 * with a billed GCV, a refrigerant on its alternative leak rate, a vehicle mode,
 * marine gas oil by mass (UAT2 BUG-R2-11) and gas-network leakage — priced from
 * a fixture release (`seedTrInputsFixture`),
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

test('mobile combustion: TR marine gas oil is entered by mass, with its Scope 1 boundary (UAT2 BUG-R2-11)', async ({ page, request }) => {
  await openForm(page, 'Mobile Combustion');
  await pickByFieldLabel(page, en.period, enPeriods.granularity.quarterly);
  await pickByFieldLabel(page, en.periodValue, enPeriods.values.Q4);
  await pickByFieldLabel(page, en.vehicleMode, en.activityTypes[E2E_TR_INPUTS.marineGasOil]);
  await expect(page.getByText(en.inputs.marineGasOilScope)).toBeVisible();
  // The unit follows the type: kg first, then tonnes; never litres.
  const unit = page.getByRole('combobox', { name: en.unit, exact: true });
  await expect(unit).toHaveText(enUnits.label.kg);
  await unit.click();
  await expect(page.getByRole('option', { name: enUnits.label.litres, exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: enUnits.label.tonnes, exact: true }).click();
  await page.getByPlaceholder(en.activityValuePlaceholder).fill('1.5');
  // 1.5 t = 1,500 kg × 2 = 3,000 kg.
  await expect(page.getByTestId('preview-tco2e')).toHaveText('3');

  await page.getByRole('button', { name: en.saveDraft }).click();
  await expect(page.getByText(en.draftSaved)).toBeVisible();
  await readAndDelete(request, { category: 'Mobile Combustion', reportingPeriod: 'quarterly', periodValue: 'Q4' }, (record) => {
    expect(record.activityUnit).toBe('tonnes');
    expect(record.activityValue).toBe(1.5);
    expect(record.calculation.kgCo2e).toBe(3000);
  });
});

test('mobile combustion: switching MGO to a vehicle mode clears the typed mass, never re-reads it as litres (UAT2 BUG-R2-11)', async ({ page }) => {
  await openForm(page, 'Mobile Combustion');
  await pickByFieldLabel(page, en.vehicleMode, en.activityTypes[E2E_TR_INPUTS.marineGasOil]);
  const unit = page.getByRole('combobox', { name: en.unit, exact: true });
  const quantity = page.getByPlaceholder(en.activityValuePlaceholder);
  await expect(unit).toHaveText(enUnits.label.kg);
  await quantity.fill('1.5');
  await pickByFieldLabel(page, en.vehicleMode, en.activityTypes[E2E_TR_INPUTS.mode]);
  await expect(unit).toHaveText(enUnits.label.litres);
  await expect(quantity).toHaveValue('');
  await expect(page.getByText(en.inputs.marineGasOilScope)).toHaveCount(0);
});

test('mobile combustion: an opened draft keeps its own unit until its type changes, then narrows both ways (UAT2 BUG-R2-11)', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const draft = async (periodValue: string, activityType: string, activityValue: number, activityUnit: string) => {
    const res = await request.post(`${API_BASE}/activity-records`, {
      headers: bearer(token),
      data: {
        subsidiaryId: SUB.logistics, locationId: null, reportingYear: E2E_TR_INPUTS_YEAR, reportingPeriod: 'quarterly',
        periodValue, category: 'Mobile Combustion', activityType, activityValue, activityUnit, varianceReason: null, input: null,
      },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).id as string;
  };
  const ids = [
    await draft('Q1', E2E_TR_INPUTS.mode, 100, 'litres'),
    await draft('Q2', E2E_TR_INPUTS.marineGasOil, 2, 'tonnes'),
  ];
  try {
    await login(page, ENTRY_EMAIL);
    const unit = page.getByRole('combobox', { name: en.unit, exact: true });
    const quantity = page.getByPlaceholder(en.activityValuePlaceholder);
    const open = async (periodValue: string) => {
      await page.goto(`/data-entry?subsidiaryId=${SUB.logistics}&category=Mobile%20Combustion&year=${E2E_TR_INPUTS_YEAR}`);
      await page.getByRole('button', { name: new RegExp(`${periodValue} ${E2E_TR_INPUTS_YEAR}`) }).click();
      await expect(page.getByText(/Editing draft/)).toBeVisible();
    };

    // A vehicle-mode draft opens on its own litres; MGO then takes kg and drops the litres.
    await open('Q1');
    await expect(unit).toHaveText(enUnits.label.litres);
    await pickByFieldLabel(page, en.vehicleMode, en.activityTypes[E2E_TR_INPUTS.marineGasOil]);
    await expect(unit).toHaveText(enUnits.label.kg);
    await expect(quantity).toHaveValue('');

    // An MGO draft opens on its own tonnes; a vehicle mode then takes litres and drops the mass.
    await open('Q2');
    await expect(unit).toHaveText(enUnits.label.tonnes);
    await pickByFieldLabel(page, en.vehicleMode, en.activityTypes[E2E_TR_INPUTS.mode]);
    await expect(unit).toHaveText(enUnits.label.litres);
    await expect(quantity).toHaveValue('');
  } finally {
    for (const id of ids) {
      const removed = await request.delete(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
      expect(removed.ok()).toBe(true);
    }
  }
});

/** The entry user's UI language, on its own request context (as data-entry-turkish.spec.ts does). */
async function setLanguage(language: 'tr' | 'en'): Promise<void> {
  const api = await playwrightRequest.newContext();
  try {
    const token = await getAccessToken(api, ENTRY_EMAIL);
    const res = await api.patch(`${API_BASE}/me/preferences`, { headers: bearer(token), data: { language } });
    if (res.status() !== 200) throw new Error(`language ${language}: ${res.status()}`);
  } finally {
    await api.dispose();
  }
}

test('mobile combustion: a Turkish profile reads marine gas oil and its boundary in Turkish (UAT2 BUG-R2-11)', async ({ page }) => {
  await setLanguage('tr');
  try {
    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await pickByFieldLabel(page, tr.subsidiary, SUBSIDIARY);
    await pickByFieldLabel(page, tr.category, trCategories['Mobile Combustion']);
    await pickByFieldLabel(page, tr.vehicleMode, tr.activityTypes.marine_gas_oil);
    await expect(page.getByText(tr.inputs.marineGasOilScope)).toBeVisible();
  } finally {
    await setLanguage('en');
  }
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

test('evidence: a new mobile record submitted without a file stays open on its draft until one is attached (K3, BUG-R2-02)', async ({ page, request }) => {
  await openForm(page, 'Mobile Combustion');
  await pickByFieldLabel(page, en.period, enPeriods.granularity.quarterly);
  await pickByFieldLabel(page, en.periodValue, enPeriods.values.Q1);
  await pickByFieldLabel(page, en.vehicleMode, en.activityTypes[E2E_TR_INPUTS.mode]);
  await page.getByPlaceholder(en.activityValuePlaceholder).fill('100');
  await expect(page.getByTestId('preview-tco2e')).toHaveText('0.3');

  // Straight to Submit, never saved: what QA did. The form saves the draft,
  // keeps it open with the vault on screen, and sends no submit.
  // The click saves the record: its id comes from the create's own answer, so
  // the `finally` reclaims it even when an assertion below fails (a leaked 2023
  // draft would collide on the next local run — the teardown sweeps only E2E_YEAR).
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/activity-records'),
  );
  // Every submit the page sends: the pre-check must send none, so removing it
  // fails here rather than passing on the API's own refusal.
  const submits: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/activity-records\/[^/]+\/submit$/.test(new URL(r.url()).pathname)) submits.push(r.url());
  });
  await page.getByRole('button', { name: en.submit }).click();
  const saved = await created;
  expect(saved.status()).toBe(201);
  const id = (await saved.json()).id as string;
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const vault = page.locator('[data-testid="evidence-vault-input"]');
  try {
    await expect(page.getByText(en.evidenceBeforeSubmit)).toBeVisible();
    expect(submits).toHaveLength(0);
    // The draft just saved is listed without a reload.
    await expect(page.getByRole('button', { name: new RegExp(`Q1 ${E2E_TR_INPUTS_YEAR}`) })).toBeVisible();
    await expect(page.getByText(enEvidence.requiredNote)).toBeVisible();
    await expect(vault).toBeAttached();
    const draft = await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
    expect((await draft.json()).status).toBe('draft');

    await vault.setInputFiles(EVIDENCE_FIXTURE);
    await expect(page.getByText(enEvidence.uploaded)).toBeVisible();
    await page.getByRole('button', { name: en.submit }).click();
    await expect(page.getByText(en.submitted)).toBeVisible();
    expect(submits).toHaveLength(1);

    const after = await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
    expect((await after.json()).status).toBe('submitted');
  } finally {
    // Submitted: the API refuses to delete it, so the service role does.
    await deleteRecordsAsService(request, [id]);
  }
});

test('evidence: a record submitted before K3 without a file is refused at approve, and the reviewer is told to return it (K3)', async ({ page, request }) => {
  const token = await getAccessToken(request, ENTRY_EMAIL);
  const created = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUB.logistics, locationId: null, reportingYear: E2E_TR_INPUTS_YEAR, reportingPeriod: 'quarterly',
      periodValue: 'Q2', category: 'Mobile Combustion', activityType: E2E_TR_INPUTS.mode, activityValue: 100,
      activityUnit: 'litres', varianceReason: null, input: null,
    },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id as string;
  try {
    await submitAsOwnerPastEvidenceGate(id);

    await login(page, ADMIN_EMAIL);
    await page.goto('/review');
    await page
      .locator('table tbody tr', { hasText: 'TonyAI Logistics' })
      .filter({ hasText: `Q2 ${E2E_TR_INPUTS_YEAR}` })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: enReview.sheet.approve, exact: true }).click();
    await expect(
      page.getByText(enErrors.codes.approval_evidence_missing.replace('{category}', enCategories['Mobile Combustion'])),
    ).toBeVisible();

    const after = await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) });
    expect((await after.json()).status).toBe('submitted');
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});
