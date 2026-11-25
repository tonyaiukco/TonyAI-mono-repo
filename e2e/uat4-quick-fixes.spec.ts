import { test, expect, type APIRequestContext } from '@playwright/test';
import enDataEntry from '../apps/web/messages/en/dataEntry.json';
import enReview from '../apps/web/messages/en/review.json';
import {
  API_BASE,
  APPROVER_EMAIL,
  E2E_TR_INPUTS,
  E2E_TR_INPUTS_YEAR,
  ENTRY_EMAIL,
  SUB,
  attachEvidence,
  auditRowsFor,
  bearer,
  cleanupTrInputsFixture,
  deleteRecordsAsService,
  getAccessToken,
  login,
  pickByFieldLabel,
  seedTrInputsFixture,
  switchUser,
} from './helpers';

/**
 * UAT round 4, the quick fixes (`uat4-quick-fixes`): the default icon
 * (BUG-10), a record's invoice number and supplier (BUG-16), and the way to
 * the records table from the top of Data Entry (BUG-15, screen part). The gas
 * basis default (BUG-11) is in `natural-gas-energy-bill.spec.ts`.
 *
 * Lane of the one test that writes: `SUB.logistics` (TR), Mobile Combustion,
 * quarterly Q1 of `E2E_TR_INPUTS_YEAR`, priced by the TR inputs fixture.
 * `data-entry-tr-inputs.spec.ts` uses Q2 to Q4 of the same category there.
 * The record is deleted in `finally`.
 */
test.describe.configure({ mode: 'serial' });

const LOGISTICS_OPTION = 'TonyAI Logistics (TR)';
const LOGISTICS = 'TonyAI Logistics';
const INVOICE_NO = 'OZK2025000011923';
const SUPPLIER = 'Petrol Ofisi';

