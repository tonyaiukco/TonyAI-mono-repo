import { test, expect } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_BASE,
  bearer,
  cleanupE2ERegistrations,
  E2E_PERIOD,
  E2E_YEAR,
  E2E_REGISTRATION_PREFIX,
  getAccessToken,
  login,
  organisationsNamed,
  registeredAccount,
  registrationInvitePath,
} from './helpers';

/**
 * Self-service registration, through the real page, API, database and Auth:
 * an invited company registers behind the registration code, follows its
 * invitation link, chooses a password and lands signed in as the first
 * administrator of a new organisation — whose one subsidiary, named by the
 * company, takes a facility at once (UAT round 2, K1).
 *
 * The API under test runs with `REGISTRATION_CODE=local` (playwright.config.ts;
 * `pnpm setup` writes the same to apps/api/.env). The public endpoint shares
 * the reset's quota of five requests a minute per client address: this file
 * makes four, and no other spec posts to either route — so a second run
 * against the same API inside a minute meets the quota (429).
 */

const CODE = 'local';
const run = Date.now().toString(36);
const company = `${E2E_REGISTRATION_PREFIX}${run}`;
const email = `e2e-registration-${run}@tonyai.local`;
const password = `registered-${run}-pass`;

test.describe('self-service registration', () => {
  test.beforeAll(async ({ request }) => {
    await cleanupE2ERegistrations(request);
  });
  test.afterAll(async ({ request }) => {
    await cleanupE2ERegistrations(request);
  });

  test('a company registers, follows the invitation and signs in as its first administrator', async ({ page, request }) => {
    await page.goto('/register');
    await expect(page.getByText('Register your company')).toBeVisible();
    // The notice is labelled for what it is while the reviewed text is not written.
    await expect(page.getByText('Placeholder text — not the final notice')).toBeVisible();

    await page.locator('#firstName').fill('Ada');
    await page.locator('#lastName').fill('Yilmaz');
    await page.locator('#companyName').fill(company);
    await page.locator('#jobTitle').fill('Sustainability Manager');
    await page.locator('#email').fill(email);
    // The right letters in the wrong case: the code is case-sensitive.
    await page.locator('#registrationCode').fill('LOCAL');

    // Not without the notice accepted — and nothing is sent.
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Accept the personal data notice to register.' })).toBeVisible();
    await page.locator('#consent').click();

    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'This registration code is not valid.' })).toBeVisible();
    // The form is kept as typed, and nothing was created.
    await expect(page.locator('#companyName')).toHaveValue(company);
    await expect(page.locator('#email')).toHaveValue(email);
    expect(await registeredAccount(email)).toBeNull();

    await page.locator('#registrationCode').fill(CODE);
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByText('Check your email')).toBeVisible();
    await expect(page.getByText(`If ${email} does not have an account yet`)).toBeVisible();
    await expect(page.locator('#firstName')).toHaveCount(0);

    // The work follows the answer: wait for the rows.
    await expect.poll(async () => (await registeredAccount(email))?.consents ?? 0, { timeout: 15_000 }).toBe(1);
    const account = (await registeredAccount(email))!;
    expect(account).toMatchObject({
      role: 'super_admin',
      jobTitle: 'Sustainability Manager',
      language: 'en',
      legalName: company,
      country: 'TR',
      geographyCode: 'TR',
      reportingCurrency: 'TRY',
    });

    const invitation = await registrationInvitePath(request, email);
    test.info().annotations.push({ type: 'invitation link', description: `from ${invitation.from}` });
    await page.goto(invitation.path);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL('**/auth/set-password**');
    await page.locator('#new-password').fill(password);
    await page.locator('#repeat-password').fill(password);
    await page.getByRole('button', { name: 'Save the password', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/');

    // Signed in as the first administrator of the new organisation, with the invitation closed.
    const token = await getAccessToken(request, email, password);
    const me = await (await request.get(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
    expect(me).toMatchObject({ email, fullName: 'Ada Yilmaz', role: 'super_admin', organisationId: account.organisationId });
    await expect.poll(async () => (await registeredAccount(email))?.invitationStatus).toBe('accepted');

    // K1: the new company is born with one subsidiary — itself. Before any
    // facility exists, Data Entry offers it and a record can be entered for it.
    const subsidiaries = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
    expect(subsidiaries.map((s: { legalName: string }) => s.legalName)).toEqual([company]);
    const [defaultSubsidiary] = subsidiaries as { id: string }[];
    await page.goto('/data-entry');
    await expect(page.getByRole('heading', { name: 'Data Entry' })).toBeVisible();
    await expect(page.getByText('No subsidiaries accessible to your account.')).toHaveCount(0);
    await expect(page.getByRole('combobox').filter({ hasText: company })).toBeVisible();
    const draft = await request.post(`${API_BASE}/activity-records`, {
      headers: bearer(token),
      data: { subsidiaryId: defaultSubsidiary.id, locationId: null, reportingYear: E2E_YEAR, reportingPeriod: E2E_PERIOD,
        periodValue: 'Q1', category: 'Electricity', activityValue: 1, activityUnit: 'kWh', varianceReason: null, input: null },
    });
    expect(draft.status(), await draft.text()).toBe(201);
    // Removed again, so the organisation's teardown is not held by a record.
    const removed = await request.delete(`${API_BASE}/activity-records/${(await draft.json()).id}`, { headers: bearer(token) });
    expect(removed.ok(), await removed.text()).toBe(true);

    // And a facility is added to it as to any subsidiary.
    await page.goto('/subsidiaries');
    const row = page.locator('tr', { hasText: company });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: 'Manage facilities' }).click();
    const nameField = page.getByRole('dialog').locator('div.space-y-2', { has: page.getByText('Name *', { exact: true }) });
    await nameField.getByRole('textbox').fill('E2E Registered Plant');
    await page.getByRole('button', { name: 'Add facility', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('E2E Registered Plant')).toBeVisible();
    await page.keyboard.press('Escape');

    // The same address again: the same answer, and still one organisation.
    await page.context().clearCookies();
    await page.goto('/register');
    await page.locator('#firstName').fill('Ada');
    await page.locator('#lastName').fill('Yilmaz');
    await page.locator('#companyName').fill(`${company} again`);
    await page.locator('#jobTitle').fill('Sustainability Manager');
    await page.locator('#email').fill(email);
    await page.locator('#registrationCode').fill(CODE);
    await page.locator('#consent').click();
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByText('Check your email')).toBeVisible();
    await expect(page.getByText(`If ${email} does not have an account yet`)).toBeVisible();
    // The work follows the answer: give the job time to run, then look for what it must not have made.
    await page.waitForTimeout(1_500);
    expect(await organisationsNamed(`${company} again`)).toBe(0);
    expect(await organisationsNamed(company)).toBe(1);
    expect((await registeredAccount(email))!.organisationId).toBe(account.organisationId);
  });

  test('the page speaks Turkish to a Turkish visitor', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'tonyai-locale', value: 'tr', url: baseURL ?? 'http://localhost:3000' }]);
    await page.goto('/register');
    await expect(page.getByText('Şirketinizi kaydedin')).toBeVisible();
    for (const label of ['Ad', 'Soyad', 'Şirket Adı', 'Unvan', 'Şirket E-postası', 'Kayıt kodu']) {
      await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('Yer tutucu metin — nihai aydınlatma metni değildir')).toBeVisible();

    // Submitted in Turkish, the account — and so its invitation email — is Turkish.
    const turkishEmail = `e2e-registration-tr-${run}@tonyai.local`;
    await page.getByLabel('Ad', { exact: true }).fill('Ayşe');
    await page.getByLabel('Soyad', { exact: true }).fill('Yılmaz');
    await page.getByLabel('Şirket Adı', { exact: true }).fill(`${company} TR`);
    await page.getByLabel('Unvan', { exact: true }).fill('Sürdürülebilirlik Müdürü');
    await page.getByLabel('Şirket E-postası', { exact: true }).fill(turkishEmail);
    await page.getByLabel('Kayıt kodu', { exact: true }).fill(CODE);
    await page.locator('#consent').click();
    await page.getByRole('button', { name: 'Kaydol', exact: true }).click();
    await expect(page.getByText('E-postanızı kontrol edin')).toBeVisible();
    await expect.poll(async () => (await registeredAccount(turkishEmail))?.language, { timeout: 15_000 }).toBe('tr');
    expect(await registeredAccount(turkishEmail)).toMatchObject({ jobTitle: 'Sürdürülebilirlik Müdürü', legalName: `${company} TR` });
  });

  test('says so when registration is switched off, and offers a retry when it cannot be reached', async ({ page }) => {
    await page.route('**/api/v1/auth/registration', (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 404, code: 'registration_unavailable', message: 'Registration is not available' }),
      }),
    );
    await page.goto('/register');
    await expect(page.getByText('Registration is not available', { exact: true })).toBeVisible();
    await expect(page.locator('#registrationCode')).toHaveCount(0);

    await page.unroute('**/api/v1/auth/registration');
    await page.route('**/api/v1/auth/registration', (route) => route.abort());
    await page.goto('/register');
    await expect(page.getByText('Registration could not be loaded')).toBeVisible();
    await expect(page.locator('#registrationCode')).toHaveCount(0);
    // Reachable again: Try again brings the form.
    await page.unroute('**/api/v1/auth/registration');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.locator('#registrationCode')).toBeVisible();
  });

  test('the sign-in page offers registration while it is open, in the visitor\'s language', async ({ page, context, baseURL }) => {
    await page.goto('/login');
    const link = page.getByRole('link', { name: 'Register your company', exact: true });
    await expect(link).toBeVisible();
    await expect(page.getByText('No account yet?')).toBeVisible();
    // A path on this web app, never another host's page.
    await expect(link).toHaveAttribute('href', '/register');
    await link.click();
    await page.waitForURL((url) => url.pathname === '/register');
    expect(new URL(page.url()).origin).toBe(new URL(baseURL ?? 'http://localhost:3000').origin);
    await expect(page.locator('#registrationCode')).toBeVisible();

    await context.addCookies([{ name: 'tonyai-locale', value: 'tr', url: baseURL ?? 'http://localhost:3000' }]);
    await page.goto('/login');
    await expect(page.getByText('Hesabınız yok mu?')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Şirketinizi kaydedin', exact: true })).toBeVisible();
  });

  test('the sign-in page offers no registration where it is off or cannot be read, and still signs in', async ({ page }) => {
    let asked = 0;
    await page.route('**/api/v1/auth/registration', (route) => {
      asked += 1;
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 404, code: 'registration_unavailable', message: 'Registration is not available' }),
      });
    });
    await page.goto('/login');
    // The answer has arrived before the absence is asserted.
    await expect.poll(() => asked).toBeGreaterThan(0);
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Register your company' })).toHaveCount(0);
    await expect(page.getByText('No account yet?')).toHaveCount(0);
    await expect(page.getByText(/registration/i)).toHaveCount(0);

    await page.unroute('**/api/v1/auth/registration');
    let aborted = 0;
    await page.route('**/api/v1/auth/registration', (route) => {
      aborted += 1;
      return route.abort();
    });
    await page.goto('/login');
    await expect.poll(() => aborted).toBeGreaterThan(0);
    await expect(page.getByRole('link', { name: 'Register your company' })).toHaveCount(0);
    // No error is shown for it, and signing in does not depend on it.
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    await login(page, ADMIN_EMAIL);
  });

  test('a page built for another notice than the API records shows no form', async ({ page }) => {
    await page.route('**/api/v1/auth/registration', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ consentVersion: 'kvkk-other-build', consentIsPlaceholder: false }) }),
    );
    await page.goto('/register');
    await expect(page.getByText('This page is out of date')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reload the page', exact: true })).toBeVisible();
    await expect(page.locator('#registrationCode')).toHaveCount(0);
  });

  test('a signed-in visitor has nothing to register and goes to the dashboard', async ({ page }) => {
    await login(page, ADMIN_EMAIL);
    await page.goto('/register');
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.locator('#registrationCode')).toHaveCount(0);
  });
});
