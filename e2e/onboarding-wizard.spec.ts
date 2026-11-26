import { test, expect, type Page } from '@playwright/test';
import { REGISTRATION_CONSENT_VERSION } from '@tonyai/shared-types';
import enOnboarding from '../apps/web/messages/en/onboarding.json';
import trOnboarding from '../apps/web/messages/tr/onboarding.json';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  E2E_INVITED_PREFIX,
  E2E_REGISTRATION_PREFIX,
  bearer,
  cleanupE2ERegistrations,
  getAccessToken,
  login,
  registeredAccount,
  registrationInvitePath,
} from './helpers';

/**
 * The masterkey's setup wizard end to end (inc26-central-reporter-onboarding,
 * task 9.2; INC-2.6 §7.1): a registered masterkey is held on the wizard on
 * every address, walks the eight steps, signs out and returns to find what it
 * saved and nothing duplicated, finishes on the company tree and is no longer
 * held. A super admin opening `/onboarding` reaches the dashboard.
 *
 * One registration (the endpoint's quota is five a minute per client address;
 * `registration.spec.ts` makes four).
 */

const run = Date.now().toString(36);
const company = `${E2E_REGISTRATION_PREFIX}wizard-${run}`;
const email = `e2e-wizard-${run}@tonyai.local`;
const password = `wizard-${run}-pass`;
const INVITED = `${E2E_INVITED_PREFIX}wizard-${run}@tonyai.local`;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ request }) => cleanupE2ERegistrations(request));
test.afterAll(async ({ request }) => cleanupE2ERegistrations(request));

const step = (page: Page) => page.getByTestId('onboarding-step-title');
const next = (page: Page) => page.getByTestId('onboarding-next').click();

async function signIn(page: Page) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === '/onboarding');
}

