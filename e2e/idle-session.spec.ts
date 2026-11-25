import { expect, test } from '@playwright/test';
import en from '../apps/web/messages/en/auth.json';
import tr from '../apps/web/messages/tr/auth.json';
import { login, PASSWORD, VIEWER_EMAIL } from './helpers';

const minute = 60_000;

for (const [locale, catalogue] of Object.entries({ en, tr })) {
  test(`an idle viewer must sign in again (${locale})`, async ({ page, context, baseURL }) => {
    await page.clock.install();
    await login(page, VIEWER_EMAIL);
    await context.addCookies([{ name: 'tonyai-locale', value: locale, url: baseURL! }]);
    await page.clock.fastForward(61 * minute);
    await expect(page).toHaveURL(/\/login\?reason=idle$/);
    await expect(page.getByText(catalogue.signIn.idle)).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
}

for (const secondTab of [false, true]) {
  test(`activity at minute 59 keeps the viewer signed in (${secondTab ? 'another tab' : 'same tab'})`, async ({ page, context }) => {
    await page.clock.install();
    await login(page, VIEWER_EMAIL);
    const active = secondTab ? await context.newPage() : page;
    if (secondTab) {
      await active.goto('/');
      await expect(active.getByTestId('dashboard-title')).toBeVisible();
    }
    // Freeze both tabs on the same instant before advancing their timers.
    await page.clock.pauseAt(new Date(Date.now() + 5000));
    await page.clock.fastForward(59 * minute);
    const activityAt = await active.evaluate(() => Date.now());
    await active.keyboard.press('Shift');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('tonyai-last-activity'))).toBe(String(activityAt));
    await page.clock.fastForward(2 * minute);
    await expect(page).toHaveURL(url => url.pathname === '/');
    await expect(page.getByTestId('dashboard-title')).toBeVisible();
    await page.clock.fastForward(minute);
    await expect(page.getByTestId('dashboard-title')).toBeVisible();
    await page.clock.fastForward(58 * minute);
    await expect(page).toHaveURL(/\/login\?reason=idle$/);
  });
}

test('a reopened tab checks inactivity before mounting the dashboard', async ({ page, context }) => {
  await page.clock.install();
  await login(page, VIEWER_EMAIL);
  const reopened = await context.newPage();
  await page.close();
  await reopened.clock.fastForward(61 * minute);
  const protectedRequests: string[] = [];
  reopened.on('request', request => {
    if (request.url().includes('/api/v1/') && !request.url().includes('/auth/registration')) protectedRequests.push(request.url());
  });
  await reopened.goto('/');
  await expect(reopened).toHaveURL(/\/login\?reason=idle$/);
  expect(protectedRequests).toEqual([]);
});

test('a password exchange in another tab takes precedence over the old idle deadline', async ({ page, context }) => {
  await page.clock.install();
  const signIn = await context.newPage();
  await signIn.goto('/login');
  await login(page, VIEWER_EMAIL);
  await signIn.locator('#email').fill(VIEWER_EMAIL);
  await signIn.locator('#password').fill(PASSWORD);

  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  await signIn.route('**/auth/v1/token?grant_type=password', async route => {
    await paused;
    await route.continue();
  });
  const exchange = signIn.waitForRequest('**/auth/v1/token?grant_type=password');
  await signIn.getByRole('button', { name: 'Sign in' }).click();
  await exchange;
  try {
    await page.clock.fastForward(61 * minute);
    await expect(page.getByTestId('dashboard-title')).toHaveCount(0);
  } finally {
    release();
  }
  await expect(signIn.getByTestId('dashboard-title')).toBeVisible();
  await expect(page.getByTestId('dashboard-title')).toBeVisible();
  await signIn.reload();
  await expect(signIn.getByTestId('dashboard-title')).toBeVisible();
});
