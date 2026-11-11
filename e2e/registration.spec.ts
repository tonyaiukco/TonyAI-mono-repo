import { test, expect } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_BASE,
  cleanupE2ERegistrations,
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
 * administrator of a new organisation.
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