test('the default icon path answers with the mark for a client with no session (BUG-10)', async ({ request }) => {
  const res = await request.get('/favicon.ico', { maxRedirects: 0 });
  // Not a redirect to the sign-in page, and not the 404 the tab used to get.
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/^image\/(x-icon|vnd\.microsoft\.icon)/);
  const body = await res.body();
  // An ICO container: reserved 0, type 1 (icon), at least one image.
  expect([...body.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
  expect(body.readUInt16LE(4)).toBeGreaterThan(0);
});

test.describe('a record\'s invoice number and supplier (BUG-16)', () => {
  test.beforeAll(async () => seedTrInputsFixture());
  test.afterAll(async () => cleanupTrInputsFixture());

  const draftBody = (input: unknown) => ({
    subsidiaryId: SUB.logistics, locationId: null, reportingYear: E2E_TR_INPUTS_YEAR, reportingPeriod: 'quarterly',
    periodValue: 'Q1', category: 'Mobile Combustion', activityType: E2E_TR_INPUTS.mode, activityValue: 100,
    activityUnit: 'litres', varianceReason: null, input,
  });

  const read = async (request: APIRequestContext, token: string, id: string) =>
    (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(token) })).json();

  test('the API refuses a value that is not text or is too long, and stores nothing', async ({ request }) => {
    const token = await getAccessToken(request, ENTRY_EMAIL);
    for (const input of [
      { invoice_no: 'x'.repeat(65) },
      { supplier: 'y'.repeat(201) },
      { invoice_no: 2025000011923 },
      { supplier: { name: SUPPLIER } },
    ]) {
      const res = await request.post(`${API_BASE}/activity-records`, { headers: bearer(token), data: draftBody(input) });
      expect(res.status(), JSON.stringify(input).slice(0, 60)).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('validation_failed');
      // The refusal names the key; it never quotes the value back.
      expect(JSON.stringify(body)).toMatch(/input\.(invoice_no|supplier)/);
      expect(JSON.stringify(body)).not.toContain('xxxxxxxx');
    }
    const found = await request.get(
      `${API_BASE}/activity-records/metadata?subsidiaryId=${SUB.logistics}&year=${E2E_TR_INPUTS_YEAR}&category=${encodeURIComponent('Mobile Combustion')}`,
      { headers: bearer(token) },
    );
    expect((await found.json()).total).toBe(0);
  });

  test('an Electricity record\'s supplier is its utility provider, held to the same bound', async ({ request }) => {
    const token = await getAccessToken(request, ENTRY_EMAIL);
    const electricity = (input: unknown) => ({ ...draftBody(input), category: 'Electricity', activityType: null, activityUnit: 'kWh' });
    for (const input of [{ utility_provider: 'y'.repeat(201) }, { utility_provider: { name: 'Enerjisa' } }]) {
      const res = await request.post(`${API_BASE}/activity-records`, { headers: bearer(token), data: electricity(input) });
      expect(res.status(), JSON.stringify(input).slice(0, 60)).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('validation_failed');
      expect(JSON.stringify(body)).toContain('input.utility_provider');
      expect(JSON.stringify(body)).not.toContain('yyyyyyyy');
    }
    const found = await request.get(
      `${API_BASE}/activity-records/metadata?subsidiaryId=${SUB.logistics}&year=${E2E_TR_INPUTS_YEAR}&category=Electricity`,
      { headers: bearer(token) },
    );
    expect((await found.json()).total).toBe(0);
  });

  test('entered on a draft, they are saved, shown again on reopening, audited, and shown to the reviewer, with the figure unchanged', async ({ page, request }) => {
    const token = await getAccessToken(request, ENTRY_EMAIL);
    const created = await request.post(`${API_BASE}/activity-records`, { headers: bearer(token), data: draftBody(null) });
    expect(created.status(), await created.text()).toBe(201);
    const before = await created.json();
    const id = before.id as string;
    try {
      expect(before.input).toBeNull();
      // 100 L on the fixture's 3 kg/L.
      expect(before.calculation.kgCo2e).toBeCloseTo(100 * E2E_TR_INPUTS.modeFactor, 9);
      // Mobile Combustion needs its evidence at submit (K3).
      await attachEvidence(request, token, id);

      await login(page, ENTRY_EMAIL);
      await page.goto('/data-entry');
      await pickByFieldLabel(page, enDataEntry.subsidiary, LOGISTICS_OPTION);
      await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));
      const list = page.getByTestId('previous-submissions');
      const edit = list.getByRole('button', { name: new RegExp(`^Edit Q1 ${E2E_TR_INPUTS_YEAR} Mobile Combustion`) });
      await edit.click();
      await expect(page.getByTestId('edit-mode-band')).toBeVisible();

      // Both fields are in Additional context, optional, bounded where the API bounds them.
      await page.getByRole('button', { name: enDataEntry.context.title }).click();
      // Found by their visible names: each label is tied to its box, so a
      // screen reader reads the box by it and a click on it focuses the box.
      const invoice = page.getByLabel(enDataEntry.context.shared.invoice_no.label, { exact: true });
      const supplier = page.getByLabel(enDataEntry.context.shared.supplier.label, { exact: true });
      await expect(invoice).toBeVisible();
      await expect(supplier).toBeVisible();
      await page.getByText(enDataEntry.context.shared.supplier.label, { exact: true }).click();
      await expect(supplier).toBeFocused();
      await expect(invoice).toHaveAttribute('maxlength', '64');
      await expect(supplier).toHaveAttribute('maxlength', '200');
      await invoice.fill(`  ${INVOICE_NO} `);
      await supplier.fill(SUPPLIER);
      await page.getByRole('button', { name: enDataEntry.saveDraft, exact: true }).click();
      await expect(page.getByText('Changes saved to the record.')).toBeVisible();

      // Stored trimmed, and never part of the calculation.
      const saved = await read(request, token, id);
      expect(saved.input).toEqual({ invoice_no: INVOICE_NO, supplier: SUPPLIER });
      expect(saved.calculation.kgCo2e).toBeCloseTo(before.calculation.kgCo2e, 9);
      expect(saved.calculation.tCo2e).toBeCloseTo(before.calculation.tCo2e, 12);

      // Audited like any other field: the edit's row holds the old and the new value.
      const edits = await auditRowsFor('update', id);
      const row = edits.at(-1)!.diff as { before: { input: unknown }; after: { input: unknown } };
      expect(row.before.input).toBeNull();
      expect(row.after.input).toEqual({ invoice_no: INVOICE_NO, supplier: SUPPLIER });

      // Reopened: the section is open, so the values the record carries are not hidden.
      await page.reload();
      await pickByFieldLabel(page, enDataEntry.subsidiary, LOGISTICS_OPTION);
      await pickByFieldLabel(page, enDataEntry.reportingYear, String(E2E_TR_INPUTS_YEAR));
      await edit.click();
      await expect(page.getByTestId('edit-mode-band')).toBeVisible();
      await expect(invoice).toBeVisible();
      await expect(invoice).toHaveValue(INVOICE_NO);
      await expect(supplier).toHaveValue(SUPPLIER);

      await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
      await expect(page.getByText('Submitted for review', { exact: true })).toBeVisible();
      const submitted = await read(request, token, id);
      expect(submitted.status).toBe('submitted');
      expect(submitted.input).toEqual({ invoice_no: INVOICE_NO, supplier: SUPPLIER });
      expect(submitted.calculation.kgCo2e).toBeCloseTo(before.calculation.kgCo2e, 9);

      // The reviewer sees both beside the quantity, to match against the evidence
      // file: the standard user's record, so Logistics' super_admin.
      await switchUser(page, APPROVER_EMAIL);
      await page.goto('/review');
      await page
        .locator('table tbody tr')
        .filter({ hasText: LOGISTICS })
        .filter({ hasText: `Q1 ${E2E_TR_INPUTS_YEAR}` })
        .filter({ hasText: 'Mobile Combustion' })
        .click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByText(enReview.sheet.invoiceNo, { exact: true })).toBeVisible();
      await expect(sheet.getByTestId('review-invoice-no')).toHaveText(INVOICE_NO);
      await expect(sheet.getByText(enReview.sheet.supplier, { exact: true })).toBeVisible();
      await expect(sheet.getByTestId('review-supplier')).toHaveText(SUPPLIER);
    } finally {
      // Submitted: the API refuses to delete it, so the service role does.
      await deleteRecordsAsService(request, [id]);
    }
  });
});

