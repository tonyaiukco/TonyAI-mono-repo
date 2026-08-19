import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_BASE,
  CONSULTANT_EMAIL,
  E2E_PERIOD,
  E2E_YEAR,
  SUB,
  approveRecord,
  bearer,
  createCommittedRecord,
  getAccessToken,
  login,
  switchUser,
} from './helpers';

/**
 * Withdrawing an approved figure (WP18 PR 2b) — the first UI for the only
 * irreversible write in the product.
 *
 * The API half shipped in PR 2a with unit tests and an RLS probe; what those
 * cannot show is whether a super_admin can actually reach it, whether anyone
 * else is offered it, and whether the numbers on screen follow. All three are
 * asserted here against the running stack.
 *
 * Writes live in the quarterly space on `TonyAI Mfg` + `Fuel` — the one
 * (subsidiary, category) pair no other spec touches, which matters more here
 * than usual: a neighbouring spec's committed record at a different value
 * becomes this one's anomaly baseline and blocks the arrangement outright, and
 * `gates.spec` leaves a period lock on the subsidiary this spec first used.
 * Each test also takes its OWN quarter: two of them void what they arrange, and
 * sharing a tuple would leave the ledger holding both a withdrawn row and its
 * replacement for the next test to pick between.
 */

const ACTIVITY_VALUE = 77_777;
const REASON = 'Duplicate of the site-level invoice for the same quarter.';

/** Create an approved figure to withdraw. Approve is API-only — there is no UI
 *  for it, and `approved` is the one status the void path accepts. */
async function arrangeApproved(
  request: APIRequestContext,
  periodValue: string,
): Promise<string> {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createCommittedRecord(request, token, {
    subsidiaryId: SUB.mfg,
    category: 'Fuel',
    periodValue,
    activityValue: ACTIVITY_VALUE,
    activityUnit: 'litres',
  });
  await approveRecord(request, token, id);
  return id;
}

/** Open the ledger row for the arranged record and return the drawer. */
async function openRecord(page: Page, periodValue: string) {
  await page.goto('/emissions');
  await page.getByRole('tab', { name: 'History' }).click();
  // Narrowed by subsidiary first: the ledger is unfiltered and the seed puts a
  // hundred monthly rows in it.
  await page
    .getByPlaceholder('Search by subsidiary, category, period, or note...')
    .fill('TonyAI Mfg');
  await page.getByRole('row').filter({ hasText: periodValue }).first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Record Detail')).toBeVisible();
  return drawer;
}

