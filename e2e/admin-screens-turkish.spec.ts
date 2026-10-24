import { test, expect, request as playwrightRequest } from '@playwright/test';
import trAudit from '../apps/web/messages/tr/audit.json';
import trErrors from '../apps/web/messages/tr/errors.json';
import trNav from '../apps/web/messages/tr/nav.json';
import trPeriods from '../apps/web/messages/tr/periods.json';
import trReview from '../apps/web/messages/tr/review.json';
import trSubsidiaries from '../apps/web/messages/tr/subsidiaries.json';
import trSubsidiaryStatus from '../apps/web/messages/tr/subsidiaryStatus.json';
import trUsers from '../apps/web/messages/tr/users.json';
import enSubsidiaries from '../apps/web/messages/en/subsidiaries.json';
import type { SubsidiarySummaryDTO } from '@tonyai/shared-types';
import { ADMIN_EMAIL, API_BASE, SUB, bearer, getAccessToken, login } from './helpers';

/**
 * Subsidiaries, Review and Audit for a Turkish profile (LP4-04 slice 2 PR C,
 * M7), and an API refusal with its own code worded in Turkish (M3). The
 * Turkish is read from the catalogue, so the owner's term review cannot break
 * this spec.
 *
 * Nothing is written: the one write attempted — deleting a seeded subsidiary
 * that holds approved records — is refused by the API, and the spec checks
 * that it is before trying. The admin's language is restored in `afterAll`
 * (and by globalSetup before every run).
 */
async function setLanguage(language: 'tr' | 'en') {
  const api = await playwrightRequest.newContext();
  try {
    const token = await getAccessToken(api, ADMIN_EMAIL);
    const res = await api.patch(`${API_BASE}/me/preferences`, { headers: bearer(token), data: { language } });
    if (res.status() !== 200) throw new Error(`language ${language}: ${res.status()}`);
  } finally {
    await api.dispose();
  }
}

// On its own request context, so a timed-out test still leaves the seed user
// in English for the specs after it.
test.afterAll(async () => setLanguage('en'));

test('Subsidiaries, Review and Audit speak Turkish', async ({ page }) => {
  await setLanguage('tr');
  await login(page, ADMIN_EMAIL);

  // The register: heading, columns, a status in Turkish, both drawers.
  await page.goto('/subsidiaries');
  await expect(page.getByRole('heading', { name: trSubsidiaries.list.title })).toBeVisible();
  await expect(page.getByText(trSubsidiaries.list.register, { exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: trSubsidiaries.list.columns.legalName })).toBeVisible();
  const energy = page.locator('tr', { hasText: 'TonyAI Energy' });
  await expect(energy.getByText(trSubsidiaryStatus.active, { exact: true })).toBeVisible();

  await energy.getByRole('button', { name: trSubsidiaries.list.manageLocations }).click();
  await expect(page.getByRole('dialog').getByText(trSubsidiaries.locations.drawerTitle, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await energy.getByRole('button', { name: trSubsidiaries.list.manageLocks }).click();
  await expect(page.getByRole('dialog').getByText(trSubsidiaries.locks.title, { exact: true })).toBeVisible();
  await expect(page.getByText(trSubsidiaries.locks.closeTitle, { exact: true })).toBeVisible();
  // The form's period and value are named in Turkish; the value sent stays canonical.
  await expect(page.getByText(trPeriods.granularity.quarterly, { exact: true })).toBeVisible();
  await expect(page.getByText(trPeriods.values.Q1, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // The detail page: its cards and what depends on it, worded from the facts.
  await page.goto(`/subsidiaries/${SUB.energy}`);
  await expect(page.getByText(trSubsidiaries.detail.details, { exact: true })).toBeVisible();
  await expect(page.getByText(trSubsidiaries.dependents.title, { exact: true })).toBeVisible();
  await expect(page.getByText(trSubsidiaries.dependents.blocked, { exact: true })).toBeVisible();
  // The blocker sentence itself (past the count), not the counter's label.
  const terminal = trSubsidiaries.blockers.terminalRecords.split('{count}')[1].trim().slice(0, 60);
  await expect(page.getByRole('listitem').filter({ hasText: terminal })).toBeVisible();

  // The review queue.
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: trReview.title })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: trReview.columns.waiting })).toBeVisible();
  await expect(page.getByTestId('review-queue-total')).toContainText(trReview.awaitingReview.replace('{count} ', ''));

  // The audit trail: Turkish chrome, roles by name, codes as identifiers (M2).
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: trAudit.title })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: trAudit.columns.role })).toBeVisible();
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(page.getByText(trUsers.roles.super_admin, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(new RegExp(`^${trAudit.page.split('{page}')[0]}1 / `))).toBeVisible();

  // English through the switcher.
  await page.goto('/subsidiaries');
  await page.getByRole('button', { name: trNav.languages.en }).click();
  await expect(page.getByRole('heading', { name: enSubsidiaries.list.title })).toBeVisible();
});

test('a coded refusal is worded in Turkish, the English detail beneath it', async ({ page, request }) => {
  // The API refuses this delete: the seeded subsidiary holds approved records.
  // Checked before trying, so this spec can never delete seed data.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const res = await request.get(`${API_BASE}/subsidiaries/${SUB.energy}/summary`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  const summary = (await res.json()) as SubsidiarySummaryDTO;
  expect(summary.hasBlockingDependents).toBe(true);
  expect(summary.blockerCounts.map((b) => b.kind)).toEqual(['terminalRecords']);

  await setLanguage('tr');
  await login(page, ADMIN_EMAIL);
  await page.goto('/subsidiaries');
  await page.locator('tr', { hasText: 'TonyAI Energy' }).getByRole('button', { name: trSubsidiaries.list.delete }).click();
  await expect(page.getByRole('alertdialog')).toContainText(trSubsidiaries.list.deleteTitle);
  await page.getByRole('alertdialog').getByRole('button', { name: trSubsidiaries.list.deleteConfirm, exact: true }).click();

  // `subsidiary_in_use`: the catalogue's Turkish sentence, the server's English
  // (which names each dependent) beneath it.
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: trErrors.codes.subsidiary_in_use });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('approved, locked or voided activity record(s)');
  // Still there.
  await expect(page.locator('tr', { hasText: 'TonyAI Energy' })).toBeVisible();
});
