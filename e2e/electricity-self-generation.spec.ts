import { readFileSync } from 'node:fs';
import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import enCategories from '../apps/web/messages/en/categories.json';
import enDataEntry from '../apps/web/messages/en/dataEntry.json';
import enPeriods from '../apps/web/messages/en/periods.json';
import enReview from '../apps/web/messages/en/review.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  CONSULTANT_EMAIL,
  E2E_PERIOD,
  E2E_YEAR,
  EVIDENCE_FIXTURE,
  SUB,
  approveRecord,
  attachEvidence,
  bearer,
  createCommittedRecord,
  deleteRecordsAsService,
  getAccessToken,
  login,
  pickByFieldLabel,
} from './helpers';

/**
 * UAT round 3, LP4-07 (`self-gen-model`, then `self-gen-form`; Decisions
 * 2026-11-20 D5, D6, D8): an Electricity record may carry a self-generation
 * block, which Data Entry shows and edits and the review sheet shows.
 *
 * The form sends what it shows: every Electricity save, an edit included,
 * sends the section's block, or none when no source is chosen. What keeps a
 * stale form from writing an older block over a newer one is the version each
 * edit names (`seenUpdatedAt`): a block corrected or added by another client
 * after the form opened it is refused as `record_changed`, and the form reads
 * the record again. A move to another category drops the block, and says so
 * first; a category picked by mistake and undone keeps it. The section holds
 * the preview and the save until the block is valid, reminds of the fuel
 * record for a fuel source, and warns on an energy balance gap without
 * blocking. The review sheet shows the block, a missing fuel record and a
 * balance gap, and blocks nothing.
 *
 * The block is geography-free and never priced, so the lane is a UK one, where
 * the seed prices Electricity and Natural Gas in kWh on every CI run.
 *
 * Lane: `SUB.trading` (UK) / quarterly `E2E_YEAR` / Q4 (and Q3 for a second
 * record), drafts, plus one submitted record for the review sheet. The block's
 * records sit at the Manchester Office site, which no other spec writes and
 * the seed holds nothing at, so its fuel record is missing until a test makes
 * one: `review-queue.spec` commits Trading's whole-company Natural Gas Q4 and
 * never deletes it, so moving a whole-company draft to Natural Gas would
 * collide with it whenever that file ran first. The plain grid drafts are
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

/** Another client's edit of the same draft, through the API, on the version it reads. */
async function patchElsewhere(request: APIRequestContext, token: string, id: string, data: Record<string, unknown>) {
  const current = await read(request, token, id);
  const res = await request.patch(`${API_BASE}/activity-records/${id}`, {
    headers: bearer(token),
    data: { ...data, seenUpdatedAt: current.updatedAt },
  });
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
async function save(page: Page, method: 'POST' | 'PATCH', expectOk = true) {
  const answered = page.waitForResponse(
    (r) => r.request().method() === method && /\/activity-records(\/[^/]+)?$/.test(new URL(r.url()).pathname),
  );
  await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();
  const response = await answered;
  if (expectOk) expect(response.ok(), await response.text()).toBe(true);
  return { body: response.request().postDataJSON() as Record<string, unknown>, response };
}

/** A save refused as a lost race: 409 `record_changed`, the version the form read named. */
async function expectStaleSave(page: Page) {
  const { body, response } = await save(page, 'PATCH', false);
  expect(response.status()).toBe(409);
  expect((await response.json()).code).toBe('record_changed');
  expect(body.seenUpdatedAt).toEqual(expect.any(String));
  return body;
}

async function pickUnit(page: Page, unit: string) {
  const unitSelect = page.getByRole('combobox', { name: enDataEntry.unit, exact: true });
  await unitSelect.click();
  await page.getByRole('option', { name: unit, exact: true }).click();
  await expect(unitSelect).toHaveText(unit);
}

const SG = enDataEntry.inputs.selfGeneration;
const sourceSelect = (page: Page) => page.getByTestId('self-generation-source');
const generated = (page: Page) => page.locator('#input-self-generated');
const exported = (page: Page) => page.locator('#input-self-exported');
const facility = (page: Page) => page.locator('#input-self-facility');
const saveDraftButton = (page: Page) => page.getByRole('button', { name: enDataEntry.saveDraft, exact: true });
const removalNotice = (page: Page) => page.getByTestId('self-generation-removal-notice');

async function pickSource(page: Page, source: keyof typeof SG.sources) {
  await sourceSelect(page).click();
  await page.getByRole('option', { name: SG.sources[source], exact: true }).click();
  await expect(sourceSelect(page)).toHaveText(SG.sources[source]);
}

/** Whether the page asks for a preview within `ms`: the debounce is 400 ms. */
const previewWithin = (page: Page, ms = 1500) =>
  page
    .waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/calculations/preview'), { timeout: ms })
    .then(() => true)
    .catch(() => false);

test('a stored block survives a quantity edit and a move to MWh on Data Entry', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token);
  expect((await read(request, token, id)).parameters).toEqual(BLOCK);

  const opened = await read(request, token, id);
  const preview = previewWithBlock(page);
  await openDraft(page);
  // The section shows the stored block.
  await expect(sourceSelect(page)).toHaveText(SG.sources.solar);
  await expect(generated(page)).toHaveValue(/^4,?000$/);
  await expect(exported(page)).toHaveValue('500');
  await expect(facility(page)).toHaveValue(/^9,?000$/);
  // The preview sends the block on the form; it changes no figure.
  expect((await preview).postDataJSON().parameters).toEqual(BLOCK);
  await quantity(page).fill('5200');
  const first = (await save(page, 'PATCH')).body;
  // An edit sends the block the form shows, and names the version it opened.
  expect(first.parameters).toEqual(BLOCK);
  expect(first.seenUpdatedAt).toBe(opened.updatedAt);
  await expect(page.getByText(SAVED, { exact: true }).last()).toBeVisible();
  const afterFirst = await read(request, token, id);
  expect(afterFirst).toMatchObject({ activityValue: 5200, activityUnit: 'kWh', parameters: BLOCK });

  // Saved again without reopening: the form names the version its own save returned (qa-auditor re-review).
  await quantity(page).fill('5250');
  const again = (await save(page, 'PATCH')).body;
  expect(again.seenUpdatedAt).toBe(afterFirst.updatedAt);
  expect(await read(request, token, id)).toMatchObject({ activityValue: 5250, parameters: BLOCK });

  // MWh: the quantity is asked for again; the block's kWh are not rescaled.
  await editButton(page).click();
  await pickUnit(page, 'MWh');
  await expect(quantity(page)).toHaveValue('');
  await quantity(page).fill('5.2');
  const second = (await save(page, 'PATCH')).body;
  expect(second.parameters).toEqual(BLOCK);
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

test('a category picked by mistake and undone keeps the block; a move to Natural Gas says it removes it, and does', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token);

  // Natural Gas, then Electricity again: the notice comes and goes, and the section shows the block as it was.
  await openDraft(page);
  await expect(removalNotice(page)).toHaveCount(0);
  await pickByFieldLabel(page, enDataEntry.category, enCategories['Natural Gas']);
  await expect(removalNotice(page)).toHaveText(SG.removalNotice);
  await expect(page.getByTestId('self-generation')).toHaveCount(0);
  await pickByFieldLabel(page, enDataEntry.category, enCategories.Electricity);
  await expect(removalNotice(page)).toHaveCount(0);
  await expect(sourceSelect(page)).toHaveText(SG.sources.solar);
  await expect(generated(page)).toHaveValue(/^4,?000$/);
  await expect(quantity(page)).toHaveValue('');
  await pickUnit(page, 'kWh');
  await quantity(page).fill('5100');
  const undone = (await save(page, 'PATCH')).body;
  expect(undone).toMatchObject({ category: 'Electricity' });
  expect(undone.parameters).toEqual(BLOCK);
  await expect(page.getByText(SAVED, { exact: true }).last()).toBeVisible();
  expect(await read(request, token, id)).toMatchObject({ category: 'Electricity', activityValue: 5100, parameters: BLOCK });

  await editButton(page).click();
  await pickByFieldLabel(page, enDataEntry.category, enCategories['Natural Gas']);
  await expect(removalNotice(page)).toBeVisible();
  await expect(quantity(page)).toHaveValue('');
  await pickUnit(page, 'kWh');
  await quantity(page).fill('5000');
  const { body } = await save(page, 'PATCH');
  expect(body).toMatchObject({ category: 'Natural Gas' });
  expect(body.parameters ?? null).toBeNull();
  await expect(page.getByText(SAVED, { exact: true }).last()).toBeVisible();
  expect(await read(request, token, id)).toMatchObject({ category: 'Natural Gas', activityUnit: 'kWh', parameters: null });
});