/** Fill the reason and drive both steps of the withdrawal. */
async function withdraw(page: Page, drawer: ReturnType<Page['getByRole']>) {
  await drawer.getByLabel(/^Reason \(required/).fill(REASON);
  await drawer.getByRole('button', { name: 'Withdraw from inventory' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Withdraw', exact: true })
    .click();
}

test('a super_admin withdraws an approved figure, and the record agrees', async ({
  page,
  request,
}) => {
  const recordId = await arrangeApproved(request, 'Q1');
  await login(page, ADMIN_EMAIL);
  const drawer = await openRecord(page, 'Q1');

  // Which entity the figure belongs to. The ledger has no column for it, so a
  // whole-company row and its site twin are distinguishable here and nowhere
  // else — and choosing between exactly that pair is what this control is for.
  await expect(drawer.getByText('Reporting Entity')).toBeVisible();
  await expect(drawer.getByText('Whole company')).toBeVisible();

  // The reason gate, before the happy path: the server enforces ten
  // characters, and a client that disagreed would let the user watch a request
  // fail for a rule the form said they had met.
  const reasonBox = drawer.getByLabel(/^Reason \(required/);
  const trigger = drawer.getByRole('button', { name: 'Withdraw from inventory' });
  await expect(trigger).toBeDisabled();
  await reasonBox.fill('too short');
  await expect(drawer.getByText(/at least 10 characters/)).toBeVisible();
  await expect(trigger).toBeDisabled();

  await reasonBox.fill(REASON);
  await expect(trigger).toBeEnabled();
  await trigger.click();

  // The confirmation names the tonnage rather than asking "are you sure?" —
  // the number is the only thing the user can check the click against.
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText(/This removes [\d.,]+ tCO₂e from the inventory/);
  await expect(confirm).toContainText(/cannot be undone/);
  await expect(confirm).toContainText(`Q1 ${E2E_YEAR}`);
  await confirm.getByRole('button', { name: 'Withdraw', exact: true }).click();

  // The toast says how far the inventory moved.
  await expect(
    page.getByText(/Withdrawn — [\d.,]+ tCO₂e left the inventory/),
  ).toBeVisible();

  // The drawer stays open on the withdrawn record, showing the stored reason
  // verbatim — the only confirmation the text was recorded as typed.
  await expect(drawer.getByText('Why this figure was withdrawn')).toBeVisible();
  await expect(drawer.getByText(REASON)).toBeVisible();

  // And the server agrees. Without this the test would pass on a UI that
  // rendered an optimistic result and dropped the request.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const res = await request.get(`${API_BASE}/activity-records/${recordId}`, {
    headers: bearer(token),
  });
  expect(res.ok()).toBe(true);
  const record = await res.json();
  expect(record.status).toBe('voided');
  expect(record.voidReason).toBe(REASON);
  expect(record.voidedAt).toBeTruthy();
});

test('the withdrawn figure stops counting, and its slot reopens', async ({
  page,
  request,
}) => {
  await arrangeApproved(request, 'Q2');
  const token = await getAccessToken(request, ADMIN_EMAIL);

  // Measure the inventory from the same endpoint the page reads.
  const before = await request.get(`${API_BASE}/emissions/summary`, {
    headers: bearer(token),
  });
  const totalBefore = (await before.json()).totals.total as number;

  await login(page, ADMIN_EMAIL);
  await withdraw(page, await openRecord(page, 'Q2'));
  await expect(page.getByText(/left the inventory/)).toBeVisible();

  const after = await request.get(`${API_BASE}/emissions/summary`, {
    headers: bearer(token),
  });
  const totalAfter = (await after.json()).totals.total as number;
  // `voided` is absent from COUNTED_STATUSES, so the figure leaves every total.
  // Asserting that it MOVED, not merely that the call succeeded.
  expect(totalAfter).toBeLessThan(totalBefore);

  // The other half of the capability, and the half with no visible trace: the
  // uniqueness index excludes voided rows, so the tuple is free again. A
  // withdrawal that left the slot occupied would mean this entity could never
  // report this quarter again — strictly worse than the wrong number.
  const replacement = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId: SUB.mfg,
      locationId: null,
      reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD,
      periodValue: 'Q2',
      category: 'Fuel',
      activityValue: 1_234,
      activityUnit: 'litres',
      varianceReason: null,
      input: null,
    },
  });
  expect(replacement.status()).toBe(201);
});

test('a consultant is not offered the control', async ({ page, request }) => {
  await arrangeApproved(request, 'Q3');
  await login(page, ADMIN_EMAIL);

  // Prove the control exists for the seat that has it, so the absence below is
  // about the role and not about the locator having gone stale.
  const asAdmin = await openRecord(page, 'Q3');
  await expect(
    asAdmin.getByRole('button', { name: 'Withdraw from inventory' }),
  ).toBeVisible();

  // The drawer is modal — it covers the sidebar, and `switchUser` clicks Sign
  // out there.
  await page.keyboard.press('Escape');
  await expect(asAdmin).toBeHidden();

  await switchUser(page, CONSULTANT_EMAIL);
  const asConsultant = await openRecord(page, 'Q3');
  // The consultant has org-wide read and may reject, but the service answers
  // their void with a 403. Rendering a button that always fails would teach the
  // seat to distrust the screen.
  await expect(
    asConsultant.getByRole('button', { name: 'Withdraw from inventory' }),
  ).toHaveCount(0);
  // The record is still fully readable — this is a missing control, not a
  // hidden record.
  await expect(asConsultant.getByText('Methodology & Factor')).toBeVisible();
});