test.describe('the way to the entered records from the top of Data Entry (BUG-15, screen part)', () => {
  const total = async (request: APIRequestContext, subsidiaryId: string) => {
    const token = await getAccessToken(request, ENTRY_EMAIL);
    const res = await request.get(`${API_BASE}/activity-records/metadata?subsidiaryId=${subsidiaryId}`, { headers: bearer(token) });
    expect(res.ok(), await res.text()).toBe(true);
    return (await res.json()).total as number;
  };
  const label = (count: number) => enDataEntry.records.jump.count.replace('{count}', String(count));

  test('the control shows the subsidiary\'s record count, follows the subsidiary, and lands on the table with the form untouched', async ({ page, request }) => {
    const energy = await total(request, SUB.energy);
    const logistics = await total(request, SUB.logistics);
    // The seed gives both of the entry user's subsidiaries records, in different numbers.
    expect(energy).toBeGreaterThan(0);
    expect(logistics).toBeGreaterThan(0);

    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await pickByFieldLabel(page, enDataEntry.subsidiary, 'TonyAI Energy (TR)');
    const jump = page.getByTestId('entries-jump');
    // Every record of the subsidiary, whatever year the table's filter shows.
    await expect(jump).toHaveText(label(energy));
    await pickByFieldLabel(page, enDataEntry.subsidiary, LOGISTICS_OPTION);
    await expect(jump).toHaveText(label(logistics));

    const value = page.getByPlaceholder(enDataEntry.activityValuePlaceholder);
    await value.fill('123');
    const heading = page.getByRole('heading', { name: enDataEntry.records.title, exact: true });
    await expect(heading).not.toBeInViewport();
    await jump.click();
    await expect(heading).toBeInViewport();
    await expect(heading).toBeFocused();
    // A jump, not a navigation: what was typed is still there.
    await expect(value).toHaveValue('123');
    await expect(page).toHaveURL(/\/data-entry$/);
  });

  test('the count is read apart from the table: the rows show while the subsidiary\'s whole count is still on its way', async ({ page, request }) => {
    const energy = await total(request, SUB.energy);
    // The count over every year is held back; the table's own filtered requests carry a year.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held = 0;
    await page.route(
      (url) => url.pathname.endsWith('/activity-records/metadata') && !url.searchParams.has('year'),
      async (route) => {
        held += 1;
        await gate;
        await route.continue();
      },
    );
    try {
      await login(page, ENTRY_EMAIL);
      await page.goto('/data-entry');
      await pickByFieldLabel(page, enDataEntry.subsidiary, 'TonyAI Energy (TR)');
      const jump = page.getByTestId('entries-jump');
      // The table is usable although the count has not answered.
      await expect(page.getByTestId('records-table-row').first()).toBeVisible();
      expect(held).toBeGreaterThan(0);
      await expect(jump).toHaveText(enDataEntry.records.jump.unknown);
      // Without a count the control still leads to the table.
      await jump.click();
      await expect(page.getByRole('heading', { name: enDataEntry.records.title, exact: true })).toBeFocused();
    } finally {
      release();
    }
    await expect(page.getByTestId('entries-jump')).toHaveText(label(energy));
  });

  test('with reduced motion the page jumps there at once', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page, ENTRY_EMAIL);
    await page.goto('/data-entry');
    await pickByFieldLabel(page, enDataEntry.subsidiary, 'TonyAI Energy (TR)');
    const heading = page.getByRole('heading', { name: enDataEntry.records.title, exact: true });
    await expect(heading).not.toBeInViewport();
    await page.getByTestId('entries-jump').click();
    // No animation to wait for: the heading is on screen in the same task as the click.
    const top = await heading.evaluate((el) => el.getBoundingClientRect().top);
    const height = page.viewportSize()!.height;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(height);
    await expect(heading).toBeFocused();
  });
});
