import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  login, bearer, getAccessToken, pickByFieldLabel, cleanupE2ESubsidiaries,
  ADMIN_EMAIL, ENTRY_EMAIL, API_BASE, E2E_YEAR, E2E_PERIOD, EVIDENCE_FIXTURE,
} from './helpers';

/**
 * WP16 PR 1 — the safety net under the locations work.
 *
 * Locations had full CRUD and zero end-to-end coverage. WP16's next two PRs put
 * locations into the create flow and a control panel, so the destructive edges
 * need pinning first.
 */

/**
 * These specs deliberately create subsidiaries the API now REFUSES to delete —
 * that refusal is the thing under test. So they are reclaimed the privileged
 * way, exactly as the global teardown does; otherwise they survive the run and
 * break every spec that asserts an absolute subsidiary count.
 */
test.afterAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext();
  try {
    await cleanupE2ESubsidiaries(ctx);
  } finally {
    await ctx.dispose();
  }
});

async function makeSubsidiary(request: import('@playwright/test').APIRequestContext, token: string, name: string) {
  const res = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: name, geographyCode: 'TR', reportingStatus: 'active' },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test('a location with records cannot be deleted, and says how many', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Loc Guard');
  try {
    const loc = await (await request.post(`${API_BASE}/locations`, {
      headers: bearer(token),
      data: { subsidiaryId: sub.id, name: 'E2E Guarded Site', geographyCode: 'UK' },
    })).json();

    // Before any record: deletable.
    const emptyDelete = await request.delete(`${API_BASE}/locations/${loc.id}`, { headers: bearer(token) });
    expect(emptyDelete.status()).toBe(200);

    const loc2 = await (await request.post(`${API_BASE}/locations`, {
      headers: bearer(token),
      data: { subsidiaryId: sub.id, name: 'E2E Guarded Site 2', geographyCode: 'UK' },
    })).json();
    const rec = await (await request.post(`${API_BASE}/activity-records`, {
      headers: bearer(token),
      data: { subsidiaryId: sub.id, locationId: loc2.id, reportingYear: E2E_YEAR,
        reportingPeriod: E2E_PERIOD, periodValue: 'Q1', category: 'Electricity',
        activityValue: 100, activityUnit: 'kWh', varianceReason: null, input: null },
    })).json();

    // The record took the LOCATION's geography, not the subsidiary's.
    expect(rec.calculation.geographyCode).toBe('UK');

    const refused = await request.delete(`${API_BASE}/locations/${loc2.id}`, { headers: bearer(token) });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).message).toMatch(/1 activity record/);

    // …and the record is untouched: still attached, still UK.
    const after = await (await request.get(`${API_BASE}/activity-records/${rec.id}`, { headers: bearer(token) })).json();
    expect(after.locationId).toBe(loc2.id);
    expect(after.calculation.geographyCode).toBe('UK');
  } finally {
    // service-role teardown reclaims `E2E Test Co*` even though the API refuses
  }
});

test('a subsidiary holding committed records cannot be deleted', async ({ request }) => {
  // The FK is ON DELETE CASCADE, so this used to DESTROY approved records,
  // their evidence and their targets, leaving one audit row about the
  // subsidiary and nothing about the inventory that went with it.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Sub Guard');
  const rec = await (await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, locationId: null, reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD, periodValue: 'Q2', category: 'Electricity',
      activityValue: 5000, activityUnit: 'kWh', varianceReason: null, input: null },
  })).json();
  await request.post(`${API_BASE}/activity-records/${rec.id}/evidence`, {
    headers: bearer(token),
    multipart: { file: { name: 'guard.pdf', mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) } },
  });
  await request.post(`${API_BASE}/activity-records/${rec.id}/submit`, { headers: bearer(token) });
  const approved = await request.post(`${API_BASE}/activity-records/${rec.id}/approve`, { headers: bearer(token) });
  expect((await approved.json()).status).toBe('approved');

  const refused = await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
  expect(refused.status()).toBe(409);
  // The advice has to be one the user can follow: an approved record cannot be
  // deleted at all, so "delete the records first" would be a dead end.
  expect((await refused.json()).message).toMatch(/inactive/);

  const still = await request.get(`${API_BASE}/activity-records/${rec.id}`, { headers: bearer(token) });
  expect(still.status(), 'the approved record must survive the refused delete').toBe(200);
});

test('only a super_admin may write locations', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Loc RBAC');

  const refused = await request.post(`${API_BASE}/locations`, {
    headers: bearer(entry),
    data: { subsidiaryId: sub.id, name: 'E2E Nope', geographyCode: 'TR' },
  });
  expect(refused.status()).toBe(403);

  // …and the drawer offers no write controls to that role.
  await login(page, ENTRY_EMAIL);
  await page.goto('/subsidiaries');
  await page.getByRole('button', { name: 'Manage locations' }).first().click();
  await expect(page.getByRole('button', { name: /^Add location$/ })).toHaveCount(0);

  // No switchUser: the drawer overlay covers Sign out, and cleanup goes through
  // the API context, which carries its own admin token.
  await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
});

test('changing a location geography is confirmed, not silent', async ({ page, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Geo Warn');
  await request.post(`${API_BASE}/locations`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, name: 'E2E Warn Site', geographyCode: 'TR' },
  });
  try {
    await login(page, ADMIN_EMAIL);
    await page.goto('/subsidiaries');
    await page.locator('tr', { hasText: 'E2E Test Co Geo Warn' })
      .getByRole('button', { name: 'Manage locations' }).click();
    await page.getByRole('button', { name: 'Edit' }).first().click();

    await pickByFieldLabel(page, 'Geography *', 'United Kingdom (UK)');
    await page.getByRole('button', { name: /Save location|Update location|Save/ }).first().click();

    const alert = page.locator('[role="alertdialog"][data-state="open"]');
    await expect(alert.getByText(/Change geography from TR to UK\?/)).toBeVisible();
    await expect(alert.getByText(/keep the emission factor they were calculated with/)).toBeVisible();
    await alert.getByRole('button', { name: 'Cancel' }).click();
  } finally {
    await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
  }
});