test('a save on a version changed by another client is refused, and the corrected block stays', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token);
  await openDraft(page);

  const corrected = { ...BLOCK, selfGeneratedKwh: 5000 };
  await patchElsewhere(request, token, id, { parameters: corrected });

  await quantity(page).fill('5300');
  const body = await expectStaleSave(page);
  // The form sent the block it showed, the older one: the version refused it.
  expect(body.parameters).toEqual(BLOCK);
  expect(await read(request, token, id)).toMatchObject({ activityValue: 5000, parameters: corrected });
  // Data Entry's own sentence: the record changed after the form opened it.
  await expect(page.getByText(enDataEntry.recordChanged, { exact: true })).toBeVisible();

  // The refusal reads the record again as stored, with its version; the save made on it sends the corrected block.
  await expect(quantity(page)).toHaveValue('5000');
  await expect(generated(page)).toHaveValue(/^5,?000$/);
  await expect(page.getByTestId('edit-mode-band')).toBeVisible();
  await quantity(page).fill('5300');
  const again = (await save(page, 'PATCH')).body;
  expect(again.parameters).toEqual(corrected);
  const saved = await read(request, token, id);
  expect(saved).toMatchObject({ activityValue: 5300, parameters: corrected });
  expect(saved.calculation.parameters).toContainEqual({ name: 'selfGeneratedKwh', value: 5000, origin: 'user' });
});

