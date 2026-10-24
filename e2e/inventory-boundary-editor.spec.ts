import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { ADMIN_EMAIL, API_BASE, CONSULTANT_EMAIL, ENTRY_EMAIL, SUB, bearer, getAccessToken, login } from './helpers';

/**
 * LP4-03 PR C: the inventory boundary editor, end to end — a version started,
 * declared, refused and confirmed through the UI; copied, guarded against a
 * concurrent change and deleted; read by the roles that may not write.
 *
 * A frozen version is never deleted (only with its organisation), so this
 * spec owns a year no other spec reads — 2028 — and holds on a rerun: an open
 * version a failed run left behind is deleted first, each run confirms one new
 * version, and the copy it makes is deleted again. Only seed subsidiaries are
 * declared: a subsidiary or location a frozen version holds can never be
 * deleted, so an E2E-created one would break its spec's cleanup.
 */

const YEAR = 2028;
const CATEGORIES = ['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'] as const;
// As a boundary names a subsidiary: its trading name (the API's `tradingName || legalName`).
const TRADING = 'TonyAI Trading';
const ENERGY = 'TonyAI Energy';
const ANKARA = 'Ankara Power Plant';
const pageUrl = `/inventory-boundary?year=${YEAR}`;

interface Version { id: string; version: number; decision: string; frozenAt: string | null }

async function adminHeaders(request: APIRequestContext) {
  return { ...bearer(await getAccessToken(request, ADMIN_EMAIL)), 'Content-Type': 'application/json' };
}

async function listVersions(request: APIRequestContext, headers: Record<string, string>): Promise<Version[]> {
  const res = await request.get(`${API_BASE}/inventory-boundaries?reportingYear=${YEAR}`, { headers });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as Version[]).sort((a, b) => b.version - a.version);
}

/** The year's open version, if a failed run left one: deleted, so the run starts from frozen ones only. */
async function deleteOpenVersion(request: APIRequestContext): Promise<void> {
  const headers = await adminHeaders(request);
  for (const v of await listVersions(request, headers)) {
    if (v.frozenAt !== null) continue;
    const res = await request.delete(`${API_BASE}/inventory-boundaries/${v.id}`, { headers });
    expect(res.status(), await res.text()).toBe(204);
  }
}

/** A Radix select by the trigger's own aria-label, inside `scope`; waits for the listbox to close. */
async function pick(page: Page, scope: Locator, label: string, option: string): Promise<void> {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  await expect(page.getByRole('listbox')).toBeHidden();
}

const subsidiaryRow = (page: Page, name: string) =>
  page.getByTestId('boundary-subsidiary').filter({ has: page.getByText(name, { exact: true }) });

/** Every category attributed to the company, annually, and excluded there with its reason. */
async function declareHolding(page: Page, editor: Locator): Promise<void> {
  for (const category of CATEGORIES) {
    await pick(page, editor, `${category}: attributed to`, 'The company');
    await pick(page, editor, `${category}: reported`, 'Annual');
    await pick(page, editor, `${category} at Company`, 'Excluded');
    await editor.getByRole('textbox', { name: `Reason for ${category} at Company`, exact: true })
      .fill('E2E holding company: no operations');
  }
}

test.describe.configure({ mode: 'serial' });