test('a registered masterkey sets up its organisation in the wizard, and is held there until it finishes', async ({ page, request, browser }) => {
  // Eight steps twice, a registration and two sign-ins.
  test.setTimeout(240_000);
  // Register, follow the invitation, choose a password.
  const registered = await request.post(`${API_BASE}/auth/registration`, {
    data: {
      firstName: 'Wiz', lastName: 'Ard', companyName: company, jobTitle: 'Sustainability Lead', email,
      registrationCode: 'local', consent: true, consentVersion: REGISTRATION_CONSENT_VERSION, language: 'en',
    },
  });
  expect(registered.status()).toBe(202);
  await expect.poll(async () => (await registeredAccount(email))?.consents ?? 0, { timeout: 15_000 }).toBe(1);
  const invitation = await registrationInvitePath(request, email);
  await page.goto(invitation.path);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForURL('**/auth/set-password**');
  await page.locator('#new-password').fill(password);
  await page.locator('#repeat-password').fill(password);
  await page.getByRole('button', { name: 'Save the password', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/onboarding');

  // Held on every address, also on a direct visit in a new tab.
  await page.goto('/users');
  await page.waitForURL((url) => url.pathname === '/onboarding');
  const tab = await page.context().newPage();
  await tab.goto('/data-entry');
  await tab.waitForURL((url) => url.pathname === '/onboarding');
  await expect(tab.getByTestId('onboarding-title')).toHaveText(enOnboarding.title);
  await tab.close();

  // 1. The holding: not passed without a trading name.
  await expect(step(page)).toHaveText(enOnboarding.steps.holding);
  await page.getByTestId('onboarding-trading-name').fill('');
  await next(page);
  await expect(page.getByTestId('onboarding-holding-missing')).toHaveText(enOnboarding.holding.required);
  await page.getByTestId('onboarding-trading-name').fill('E2E Wizard Holding');
  await next(page);
  // 2. Financial control.
  await expect(step(page)).toHaveText(enOnboarding.steps.approach);
  await page.getByText(enOnboarding.approach.options.financial_control, { exact: true }).click();
  await next(page);
  // 3. A sector group.
  await expect(step(page)).toHaveText(enOnboarding.steps.sectorGroups);
  await page.getByTestId('onboarding-sector-name').fill('E2E Sector');
  await page.getByRole('button', { name: enOnboarding.sectorGroups.add, exact: true }).click();
  await expect(page.getByTestId('onboarding-sector-list')).toContainText('E2E Sector');
  await next(page);
  // 4. A company, with the fuel-file hint.
  await expect(step(page)).toHaveText(enOnboarding.steps.companies);
  await expect(page.getByTestId('onboarding-fuel-hint')).toHaveText(enOnboarding.companies.hint);
  await page.getByTestId('onboarding-company-form').locator('input').first().fill('E2E Wizard Company');
  await page.getByTestId('onboarding-company-add').click();
  await expect(page.getByTestId('onboarding-company-list')).toContainText('E2E Wizard Company');
  await next(page);
  // 5. A declaration for the company: the first save opens the year's version.
  await expect(step(page)).toHaveText(enOnboarding.steps.boundaries);
  await expect(page.getByTestId('onboarding-matrix-note')).toHaveText(enOnboarding.boundaries.matrixNote);
  const row = page.getByTestId('onboarding-boundary-list').locator('li', { hasText: 'E2E Wizard Company' });
  await row.getByRole('button', { name: enOnboarding.boundaries.declare }).click();
  await page.getByTestId('declaration-save').click();
  await expect(row).toContainText(enOnboarding.boundaries.declared);
  await next(page);
  // 6. An invited super admin.
  await expect(step(page)).toHaveText(enOnboarding.steps.superAdmins);
  const invite = page.getByTestId('onboarding-invite');
  await invite.getByLabel(enOnboarding.superAdmins.fullName).fill('E2E Wizard Admin');
  await invite.getByLabel(enOnboarding.superAdmins.email).fill(INVITED);
  await invite.getByText('E2E Wizard Company', { exact: true }).click();
  await invite.getByRole('button', { name: enOnboarding.superAdmins.invite }).click();
  await expect(page.getByTestId('onboarding-admin-list')).toContainText(INVITED);
  await next(page);
  // 7. No standard user yet: the step says so, and is skipped.
  await expect(step(page)).toHaveText(enOnboarding.steps.centralReporter);
  await expect(page.getByTestId('onboarding-no-reporter')).toHaveText(enOnboarding.centralReporter.noUser);
  await next(page);
  await expect(step(page)).toHaveText(enOnboarding.steps.finish);

  // Sign out and return: the wizard starts at step 1 and shows what was saved, nothing duplicated.
  await page.getByTestId('sign-out').click();
  await page.waitForURL('**/login');
  await signIn(page);
  await expect(step(page)).toHaveText(enOnboarding.steps.holding);
  await expect(page.getByTestId('onboarding-trading-name')).toHaveValue('E2E Wizard Holding');
  await next(page);
  await expect(page.getByRole('radio', { name: enOnboarding.approach.options.financial_control })).toBeChecked();
  await next(page);
  await expect(page.getByTestId('onboarding-sector-list').locator('li', { hasText: 'E2E Sector' })).toHaveCount(1);
  await next(page);
  await expect(page.getByTestId('onboarding-company-list').locator('li', { hasText: 'E2E Wizard Company' })).toHaveCount(1);
  await next(page);
  await expect(page.getByTestId('onboarding-boundary-list').locator('li', { hasText: 'E2E Wizard Company' })).toContainText(enOnboarding.boundaries.declared);
  await next(page);
  await expect(page.getByTestId('onboarding-admin-list').locator('li', { hasText: INVITED })).toHaveCount(1);
  await next(page);
  await expect(step(page)).toHaveText(enOnboarding.steps.centralReporter);
  await next(page);
  await expect(step(page)).toHaveText(enOnboarding.steps.finish);

  // Finish on the company tree; no longer held.
  await page.getByRole('button', { name: enOnboarding.finish.submit }).click();
  await page.waitForURL((url) => url.pathname === '/subsidiaries');
  await page.goto('/users');
  await expect(page).toHaveURL(/\/users$/);
  const token = await getAccessToken(request, email, password);
  const organisation = await (await request.get(`${API_BASE}/organisation`, { headers: bearer(token) })).json();
  expect(organisation).toMatchObject({ consolidationApproach: 'financial_control' });
  expect(organisation.onboardingCompletedAt).not.toBeNull();
  const me = await (await request.get(`${API_BASE}/me`, { headers: bearer(token) })).json();
  expect(me.onboardingPending).toBe(false);

  // A super admin opening the wizard reaches the dashboard.
  const other = await browser.newContext();
  const approverPage = await other.newPage();
  await login(approverPage, APPROVER_EMAIL);
  await approverPage.goto('/onboarding');
  await approverPage.waitForURL((url) => url.pathname === '/');
  await other.close();

  // The wizard's words exist in Turkish too.
  expect(trOnboarding.steps.holding).not.toBe(enOnboarding.steps.holding);
});

test.describe('the onboarding gate (D9)', () => {
  test('a failed account read offers Try again and Sign out; Try again recovers', async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await page.route('**/api/v1/me', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"statusCode":500}' }));
    await page.reload();
    await expect(page.getByTestId('onboarding-gate-failed')).toBeVisible();
    await expect(page.getByRole('button', { name: enOnboarding.gate.signOut })).toBeVisible();
    await page.unroute('**/api/v1/me');
    // Try again — unless the gate's own retry on the next Auth event got there first.
    await page.getByRole('button', { name: enOnboarding.gate.retry }).click({ timeout: 5_000 }).catch(() => undefined);
    await expect(page.getByTestId('dashboard-title')).toBeVisible();
  });

  test('another account signing in on the same tab is decided by its own answer', async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    // A finished masterkey on the wizard's address goes to the company tree…
    await page.goto('/onboarding');
    await page.waitForURL((url) => url.pathname === '/subsidiaries');
    await page.getByTestId('sign-out').click();
    await page.waitForURL('**/login');
    // …a super admin, signed in on the same tab, to the dashboard.
    await login(page, APPROVER_EMAIL);
    await page.goto('/onboarding');
    await page.waitForURL((url) => url.pathname === '/');
  });
});
