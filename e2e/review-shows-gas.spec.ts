import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import enCategories from '../apps/web/messages/en/categories.json';
import trCategories from '../apps/web/messages/tr/categories.json';
import enDataEntry from '../apps/web/messages/en/dataEntry.json';
import trDataEntry from '../apps/web/messages/tr/dataEntry.json';
import enPeriods from '../apps/web/messages/en/periods.json';
import trPeriods from '../apps/web/messages/tr/periods.json';
import enReview from '../apps/web/messages/en/review.json';
import trReview from '../apps/web/messages/tr/review.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  CONSULTANT_EMAIL,
  E2E_TR_INPUTS,
  E2E_TR_INPUTS_YEAR,
  E2E_YEAR,
  SUB,
  bearer,
  cleanupTrInputsFixture,
  createCommittedRecord,
  deleteRecordsAsService,
  getAccessToken,
  login,
  seedTrInputsFixture,
} from './helpers';

/**
 * UAT round 2, change 7 (OpenSpec `uat2-review-shows-gas`, design D8 of the
 * multi-gas design): under K5 option A a site holds one Refrigerants record per
 * gas, so the review queue row and the review sheet name the record's activity
 * type beside its category, in every typed category, in English and Turkish.
 *
 * Lanes, both written by the admin (a consultant never enters data) and
 * reviewed by the consultant:
 * - `SUB.logistics`, Refrigerants, annual `E2E_TR_INPUTS_YEAR`, the whole
 *   subsidiary: two records that differ ONLY by gas, priced by the TR inputs
 *   fixture's two gases. R-410A's one line is above the first-period ceiling
 *   (500 kg a line), so its row carries the flag mark beside its gas. `data-entry-tr-inputs.spec.ts` writes a draft there
 *   and deletes it; files run one at a time.
 * - `SUB.mfg`, Fuel diesel, quarterly Q3 of `E2E_YEAR`, priced by the seed's
 *   placeholder (EU diesel).
 * Every record is deleted in `finally`; the consultant's language is restored
 * in `afterAll`.
 */
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => seedTrInputsFixture());
test.afterAll(async () => {
  await setConsultantLanguage('en');
  await cleanupTrInputsFixture();
});

// On its own request context, so a timed-out test still leaves the seed user in English.
async function setConsultantLanguage(language: 'tr' | 'en') {
  const api = await playwrightRequest.newContext();
  try {
    const token = await getAccessToken(api, CONSULTANT_EMAIL);
    const res = await api.patch(`${API_BASE}/me/preferences`, { headers: bearer(token), data: { language } });
    if (res.status() !== 200) throw new Error(`language ${language}: ${res.status()}`);
  } finally {
    await api.dispose();
  }
}

const GASES = [E2E_TR_INPUTS.refrigerant, E2E_TR_INPUTS.secondRefrigerant] as const;

/** First-period ceiling of one refrigerant line (Decisions 2026-11-12): 600 kg is above it. */
const FLAGGED_CAPACITY_KG = 600;
const PLAIN_CAPACITY_KG = 10;

const refrigerant = (activityType: string, capacityKg: number) => ({
  subsidiaryId: SUB.logistics,
  locationId: null,
  category: 'Refrigerants',
  activityType,
  reportingYear: E2E_TR_INPUTS_YEAR,
  reportingPeriod: 'annual',
  periodValue: 'Annual',
  // One line; refill 0, so only the capacity can cross the line's ceiling.
  activityValue: capacityKg,
  activityUnit: 'kg',
  parameters: { equipment: [{ equipmentType: 'split_air_conditioner', capacityKg, refillKg: 0, leakRateChoice: 'default' }] },
  // Submit asks a flagged record for a reason; a plain one takes none.
  varianceReason: capacityKg > 500 ? 'E2E: a large chiller, checked against the service record' : null,
});

const diesel = {
  subsidiaryId: SUB.mfg,
  category: 'Fuel',
  activityType: 'diesel',
  periodValue: 'Q3',
  reportingYear: E2E_YEAR,
  activityValue: 100,
  activityUnit: 'litres',
};