test('a super admin declares, is refused, resolves the gaps and confirms a version', async ({ page, request }) => {
  await deleteOpenVersion(request);
  await login(page, ADMIN_EMAIL);
  await page.goto(pageUrl);
  await expect(page.getByRole('heading', { name: 'Inventory boundary' })).toBeVisible();
  await expect(page.getByText(`Versions for ${YEAR}`)).toBeVisible();

  await page.getByRole('button', { name: 'Start an empty version' }).click();
  const started = page.getByText(/^Version \d+ started\.$/);
  await expect(started).toBeVisible();
  const version = Number(/\d+/.exec((await started.textContent()) ?? '')?.[0]);
  const detail = page.getByTestId('boundary-detail');
  await expect(detail).toHaveAttribute('data-state', 'open');
  await expect(detail.getByTestId('boundary-summary')).toContainText('0 of');

  // Energy with one site and one included meter: the client refuses an unnamed source on its field.
  await subsidiaryRow(page, ENERGY).getByRole('button', { name: `Declare ${ENERGY}` }).click();
  const editor = page.getByTestId('declaration-editor');
  await expect(editor.getByRole('heading', { name: `${ENERGY} — version ${version}` })).toBeVisible();
  await editor.getByLabel(ANKARA, { exact: true }).check();
  await pick(page, editor, 'Electricity: attributed to', 'Its sites');
  await pick(page, editor, 'Electricity: reported', 'Monthly');
  await pick(page, editor, `Electricity at ${ANKARA}`, 'Included');
  await editor.getByRole('button', { name: 'Add source' }).click();
  await editor.getByTestId('declaration-save').click();
  await expect(page.getByText('Problems to fix before saving: 3')).toBeVisible();
  // The evidence cadence is never defaulted: "no evidence" is a choice too.
  await expect(editor.getByTestId('declaration-issue'))
    .toHaveText(['Required.', 'Choose a category.', 'Choose whether it needs evidence, and how often.']);
  await editor.getByRole('textbox', { name: 'Name of source 1' }).fill('E2E Ankara grid meter');
  await pick(page, editor, 'Entity of source 1', ANKARA);
  await pick(page, editor, 'Category of source 1', 'Electricity');
  await pick(page, editor, 'Evidence for source 1', 'No evidence');
  await editor.getByTestId('declaration-save').click();
  await expect(page.getByText(`${ENERGY} saved.`)).toBeVisible();
  await expect(editor).toBeHidden();
  // Four categories have no attribution: gaps, stored and shown, that block a confirmation.
  const energy = subsidiaryRow(page, ENERGY);
  await expect(energy.getByRole('cell').nth(1)).toHaveText('January – December');
  await expect(energy.getByRole('cell').nth(4)).toHaveText('4');
  await detail.getByRole('button', { name: 'Confirm version' }).click();
  const confirmDialog = page.getByRole('alertdialog');
  await expect(confirmDialog.getByTestId('confirm-blocked')).toHaveText('Resolve the gaps first: 4');
  await expect(confirmDialog.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
  // The stored body is the one the form sent.
  const headers = await adminHeaders(request);
  const id = (await listVersions(request, headers))[0].id;
  const stored = await (await request.get(`${API_BASE}/inventory-boundaries/${id}`, { headers })).json();
  expect(stored.boundary.sources).toEqual([expect.objectContaining({
    name: 'E2E Ankara grid meter',
    mapping: { kind: 'mapped', category: 'Electricity', activityType: null },
    applicability: 'included',
    evidenceReportingPeriod: null,
  })]);

  // Energy leaves; the holding company is declared whole, with no gap.
  await energy.getByRole('button', { name: `Remove ${ENERGY}` }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(`${ENERGY} removed from the version.`)).toBeVisible();
  await expect(energy.getByRole('cell').nth(1)).toHaveText('Not declared');
  await subsidiaryRow(page, TRADING).getByRole('button', { name: `Declare ${TRADING}` }).click();
  await declareHolding(page, editor);
  await editor.getByTestId('declaration-save').click();
  await expect(page.getByText(`${TRADING} saved.`)).toBeVisible();
  await expect(detail.getByTestId('boundary-summary')).toContainText('No gaps');

  // Confirmed: it names what it leaves out, then freezes for good.
  await detail.getByRole('button', { name: 'Confirm version' }).click();
  await expect(confirmDialog.getByTestId('confirm-undeclared')).toContainText(ENERGY);
  await confirmDialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText(`Version ${version} confirmed.`)).toBeVisible();
  await expect(detail).toHaveAttribute('data-state', 'confirmed');
  await expect(detail.getByRole('button', { name: 'Confirm version' })).toHaveCount(0);
  await expect(subsidiaryRow(page, TRADING).getByRole('button', { name: `Edit ${TRADING}` })).toHaveCount(0);
  await subsidiaryRow(page, TRADING).getByRole('button', { name: `View ${TRADING}` }).click();
  await expect(editor.getByText('This declaration is read-only.')).toBeVisible();
  await expect(editor.getByRole('textbox', { name: 'Reason for Fuel at Company' })).toHaveValue('E2E holding company: no operations');
  await expect(editor.getByRole('textbox', { name: 'Reason for Fuel at Company' })).toBeDisabled();
  await expect(editor.getByTestId('declaration-save')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Close' }).first().click();

  const confirmed = (await listVersions(request, headers))[0];
  expect(confirmed).toMatchObject({ version, decision: 'confirmed' });
  expect(confirmed.frozenAt).not.toBeNull();
});

test('a new version copies the confirmed one, refuses a save over a concurrent change, and is deleted', async ({ browser, page, request }) => {
  const headers = await adminHeaders(request);
  try {
    await login(page, ADMIN_EMAIL);
    await page.goto(pageUrl);
    const detail = page.getByTestId('boundary-detail');
    await expect(detail).toHaveAttribute('data-state', 'confirmed');
    const from = (await listVersions(request, headers))[0].version;
    await page.getByRole('button', { name: `New version from version ${from}` }).click();
    await expect(page.getByText(`Version ${from + 1} started.`)).toBeVisible();
    await expect(detail).toHaveAttribute('data-state', 'open');
    // The copy holds the declaration as it was.
    const trading = subsidiaryRow(page, TRADING);
    await expect(trading.getByRole('cell').nth(1)).toHaveText('January – December');
    await expect(page.getByRole('button', { name: 'Start an empty version' })).toHaveCount(0);

    // An open version is still read-only for a consultant: nothing to declare, confirm or delete.
    const consultant = await browser.newContext();
    try {
      const reader = await consultant.newPage();
      await login(reader, CONSULTANT_EMAIL);
      await reader.goto(pageUrl);
      const readerDetail = reader.getByTestId('boundary-detail');
      await expect(readerDetail).toHaveAttribute('data-state', 'open');
      await expect(subsidiaryRow(reader, TRADING).getByRole('button', { name: `View ${TRADING}` })).toBeVisible();
      await expect(subsidiaryRow(reader, ENERGY)).toContainText('Not declared');
      for (const name of [/^Declare /, /^Edit /, /^Remove /, 'Confirm version', 'Delete version', 'Start an empty version']) {
        await expect(reader.getByRole('button', { name })).toHaveCount(0);
      }
    } finally {
      await consultant.close();
    }

    // Opened, then changed by someone else: the save is refused, not written over it.
    await trading.getByRole('button', { name: `Edit ${TRADING}` }).click();
    const editor = page.getByTestId('declaration-editor');
    await editor.getByRole('textbox', { name: 'Reason for Fuel at Company' }).fill('Edited in the browser');
    const open = (await listVersions(request, headers))[0];
    const changed = await request.put(`${API_BASE}/inventory-boundaries/${open.id}/subsidiaries/${SUB.trading}`, {
      headers,
      data: {
        firstMonth: 1, lastMonth: 6, sites: [], sources: [],
        attribution: CATEGORIES.map((category) => ({ category, level: 'company', reportingPeriod: 'annual' })),
        applicability: CATEGORIES.map((category) => ({ locationId: null, category, applicability: 'excluded', reason: 'Changed elsewhere' })),
      },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    await editor.getByTestId('declaration-save').click();
    await expect(page.getByText(`${TRADING} was changed by someone else after you opened it. Open it again and make your change.`)).toBeVisible();
    await expect(trading.getByRole('cell').nth(1)).toHaveText('January – June');
    const stored = await (await request.get(`${API_BASE}/inventory-boundaries/${open.id}`, { headers })).json();
    expect(stored.boundary.applicability.map((c: { reason: string }) => c.reason)).not.toContain('Edited in the browser');

    // Changed again while its confirmation is open: nothing the screen did not show is frozen.
    await detail.getByRole('button', { name: 'Confirm version' }).click();
    const confirmDialog = page.getByRole('alertdialog');
    await expect(confirmDialog.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled();
    const again = await request.put(`${API_BASE}/inventory-boundaries/${open.id}/subsidiaries/${SUB.trading}`, {
      headers,
      data: {
        firstMonth: 1, lastMonth: 3, sites: [], sources: [],
        attribution: CATEGORIES.map((category) => ({ category, level: 'company', reportingPeriod: 'annual' })),
        applicability: CATEGORIES.map((category) => ({ locationId: null, category, applicability: 'excluded', reason: 'Changed elsewhere' })),
      },
    });
    expect(again.ok(), await again.text()).toBe(true);
    await confirmDialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText(`Version ${from + 1} was changed by someone else while you looked at it. Review it again before you confirm.`)).toBeVisible();
    await expect(detail).toHaveAttribute('data-state', 'open');
    await expect(trading.getByRole('cell').nth(1)).toHaveText('January – March');

    // Deleted: the confirmed version is the year's newest again.
    await detail.getByRole('button', { name: 'Delete version' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(`Version ${from + 1} deleted.`)).toBeVisible();
    await expect(detail).toHaveAttribute('data-state', 'confirmed');
    expect((await listVersions(request, headers))[0]).toMatchObject({ version: from, decision: 'confirmed' });
  } finally {
    await deleteOpenVersion(request);
  }
});

test('the roles that may not write read the boundary, each as far as its access goes', async ({ page }) => {
  await login(page, CONSULTANT_EMAIL);
  await page.goto(pageUrl);
  await expect(page.getByTestId('boundary-read-only')).toBeVisible();
  const detail = page.getByTestId('boundary-detail');
  await expect(detail).toHaveAttribute('data-state', 'confirmed');
  // Asserted once the versions have loaded — the buttons render with them.
  await expect(page.getByRole('button', { name: 'Start an empty version' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^New version from version/ })).toHaveCount(0);
  await subsidiaryRow(page, TRADING).getByRole('button', { name: `View ${TRADING}` }).click();
  await expect(page.getByTestId('declaration-editor').getByText('This declaration is read-only.')).toBeVisible();
  await page.keyboard.press('Escape');
  // An undeclared subsidiary has nothing to view.
  await expect(subsidiaryRow(page, ENERGY)).toContainText('Not declared');
  await expect(subsidiaryRow(page, ENERGY).getByRole('button')).toHaveCount(0);

  // data_entry reads a version only through a granted subsidiary it declares; 2028 declares only Trading.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/login');
  await login(page, ENTRY_EMAIL);
  await page.goto(pageUrl);
  await expect(page.getByTestId('boundary-empty')).toHaveText(`No boundary you can read has been declared for ${YEAR}.`);
  await expect(page.getByRole('button', { name: 'Start an empty version' })).toHaveCount(0);
});
