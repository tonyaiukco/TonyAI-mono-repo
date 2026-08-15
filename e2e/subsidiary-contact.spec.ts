import { test, expect } from '@playwright/test';
import {
  bearer, getAccessToken, cleanupE2ESubsidiaries,
  ADMIN_EMAIL, ENTRY_EMAIL, API_BASE, E2E_YEAR, E2E_PERIOD,
} from './helpers';

/**
 * WP16 PR 2a — the contract half of the subsidiary control panel (round-1 UAT
 * SUB-2). No UI yet; PR 2b builds `/subsidiaries/[id]` on top of this.
 */

test.afterAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext();
  try {
    await cleanupE2ESubsidiaries(ctx);
  } finally {
    await ctx.dispose();
  }
});

async function makeSubsidiary(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  const res = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: name, geographyCode: 'TR', reportingStatus: 'active', ...extra },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

test('contact details round-trip, and can be cleared once set', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Contact', {
    designatedPerson: 'Aylin Demir',
    contactEmail: 'aylin.demir@example.com',
    contactPhone: '+90 555 000 0001',
  });
  expect(sub.contactEmail).toBe('aylin.demir@example.com');
  expect(sub.contactPhone).toBe('+90 555 000 0001');

  const patched = await (await request.patch(`${API_BASE}/subsidiaries/${sub.id}`, {
    headers: bearer(token),
    data: { contactEmail: 'esg@example.com' },
  })).json();
  expect(patched.contactEmail).toBe('esg@example.com');
  // The untouched field survives a partial patch — the `!== undefined`
  // discipline, exercised against the real database rather than a mock.
  expect(patched.contactPhone).toBe('+90 555 000 0001');
  expect(patched.designatedPerson).toBe('Aylin Demir');

  // Clearing must be possible and must be distinguishable from "not provided".
  const cleared = await (await request.patch(`${API_BASE}/subsidiaries/${sub.id}`, {
    headers: bearer(token),
    data: { contactEmail: null },
  })).json();
  expect(cleared.contactEmail).toBeNull();
  expect(cleared.contactPhone).toBe('+90 555 000 0001');

  await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
});

test('a malformed address is refused before it reaches the column', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const bad = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: 'E2E Test Co Bad Email', geographyCode: 'TR', contactEmail: 'aylin' },
  });
  expect(bad.status()).toBe(400);

  // …and an undeclared field is a visible 400, not a silent drop
  // (`whitelist + forbidNonWhitelisted`).
  const unknown = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: 'E2E Test Co Unknown Key', geographyCode: 'TR', contactMobile: '+90 555' },
  });
  expect(unknown.status()).toBe(400);
});

test('summary counts every dependent, and agrees with the delete guard', async ({ request }) => {
  // The whole point of extracting the counter: a panel that computed
  // "deletable" itself would eventually disagree with the endpoint that
  // actually refuses. This walks the tiers and checks both answers each time.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Summary');

  const read = async () =>
    (await request.get(`${API_BASE}/subsidiaries/${sub.id}/summary`, { headers: bearer(token) })).json();
  const deleteStatus = async () =>
    (await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) })).status();

  // Empty: everything zero, and the guard would let it go.
  let s = await read();
  expect(s).toMatchObject({
    subsidiaryId: sub.id,
    locations: 0, terminalRecords: 0, reviewRecords: 0, openRecords: 0,
    periodLocks: 0, targets: 0, denominators: 0, deletable: true,
  });

  // One location: still no records at all, but the delete now cascades
  // something away — the tier easiest to forget.
  const loc = await (await request.post(`${API_BASE}/locations`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, name: 'E2E Summary Site', geographyCode: 'TR' },
  })).json();
  s = await read();
  expect(s.locations).toBe(1);
  expect(s.deletable).toBe(false);
  expect(await deleteStatus(), 'summary and guard must agree').toBe(409);

  // A draft record moves the open tier, not the terminal one.
  const rec = await (await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, locationId: loc.id, reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD, periodValue: 'Q1', category: 'Electricity',
      activityValue: 10, activityUnit: 'kWh', varianceReason: null, input: null },
  })).json();
  s = await read();
  expect(s).toMatchObject({ openRecords: 1, reviewRecords: 0, terminalRecords: 0 });

  // Clear it the way the 409 tells you to, and the two answers flip together.
  await request.delete(`${API_BASE}/activity-records/${rec.id}`, { headers: bearer(token) });
  await request.delete(`${API_BASE}/locations/${loc.id}`, { headers: bearer(token) });
  s = await read();
  expect(s.deletable).toBe(true);
  expect(await deleteStatus()).toBe(200);
});

test('summary is tenant-scoped, and a bad id is a 400 not a 500', async ({ request }) => {
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const sub = await makeSubsidiary(request, adminToken, 'E2E Test Co Scope');

  // data_entry has explicit access to two seeded subsidiaries only.
  const outOfScope = await request.get(`${API_BASE}/subsidiaries/${sub.id}/summary`, {
    headers: bearer(entryToken),
  });
  expect(outOfScope.status(), 'never 403 — that would confirm the row exists').toBe(404);

  const malformed = await request.get(`${API_BASE}/subsidiaries/not-a-uuid/summary`, {
    headers: bearer(adminToken),
  });
  expect(malformed.status()).toBe(400);

  await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(adminToken) });
});