/** A queue row by its subsidiary, its period and the "category (type)" it must read. */
function row(page: Page, subsidiary: string, period: string, year: number, categoryWithType: string) {
  return page
    .locator('table tbody tr')
    .filter({ hasText: subsidiary })
    .filter({ hasText: `${period} ${year}` })
    .filter({ hasText: categoryWithType });
}

// The queue names a subsidiary by its legal name (the seed's).
const LOGISTICS = 'TonyAI Logistics';
const MFG = 'TonyAI Manufacturing';

function title(template: string, category: string, period: string, year: number): string {
  return template.replace('{category}', category).replace('{period}', period).replace('{year}', String(year));
}

test('the review queue and sheet name each record’s gas or fuel, in English and Turkish', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const created: string[] = [];
  try {
    const [flaggedGas, plainGas] = GASES;
    created.push(await createCommittedRecord(request, token, refrigerant(flaggedGas, FLAGGED_CAPACITY_KG)));
    created.push(await createCommittedRecord(request, token, refrigerant(plainGas, PLAIN_CAPACITY_KG)));
    created.push(await createCommittedRecord(request, token, diesel));

    // English: the two gas records read apart, and the fuel names its type too.
    await setConsultantLanguage('en');
    await login(page, CONSULTANT_EMAIL);
    await page.goto('/review');
    const enGas = (gas: string) =>
      row(page, LOGISTICS, enPeriods.values.Annual, E2E_TR_INPUTS_YEAR, `${enCategories.Refrigerants} (${enDataEntry.activityTypes[gas as 'R-410A']})`);
    for (const gas of GASES) await expect(enGas(gas)).toHaveCount(1);
    // A flagged gas record keeps its flag mark beside the gas; its sibling has none.
    await expect(enGas(flaggedGas).getByTestId('anomaly-flag-marker')).toBeVisible();
    await expect(enGas(plainGas).getByTestId('anomaly-flag-marker')).toHaveCount(0);
    await expect(row(page, MFG, enPeriods.values.Q3, E2E_YEAR, `${enCategories.Fuel} (${enDataEntry.activityTypes.diesel})`)).toHaveCount(1);

    // The sheet's title names the gas of the row opened, not its sibling's.
    await enGas(E2E_TR_INPUTS.secondRefrigerant).click();
    const enTitle = title(
      enReview.sheet.title,
      `${enCategories.Refrigerants} (${enDataEntry.activityTypes[E2E_TR_INPUTS.secondRefrigerant]})`,
      enPeriods.values.Annual,
      E2E_TR_INPUTS_YEAR,
    );
    await expect(page.getByRole('dialog').getByText(enTitle, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Turkish: the same rows by their Turkish labels, read from the catalogue.
    await setConsultantLanguage('tr');
    await page.reload();
    const trGas = (gas: string) =>
      row(page, LOGISTICS, trPeriods.values.Annual, E2E_TR_INPUTS_YEAR, `${trCategories.Refrigerants} (${trDataEntry.activityTypes[gas as 'R-410A']})`);
    for (const gas of GASES) await expect(trGas(gas)).toHaveCount(1);
    await expect(trGas(flaggedGas).getByTestId('anomaly-flag-marker')).toBeVisible();

    // The Turkish sheet title names the gas too.
    await trGas(flaggedGas).click();
    const trGasTitle = title(
      trReview.sheet.title,
      `${trCategories.Refrigerants} (${trDataEntry.activityTypes[flaggedGas]})`,
      trPeriods.values.Annual,
      E2E_TR_INPUTS_YEAR,
    );
    await expect(page.getByRole('dialog').getByText(trGasTitle, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const trDiesel = row(page, MFG, trPeriods.values.Q3, E2E_YEAR, `${trCategories.Fuel} (${trDataEntry.activityTypes.diesel})`);
    await expect(trDiesel).toHaveCount(1);

    await trDiesel.click();
    const trTitle = title(
      trReview.sheet.title,
      `${trCategories.Fuel} (${trDataEntry.activityTypes.diesel})`,
      trPeriods.values.Q3,
      E2E_YEAR,
    );
    await expect(page.getByRole('dialog').getByText(trTitle, { exact: true })).toBeVisible();
  } finally {
    await deleteRecordsAsService(request, created);
  }
});