test('a block added by another client to a draft opened without one is not erased by the save', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token, null);
  await openDraft(page);

  await patchElsewhere(request, token, id, { parameters: BLOCK });

  await quantity(page).fill('5300');
  const body = await expectStaleSave(page);
  expect(body.parameters ?? null).toBeNull();
  expect(await read(request, token, id)).toMatchObject({ activityValue: 5000, parameters: BLOCK });
  // Read again, the form shows the block it did not know of.
  await expect(sourceSelect(page)).toHaveText(SG.sources.solar);
});

test('a Natural Gas draft another client turned into Electricity with a block is not erased by the save', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const res = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUB.trading, locationId: MANCHESTER_OFFICE, reportingYear: E2E_YEAR, reportingPeriod: E2E_PERIOD,
      periodValue: PERIOD, category: 'Natural Gas', activityValue: 5000, activityUnit: 'kWh', varianceReason: null, parameters: null,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id as string;
  created.push(id);

  // The form opens the Natural Gas draft.
  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_YEAR));
  await listOf(page).getByRole('button', { name: new RegExp(`^Edit ${PERIOD} ${E2E_YEAR} Natural Gas`) }).click();
  await expect(page.getByTestId('edit-mode-band')).toBeVisible();

  // Another client makes it Electricity with a block.
  await patchElsewhere(request, token, id, { category: 'Electricity', activityValue: 5000, activityUnit: 'kWh', parameters: BLOCK });

  // The form picks Electricity too and saves: its version is stale, so nothing is written.
  await pickByFieldLabel(page, enDataEntry.category, enCategories.Electricity);
  await pickUnit(page, 'kWh');
  await quantity(page).fill('5300');
  const body = await expectStaleSave(page);
  expect(body.parameters ?? null).toBeNull();
  expect(await read(request, token, id)).toMatchObject({ category: 'Electricity', activityValue: 5000, parameters: BLOCK });
});

test('an edit that names no version cannot change or remove a stored block, as a tab from before the deploy would', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token);
  const patch = (data: Record<string, unknown>) =>
    request.patch(`${API_BASE}/activity-records/${id}`, { headers: bearer(token), data });

  const erased = await patch({ activityValue: 5100, parameters: null });
  expect(erased.status()).toBe(409);
  expect((await erased.json()).code).toBe('record_changed');
  expect(await read(request, token, id)).toMatchObject({ activityValue: 5000, parameters: BLOCK });

  // An edit that leaves the block as it is goes through.
  const kept = await patch({ activityValue: 5100 });
  expect(kept.status(), await kept.text()).toBe(200);
  expect(await read(request, token, id)).toMatchObject({ activityValue: 5100, parameters: BLOCK });
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
  await expect(sourceSelect(page)).toHaveText(SG.sources.solar);
  // A copy creates: there is no stored block for a category move to remove.
  await expect(removalNotice(page)).toHaveCount(0);

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
  // The section opens on no source and asks nothing more.
  await expect(sourceSelect(page)).toHaveText(SG.sources.none);
  await expect(generated(page)).toHaveCount(0);

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

