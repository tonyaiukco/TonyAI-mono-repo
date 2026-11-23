import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import enCategories from '../apps/web/messages/en/categories.json';
import enDataEntry from '../apps/web/messages/en/dataEntry.json';
import enPeriods from '../apps/web/messages/en/periods.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  E2E_PERIOD,
  E2E_YEAR,
  SUB,
  approveRecord,
  attachEvidence,
  bearer,
  deleteRecordsAsService,
  getAccessToken,
  login,
  pickByFieldLabel,
} from './helpers';

/**
 * UAT round 3, LP4-07 (`self-gen-model`; Decisions 2026-11-20 D5, D6, D8): an
 * Electricity record may carry a self-generation block, which the form does
 * not show yet (`self-gen-form`). Data Entry must carry a stored block through
 * every save while the record stays Electricity, or the first web edit would
 * erase it with no error. An edit saved as Electricity sends no parameters,
 * so the server keeps the block it holds at the save, including one corrected
 * or added by another client after the form opened (review of `2c427ed8`); a
 * preview and a copy of a voided record send the record's own block; a move
 * to another category drops it; a new grid record still sends no parameters.
 *
 * The block is geography-free and never priced, so the lane is a UK one, where
 * the seed prices Electricity and Natural Gas in kWh on every CI run.
 *
 * Lane: `SUB.trading` (UK) / quarterly `E2E_YEAR` / Q4, drafts only. The
 * block's drafts sit at the Manchester Office site, which no other spec
 * writes: `review-queue.spec` commits Trading's whole-company Natural Gas Q4
 * and never deletes it, so moving a whole-company draft to Natural Gas would
 * collide with it whenever that file ran first. The plain grid draft is
 * whole-company Electricity Q4, which no other spec writes. `gates.spec` locks
 * only Trading's Q1. Every record is deleted after its test.
 */
test.describe.configure({ mode: 'serial' });

const SUBSIDIARY_OPTION = 'TonyAI Trading (UK)';
/** TonyAI Trading's seeded Manchester Office (packages/db/prisma/seed.ts). */
const MANCHESTER_OFFICE = '33333333-3333-3333-3333-333333330008';
const PERIOD = 'Q4';
const SAVED = enDataEntry.editMode.saved;
const BLOCK = {
  generationTopology: 'A',
  selfGenerationSource: 'solar',
  selfGeneratedKwh: 4000,
  exportedToGridKwh: 500,
  facilityConsumptionKwh: 9000,
} as const;

const created: string[] = [];
test.afterEach(async ({ request }) => {
  if (created.length > 0) await deleteRecordsAsService(request, created.splice(0));
});

const listOf = (page: Page) => page.locator('[data-testid="previous-submissions"]');
const editButton = (page: Page) => listOf(page).getByRole('button', { name: new RegExp(`^Edit ${PERIOD} ${E2E_YEAR} Electricity`) });
const quantity = (page: Page) => page.getByPlaceholder('e.g. 45000');

async function draftWithBlock(request: APIRequestContext, token: string, parameters: unknown = BLOCK): Promise<string> {
  const res = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUB.trading,
      locationId: MANCHESTER_OFFICE,
      reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD,
      periodValue: PERIOD,
      category: 'Electricity',
      activityValue: 5000,
      activityUnit: 'kWh',
      varianceReason: null,
      parameters,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id as string;
  created.push(id);
  return id;
}

/** The next preview the page asks for whose body carries a self-generation block. */
const previewWithBlock = (page: Page) =>
  page.waitForRequest((r) => {
    if (r.method() !== 'POST' || !new URL(r.url()).pathname.endsWith('/calculations/preview')) return false;
    const body = r.postDataJSON() as { parameters?: { selfGeneratedKwh?: unknown } | null };
    return body.parameters?.selfGeneratedKwh !== undefined;
  });

/** Another client's edit of the same draft, through the API. */
async function patchElsewhere(request: APIRequestContext, token: string, id: string, data: Record<string, unknown>) {
  const res = await request.patch(`${API_BASE}/activity-records/${id}`, { headers: bearer(token), data });
  expect(res.ok(), await res.text()).toBe(true);
}

