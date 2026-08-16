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

test('a record awaiting review blocks the delete WITHOUT calling it permanent', async ({ request }) => {
  // `submitted` and `under_review` look terminal and are not — a reviewer sends
  // the record back and it becomes deletable, and so does the subsidiary. The
  // first cut of this guard lumped them in with `approved` and told the caller
  // to retire the entity as inactive, foreclosing an action the API grants.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Review Guard');
  const rec = await (await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, locationId: null, reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD, periodValue: 'Q1', category: 'Electricity',
      activityValue: 42, activityUnit: 'kWh', varianceReason: null, input: null },
  })).json();
  await request.post(`${API_BASE}/activity-records/${rec.id}/evidence`, {
    headers: bearer(token),
    multipart: { file: { name: 'review.pdf', mimeType: 'application/pdf', buffer: readFileSync(EVIDENCE_FIXTURE) } },
  });
  expect((await request.post(`${API_BASE}/activity-records/${rec.id}/submit`, { headers: bearer(token) })).status()).toBe(200);

  const blocked = await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
  expect(blocked.status()).toBe(409);
  const message = (await blocked.json()).message as string;
  expect(message).toMatch(/1 record\(s\) awaiting review/);
  expect(message).toMatch(/sent back by a reviewer/);
  expect(message).not.toMatch(/inactive/);

  // Follow it: a reviewer sends the record back, and the subsidiary really does
  // become disposable. This is the assertion the old copy contradicted.
  expect((await request.post(`${API_BASE}/activity-records/${rec.id}/reject`, {
    headers: bearer(token), data: { varianceReason: 'E2E: sent back' },
  })).status()).toBe(200);
  expect((await request.delete(`${API_BASE}/activity-records/${rec.id}`, { headers: bearer(token) })).status()).toBe(200);
  expect((await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) })).status()).toBe(200);
});

test('deleting a subsidiary takes its own locations, with an audit row each', async ({ request }) => {
  // The refusal existed because the FK cascade destroyed locations UNAUDITED,
  // behind one "delete subsidiary" row. Writing a row each removes the
  // objection, so a record-free location no longer blocks — and PR 3 made that
  // friction routine by requiring a location at create time.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Cascade Audit');
  const made = [];
  for (const name of ['E2E Cascade A', 'E2E Cascade B']) {
    made.push(await (await request.post(`${API_BASE}/locations`, {
      headers: bearer(token),
      data: { subsidiaryId: sub.id, name, geographyCode: 'TR' },
    })).json());
  }

  // The panel and the guard agree that this is deletable.
  const summary = await (await request.get(`${API_BASE}/subsidiaries/${sub.id}/summary`, {
    headers: bearer(token),
  })).json();
  expect(summary.locations).toBe(2);
  expect(summary.hasBlockingDependents, 'a record-free location is not a blocker').toBe(false);
  expect(summary.blockers).toEqual([]);

  expect((await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) })).status()).toBe(200);

  // One `delete location` row per location — the whole point. A batched row, or
  // none at all, is the unaudited cascade this guard was built to stop.
  for (const loc of made) {
    const audit = await (await request.get(
      `${API_BASE}/audit?entity=location&action=delete&entityId=${loc.id}`,
      { headers: bearer(token) },
    )).json();
    expect(audit.total, `one delete row for ${loc.name}`).toBe(1);
    expect(audit.items[0].diff.before.name).toBe(loc.name);
  }
  // …and they really are gone.
  expect((await request.get(`${API_BASE}/locations/${made[0].id}`, { headers: bearer(token) })).status()).toBe(404);
});

test('a location holding a record blocks only through that record', async ({ request }) => {
  // The tier that refuses on a location is for the INVARIANT VIOLATION — a
  // record of another subsidiary pointing here — which the API refuses to
  // create and no test can reach without raw SQL. What a normal draft record at
  // a location does is block through the record tier, and clearing the record
  // is enough: the location then goes with the subsidiary.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Loc With Records');
  const loc = await (await request.post(`${API_BASE}/locations`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, name: 'E2E Held Site', geographyCode: 'UK' },
  })).json();
  await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, locationId: loc.id, reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD, periodValue: 'Q3', category: 'Electricity',
      activityValue: 12, activityUnit: 'kWh', varianceReason: null, input: null },
  });

  const refused = await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
  expect(refused.status()).toBe(409);
  const message = (await refused.json()).message as string;
  expect(message).toMatch(/1 draft or rejected record/);
  // The location is NOT named. It used to be, which produced advice that
  // contradicted itself — remove the location, and the location stays — and
  // neither was true.
  expect(message).not.toMatch(/location\(s\)/);

  const still = await request.get(`${API_BASE}/locations/${loc.id}`, { headers: bearer(token) });
  expect(still.status(), 'the location must survive the refused delete').toBe(200);

  // Clear only the record, and the delete goes through with the location swept.
  const records = await (await request.get(
    `${API_BASE}/activity-records?subsidiaryId=${sub.id}`, { headers: bearer(token) },
  )).json();
  await request.delete(`${API_BASE}/activity-records/${records[0].id}`, { headers: bearer(token) });
  expect((await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) })).status()).toBe(200);
  expect((await request.get(`${API_BASE}/locations/${loc.id}`, { headers: bearer(token) })).status()).toBe(404);
});