// --- The version through the save's file uploads and a late refusal (review of 078ca233) ---

/** A new whole-company Electricity record on the form, in the lane's period, not saved. */
async function newGridRecord(page: Page, periodValue = PERIOD, value = '5000') {
  await login(page, ADMIN_EMAIL);
  await page.goto('/data-entry');
  await pickByFieldLabel(page, enDataEntry.subsidiary, SUBSIDIARY_OPTION);
  await pickByFieldLabel(page, enDataEntry.category, enCategories.Electricity);
  await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_YEAR));
  await pickByFieldLabel(page, enDataEntry.period, enPeriods.granularity.quarterly);
  await pickByFieldLabel(page, enDataEntry.periodValue, enPeriods.values[periodValue as 'Q4']);
  await pickUnit(page, 'kWh');
  await quantity(page).fill(value);
}

const pdf = (name: string) => ({ name, mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) });
const EVIDENCE_ROUTE = '**/api/v1/activity-records/*/evidence';

test('an edit made elsewhere while the save uploads its files is not overwritten by the next save', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await newGridRecord(page);
  await page.getByTestId('evidence-vault-input').setInputFiles([pdf('sample-invoice.pdf')]);

  // While the file uploads, another client corrects the quantity.
  let editedElsewhere = false;
  const editDuringUpload = async (route: Route) => {
    if (route.request().method() === 'POST' && !editedElsewhere) {
      editedElsewhere = true;
      const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
      await patchElsewhere(request, token, id, { activityValue: 5500 });
    }
    return route.fallback();
  };
  await page.route(EVIDENCE_ROUTE, editDuringUpload);
  const { response } = await save(page, 'POST');
  const id = (await response.json()).id as string;
  created.push(id);
  await expect(page.getByText(enDataEntry.draftSaved, { exact: true })).toBeVisible();
  await page.unroute(EVIDENCE_ROUTE, editDuringUpload);
  expect(editedElsewhere).toBe(true);

  // The form still shows 5,000 and names the version its own save returned: refused, 5,500 stays.
  await expect(quantity(page)).toHaveValue('5000');
  await quantity(page).fill('5100');
  await expectStaleSave(page);
  expect(await read(request, token, id)).toMatchObject({ activityValue: 5500, evidenceCount: 1 });
});