async function read(request: APIRequestContext, token: string, id: string) {
  return (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();
}

/** Opens the lane's Electricity draft in Edit mode. */
async function openDraft(page: Page) {
  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_YEAR));
  await editButton(page).click();
  await expect(page.getByTestId('edit-mode-band')).toBeVisible();
}

/**
 * Clicks Save and returns the body the form sent, once the API has answered
 * it: a toast from an earlier save may still be on screen.
 */
async function save(page: Page, method: 'POST' | 'PATCH') {
  const answered = page.waitForResponse(
    (r) => r.request().method() === method && /\/activity-records(\/[^/]+)?$/.test(new URL(r.url()).pathname),
  );
  await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();
  const response = await answered;
  expect(response.ok(), await response.text()).toBe(true);
  return { body: response.request().postDataJSON() as Record<string, unknown>, response };
}

async function pickUnit(page: Page, unit: string) {
  const unitSelect = page.getByRole('combobox', { name: enDataEntry.unit, exact: true });
  await unitSelect.click();
  await page.getByRole('option', { name: unit, exact: true }).click();
  await expect(unitSelect).toHaveText(unit);
}

test('a stored block survives a quantity edit and a move to MWh on Data Entry', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token);
  expect((await read(request, token, id)).parameters).toEqual(BLOCK);

  const preview = previewWithBlock(page);
  await openDraft(page);
  // The preview sends the opened record's block; it changes no figure.
  expect((await preview).postDataJSON().parameters).toEqual(BLOCK);
  await quantity(page).fill('5200');
  const first = (await save(page, 'PATCH')).body;
  // An edit saved as Electricity leaves the block to the server.
  expect(first).not.toHaveProperty('parameters');
  await expect(page.getByText(SAVED, { exact: true }).last()).toBeVisible();
  expect(await read(request, token, id)).toMatchObject({ activityValue: 5200, activityUnit: 'kWh', parameters: BLOCK });

  // MWh: the quantity is asked for again; the block's kWh are not rescaled.
  await editButton(page).click();
  await pickUnit(page, 'MWh');
  await expect(quantity(page)).toHaveValue('');
  await quantity(page).fill('5.2');
  const second = (await save(page, 'PATCH')).body;
  expect(second).not.toHaveProperty('parameters');
  // The first save's toast may still be on screen beside this one.
  await expect(page.getByText(SAVED, { exact: true }).last()).toBeVisible();
  const saved = await read(request, token, id);
  expect(saved).toMatchObject({ activityValue: 5.2, activityUnit: 'MWh', parameters: BLOCK });
  // Never priced: 5.2 MWh is 5,200 kWh, whatever the block holds.
  const plainFigure = 5200 * saved.calculation.factorValue;
  expect(saved.calculation.kgCo2e).toBeCloseTo(plainFigure, 6);
  expect(saved.calculation.parameters).toEqual([
    { name: 'selfGeneratedKwh', value: 4000, origin: 'user' },
    { name: 'exportedToGridKwh', value: 500, origin: 'user' },
    { name: 'facilityConsumptionKwh', value: 9000, origin: 'user' },
  ]);
});

test('a category picked by mistake and undone keeps the block; a move to Natural Gas sends none', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token);

  // Natural Gas, then Electricity again: the record's own block comes back (qa-auditor review).
  await openDraft(page);
  await pickByFieldLabel(page, enDataEntry.category, enCategories['Natural Gas']);
  await pickByFieldLabel(page, enDataEntry.category, enCategories.Electricity);
  await expect(quantity(page)).toHaveValue('');
  await pickUnit(page, 'kWh');
  await quantity(page).fill('5100');
  const undone = (await save(page, 'PATCH')).body;
  expect(undone).toMatchObject({ category: 'Electricity' });
  expect(undone).not.toHaveProperty('parameters');
  await expect(page.getByText(SAVED, { exact: true }).last()).toBeVisible();
  expect(await read(request, token, id)).toMatchObject({ category: 'Electricity', activityValue: 5100, parameters: BLOCK });

  await editButton(page).click();
  await pickByFieldLabel(page, enDataEntry.category, enCategories['Natural Gas']);
  await expect(quantity(page)).toHaveValue('');
  await pickUnit(page, 'kWh');
  await quantity(page).fill('5000');
  const { body } = await save(page, 'PATCH');
  expect(body).toMatchObject({ category: 'Natural Gas' });
  expect(body.parameters ?? null).toBeNull();
  await expect(page.getByText(SAVED, { exact: true }).last()).toBeVisible();
  expect(await read(request, token, id)).toMatchObject({ category: 'Natural Gas', activityUnit: 'kWh', parameters: null });
});