test('a disposable subsidiary can still be emptied and deleted', async ({ request }) => {
  // The counterpart to the test above. Everything under a subsidiary is ON
  // DELETE CASCADE — locations included — so the guard blocks on all of it, not
  // just records. That is only defensible if the advice can be followed, so
  // walk the whole path: block, clear, delete.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Empty Guard');

  const loc = await (await request.post(`${API_BASE}/locations`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, name: 'E2E Disposable Site', geographyCode: 'UK' },
  })).json();
  const draft = await (await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, locationId: loc.id, reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD, periodValue: 'Q3', category: 'Electricity',
      activityValue: 10, activityUnit: 'kWh', varianceReason: null, input: null },
  })).json();

  const blocked = await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
  expect(blocked.status()).toBe(409);
  const message = (await blocked.json()).message as string;
  expect(message).toMatch(/1 draft or rejected record\(s\)/);
  // The location is NOT listed. This assertion used to carry a trailing `\.`
  // and passed for the wrong reason: the message DID name the location, and
  // dropping the dot showed it. The advice was self-contradictory too — remove
  // the location, and also the location stays — because the tier counted every
  // record at a location rather than only ones belonging to another subsidiary.
  expect(message).not.toMatch(/location\(s\)/);
  // Nothing here is committed, so "retire it as inactive" would be the wrong
  // advice — this subsidiary really can go.
  expect(message).not.toMatch(/inactive/);

  // Follow the advice — which is now just the record; the location goes with
  // the subsidiary.
  expect((await request.delete(`${API_BASE}/activity-records/${draft.id}`, { headers: bearer(token) })).status()).toBe(200);
  expect((await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) })).status()).toBe(200);
  expect((await request.get(`${API_BASE}/locations/${loc.id}`, { headers: bearer(token) })).status()).toBe(404);
  expect((await request.get(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) })).status()).toBe(404);
});

test('locationName is a read-time field and never enters the audit trail', async ({ request }) => {
  // `audit_log` is append-only: a wrong value written here is permanent. Before
  // the read/audit split, a create whose locationId was set logged
  // `locationName: null`, and the next unrelated edit logged `null → "…"`,
  // dating a geography decision to a day nothing about the location changed.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await makeSubsidiary(request, token, 'E2E Test Co Audit Guard');
  const loc = await (await request.post(`${API_BASE}/locations`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, name: 'E2E Audited Site', geographyCode: 'UK' },
  })).json();

  const created = await (await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, locationId: loc.id, reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD, periodValue: 'Q4', category: 'Electricity',
      activityValue: 10, activityUnit: 'kWh', varianceReason: null, input: null },
  })).json();

  // Every read path agrees — including the 201 body and GET /:id, which used to
  // answer `null` because only `list` carried the join.
  expect(created.locationName).toBe('E2E Audited Site');
  const fetched = await (await request.get(`${API_BASE}/activity-records/${created.id}`, { headers: bearer(token) })).json();
  expect(fetched.locationName).toBe('E2E Audited Site');

  const audit = await (await request.get(
    `${API_BASE}/audit?entity=activity_record&action=create&entityId=${created.id}`,
    { headers: bearer(token) },
  )).json();
  const createRow = audit.items[0];
  expect(createRow.diff.after.locationId).toBe(loc.id);
  expect(createRow.diff.after).not.toHaveProperty('locationName');

  // Clean up in the order the guard requires.
  await request.delete(`${API_BASE}/activity-records/${created.id}`, { headers: bearer(token) });
  await request.delete(`${API_BASE}/locations/${loc.id}`, { headers: bearer(token) });
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
  const loc = await (await request.post(`${API_BASE}/locations`, {
    headers: bearer(token),
    data: { subsidiaryId: sub.id, name: 'E2E Warn Site', geographyCode: 'TR' },
  })).json();
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
    // Assert BOTH statuses. This cleanup was written before the widened delete
    // guard and silently started 409-ing once a location counted as a blocker —
    // the suite stayed green while the spec advertised a self-cleanup it no
    // longer performed, leaning on the privileged afterAll without saying so.
    // An unasserted teardown call is indistinguishable from a working one.
    const locGone = await request.delete(`${API_BASE}/locations/${loc.id}`, { headers: bearer(token) });
    expect(locGone.status()).toBe(200);
    const subGone = await request.delete(`${API_BASE}/subsidiaries/${sub.id}`, { headers: bearer(token) });
    expect(subGone.status()).toBe(200);
  }
});