test('a refusal answered after another record was opened leaves that record on the form', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const first = await draftWithBlock(request, token);
  const otherRes = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUB.trading, locationId: null, reportingYear: E2E_YEAR, reportingPeriod: E2E_PERIOD,
      periodValue: 'Q3', category: 'Electricity', activityValue: 7000, activityUnit: 'kWh', varianceReason: null,
    },
  });
  expect(otherRes.status(), await otherRes.text()).toBe(201);
  const other = (await otherRes.json()).id as string;
  created.push(other);

  await openDraft(page);
  await patchElsewhere(request, token, first, { activityValue: 5500 });

  // The first record's save is answered late, after the second record is open.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const lateAnswer = async (route: Route) => {
    if (route.request().method() === 'PATCH') await gate;
    return route.fallback();
  };
  await page.route(`**/api/v1/activity-records/${first}`, lateAnswer);
  await quantity(page).fill('5300');
  const refused = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/activity-records/${first}`));
  await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();

  await listOf(page).getByRole('button', { name: new RegExp(`^Edit Q3 ${E2E_YEAR} Electricity`) }).click();
  await expect(quantity(page)).toHaveValue('7000');
  await quantity(page).fill('7100');
  release();
  expect((await refused).status()).toBe(409);
  await page.unroute(`**/api/v1/activity-records/${first}`, lateAnswer);

  // No reload of the first record: the second keeps what the user typed.
  const reread = page.waitForRequest((r) => r.method() === 'GET' && r.url().endsWith(`/activity-records/${first}`), { timeout: 2000 }).catch(() => null);
  expect(await reread).toBeNull();
  await expect(quantity(page)).toHaveValue('7100');
  expect(await read(request, token, first)).toMatchObject({ activityValue: 5500 });
});

test('after a refusal the form still lists a file that did not upload, and still waits on it before submit', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  await newGridRecord(page);
  await page.getByTestId('evidence-vault-input').setInputFiles([pdf('sample-invoice.pdf'), pdf('second.pdf')]);

  // The first file uploads; the second does not.
  let uploads = 0;
  const secondFails = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    uploads += 1;
    return uploads === 1
      ? route.fallback()
      : route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'storage down' }) });
  };
  await page.route(EVIDENCE_ROUTE, secondFails);
  const { response } = await save(page, 'POST');
  const id = (await response.json()).id as string;
  created.push(id);
  const failed = page.getByTestId('evidence-failed-uploads');
  await expect(failed).toContainText('second.pdf');
  await page.unroute(EVIDENCE_ROUTE, secondFails);

  // Another client edits; the form's next save is refused and reads the record again.
  await patchElsewhere(request, token, id, { activityValue: 5500 });
  await quantity(page).fill('5100');
  await expectStaleSave(page);
  await expect(quantity(page)).toHaveValue('5500');

  // The failed file is still listed, and the submit still waits for a decision on it.
  await expect(failed).toContainText('second.pdf');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByText(enDataEntry.heldEvidence.resolveFailed)).toBeVisible();
  expect(await read(request, token, id)).toMatchObject({ status: 'draft', evidenceCount: 1 });
});

// --- The section on the form (self-gen-form) ---

test('a block entered on the form is held until it is valid, then saved with topology A', async ({ page, request }) => {
  await newGridRecord(page);
  await expect(saveDraftButton(page)).toBeEnabled();

  // A source without its generation: nothing is previewed or saved, and the section says why.
  const previewed = previewWithin(page);
  await pickSource(page, 'solar');
  await expect(page.getByText(SG.caseA, { exact: true })).toBeVisible();
  await expect(page.getByText(SG.importStatement, { exact: true })).toBeVisible();
  await expect(page.getByTestId('self-generation-issue')).toHaveText(SG.issues.generated_missing);
  await expect(saveDraftButton(page)).toBeDisabled();
  expect(await previewed).toBe(false);

  // Exports above the generation are held too; equal exports are not.
  await generated(page).fill('4000');
  await exported(page).fill('5000');
  await expect(page.getByTestId('self-generation-issue')).toHaveText(SG.issues.exported_above_generated);
  await expect(saveDraftButton(page)).toBeDisabled();
  await exported(page).fill('4000');
  await expect(page.getByTestId('self-generation-issue')).toHaveCount(0);
  await expect(saveDraftButton(page)).toBeEnabled();

  const { body, response } = await save(page, 'POST');
  expect(response.status()).toBe(201);
  const id = (await response.json()).id as string;
  created.push(id);
  const sent = { generationTopology: 'A', selfGenerationSource: 'solar', selfGeneratedKwh: 4000, exportedToGridKwh: 4000 };
  expect(body.parameters).toEqual(sent);
  const token = await getAccessToken(request, ADMIN_EMAIL);
  expect(await read(request, token, id)).toMatchObject({ parameters: sent, generationFuelRecord: null });
});

test('an opened block is corrected on the form, then removed, and the figure never moves', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await draftWithBlock(request, token);
  const before = (await read(request, token, id)).calculation.kgCo2e as number;

  await openDraft(page);
  await generated(page).fill('4500');
  const corrected = (await save(page, 'PATCH')).body;
  expect(corrected.parameters).toEqual({ ...BLOCK, selfGeneratedKwh: 4500 });
  await expect(page.getByText(SAVED, { exact: true }).last()).toBeVisible();
  const saved = await read(request, token, id);
  expect(saved.parameters).toEqual({ ...BLOCK, selfGeneratedKwh: 4500 });
  expect(saved.calculation.kgCo2e).toBeCloseTo(before, 9);

  // No source: a plain grid record again.
  await editButton(page).click();
  await pickSource(page, 'none');
  await expect(generated(page)).toHaveCount(0);
  const removed = (await save(page, 'PATCH')).body;
  expect(removed.parameters ?? null).toBeNull();
  await expect(page.getByText(SAVED, { exact: true }).last()).toBeVisible();
  const plain = await read(request, token, id);
  expect(plain.parameters).toBeNull();
  expect(plain.calculation.kgCo2e).toBeCloseTo(before, 9);
  expect(plain.calculation.parameters).toEqual([]);
});

test('a fuel source reminds of the fuel record, and the record saves without one', async ({ page, request }) => {
  await newGridRecord(page);
  await pickSource(page, 'diesel_generator');
  await expect(page.getByTestId('self-generation-reminder')).toHaveText(SG.reminder.diesel_generator);
  await pickSource(page, 'solar');
  await expect(page.getByTestId('self-generation-reminder')).toHaveCount(0);
  await pickSource(page, 'natural_gas_chp');
  await expect(page.getByTestId('self-generation-reminder')).toHaveText(SG.reminder.natural_gas_chp);
  await generated(page).fill('3000');

  const { response } = await save(page, 'POST');
  expect(response.status()).toBe(201);
  const id = (await response.json()).id as string;
  created.push(id);
  const token = await getAccessToken(request, ADMIN_EMAIL);
  // Whole company: no whole-company gas record in the lane's year.
  expect(await read(request, token, id)).toMatchObject({
    parameters: { selfGenerationSource: 'natural_gas_chp', selfGeneratedKwh: 3000 },
  });
});

test('an energy balance gap warns with both figures, and the record still saves', async ({ page }) => {
  await newGridRecord(page);
  await pickSource(page, 'solar');
  await generated(page).fill('4000');
  // 9,000 − 4,000 = 5,000 kWh expected, 5,000 imported: balanced.
  await facility(page).fill('9000');
  await expect(page.getByTestId('self-generation-balance')).toHaveCount(0);
  // 8,000 − 4,000 = 4,000 kWh expected against 5,000: 25% off.
  await facility(page).fill('8000');
  const balance = page.getByTestId('self-generation-balance');
  await expect(balance).toContainText('5,000 kWh');
  await expect(balance).toContainText('4,000 kWh');
  await expect(saveDraftButton(page)).toBeEnabled();

  const { response } = await save(page, 'POST');
  expect(response.status()).toBe(201);
  created.push((await response.json()).id as string);
});

// --- The review sheet (self-gen-form) ---

test('the review sheet shows a CHP block, notes a missing gas record and a balance gap, and still lets the record be approved', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createCommittedRecord(request, token, {
    subsidiaryId: SUB.trading,
    locationId: MANCHESTER_OFFICE,
    category: 'Electricity',
    periodValue: PERIOD,
    activityValue: 5000,
    parameters: { generationTopology: 'A', selfGenerationSource: 'natural_gas_chp', selfGeneratedKwh: 4000, facilityConsumptionKwh: 8000 },
  });
  created.push(id);
  expect((await read(request, token, id)).generationFuelRecord).toBe('missing');

  const RS = enReview.sheet.selfGeneration;
  const fuelNotice = (page: Page) => page.getByRole('dialog').getByTestId('review-self-generation-fuel-missing');
  const openSheet = async () => {
    await page.goto('/review');
    await page.locator('table tbody tr').filter({ hasText: 'Manchester Office' }).filter({ hasText: enCategories.Electricity }).click();
    await expect(page.getByRole('dialog').getByTestId('review-self-generation-source')).toHaveText(RS.sources.natural_gas_chp);
  };

  // A consultant reviews a record the admin entered.
  await login(page, CONSULTANT_EMAIL);
  await openSheet();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('review-self-generation-generated')).toHaveText('4,000 kWh');
  await expect(dialog.getByTestId('review-self-generation-facility')).toHaveText('8,000 kWh');
  await expect(dialog.getByTestId('review-self-generation-exported')).toHaveCount(0);
  await expect(fuelNotice(page)).toHaveText(
    RS.fuelMissing.natural_gas_chp.replace('{year}', String(E2E_YEAR)).replace('{site}', 'Manchester Office'),
  );
  await expect(dialog.getByTestId('review-self-generation-balance')).toContainText('4,000 kWh');

  // A review step answers the record with its fuel state, so the notice stays; nothing is blocked.
  await dialog.getByRole('button', { name: enReview.sheet.startReview, exact: true }).click();
  await expect(fuelNotice(page)).toBeVisible();
  await expect(dialog.getByRole('button', { name: enReview.sheet.approve, exact: true })).toBeEnabled();

  // A gas draft at the same site, in another quarter of the year, is the fuel record.
  const gas = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUB.trading, locationId: MANCHESTER_OFFICE, reportingYear: E2E_YEAR, reportingPeriod: E2E_PERIOD,
      periodValue: 'Q3', category: 'Natural Gas', activityValue: 1000, activityUnit: 'kWh', varianceReason: null, parameters: null,
    },
  });
  expect(gas.status(), await gas.text()).toBe(201);
  created.push((await gas.json()).id as string);
  await page.keyboard.press('Escape');
  await openSheet();
  await expect(fuelNotice(page)).toHaveCount(0);
  await expect(page.getByRole('dialog').getByTestId('review-self-generation-balance')).toBeVisible();
});