test('a block corrected by another client while the form is open is kept by the save', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token);
  await openDraft(page);

  const corrected = { ...BLOCK, selfGeneratedKwh: 5000 };
  await patchElsewhere(request, token, id, { parameters: corrected });

  await quantity(page).fill('5300');
  const { body } = await save(page, 'PATCH');
  expect(body).not.toHaveProperty('parameters');
  const saved = await read(request, token, id);
  expect(saved).toMatchObject({ activityValue: 5300, parameters: corrected });
  expect(saved.calculation.parameters).toContainEqual({ name: 'selfGeneratedKwh', value: 5000, origin: 'user' });
});

test('a block added by another client to a draft opened without one is kept by the save', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token, null);
  await openDraft(page);

  await patchElsewhere(request, token, id, { parameters: BLOCK });

  await quantity(page).fill('5300');
  const { body } = await save(page, 'PATCH');
  expect(body).not.toHaveProperty('parameters');
  expect(await read(request, token, id)).toMatchObject({ activityValue: 5300, parameters: BLOCK });
});

test('a voided record copied to a new draft keeps its block', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token);
  // Electricity needs its evidence at submit and approval (K3); a second
  // super_admin approves, since nobody approves their own record (D01).
  await attachEvidence(request, token, id);
  const submitted = await request.post(`${API_BASE}/activity-records/${id}/submit`, { headers: bearer(token) });
  expect(submitted.ok(), await submitted.text()).toBe(true);
  await approveRecord(request, await getAccessToken(request, APPROVER_EMAIL), id);
  const voided = await request.post(`${API_BASE}/activity-records/${id}/void`, {
    headers: bearer(token),
    data: { voidReason: 'e2e: copied to a new draft' },
  });
  expect(voided.ok(), await voided.text()).toBe(true);

  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_YEAR));
  const preview = previewWithBlock(page);
  await listOf(page).getByRole('button', { name: new RegExp(`^Copy ${PERIOD} ${E2E_YEAR} Electricity`) }).click();
  await expect(page.getByText(enDataEntry.copy.loaded)).toBeVisible();
  expect((await preview).postDataJSON().parameters).toEqual(BLOCK);

  const { body, response } = await save(page, 'POST');
  expect(response.status()).toBe(201);
  const copyId = (await response.json()).id as string;
  created.push(copyId);
  expect(body.parameters).toEqual(BLOCK);
  expect(await read(request, token, copyId)).toMatchObject({ status: 'draft', category: 'Electricity', parameters: BLOCK });
});

test('a plain grid record is saved with no parameters, as before', async ({ page, request }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.category, enCategories.Electricity);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_YEAR));
  await pickByFieldLabel(page, enDataEntry.period, enPeriods.granularity.quarterly);
  await pickByFieldLabel(page, enDataEntry.periodValue, enPeriods.values[PERIOD]);
  await pickUnit(page, 'kWh');
  await quantity(page).fill('5000');

  const { body, response } = await save(page, 'POST');
  expect(response.status()).toBe(201);
  const id = (await response.json()).id as string;
  created.push(id);
  expect(body.parameters ?? null).toBeNull();
  await expect(page.getByText(enDataEntry.draftSaved)).toBeVisible();

  const token = await getAccessToken(request, ADMIN_EMAIL);
  const saved = await read(request, token, id);
  expect(saved).toMatchObject({ category: 'Electricity', parameters: null });
  expect(saved.calculation.parameters).toEqual([]);
});
