import { test, expect } from '@playwright/test';
import {
  login, bearer, getAccessToken, cleanupE2ESubsidiaries, cleanupE2ELocations,
  ADMIN_EMAIL, API_BASE,
} from './helpers';

/**
 * WP16 PR 3 — locations in the subsidiary create flow (round-1 UAT SUB-3,
 * Google Places deliberately out of scope).
 *
 * Teardown reclaims the subsidiaries, and their locations go with them through
 * `locations_subsidiary_id_fkey … ON DELETE CASCADE` — NOT through the `E2E …`
 * naming convention, which buys nothing here because this file never calls
 * `cleanupE2ELocations`. The names are kept for legibility, and
 * `cleanupE2ELocations` is called too, so that a location ever added to a
 * SEEDED subsidiary in this file is still reclaimed rather than surviving to
 * pollute every spec that follows.
 */

test.afterAll(async ({ playwright }) => {
  const ctx = await playwright.request.newContext();
  try {
    await cleanupE2ESubsidiaries(ctx);
    await cleanupE2ELocations(ctx);
  } finally {
    await ctx.dispose();
  }
});

test('a subsidiary and its locations are created in one call', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const res = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: {
      legalName: `E2E Test Co Nested ${Date.now()}`,
      geographyCode: 'TR',
      locations: [
        { name: 'E2E Nested HQ', geographyCode: 'TR', address: 'Levent' },
        { name: 'E2E Nested Depot', geographyCode: 'UK' },
      ],
    },
  });
  expect(res.status()).toBe(201);
  const sub = await res.json();

  const locations = await (await request.get(
    `${API_BASE}/locations?subsidiaryId=${sub.id}`, { headers: bearer(token) },
  )).json();
  expect(locations).toHaveLength(2);
  expect(locations.map((l: { name: string }) => l.name).sort()).toEqual([
    'E2E Nested Depot', 'E2E Nested HQ',
  ]);
  // Each one keeps its OWN geography, not the parent's — that value decides the
  // emission factor for records at that site.
  expect(locations.find((l: { name: string }) => l.name === 'E2E Nested Depot').geographyCode).toBe('UK');
  // …and the optional fields arrive with their VALUES. Hardcoding these to
  // null in the writer passed 401 unit tests and 71 E2E: nothing asserted a
  // non-blank address anywhere.
  expect(locations.find((l: { name: string }) => l.name === 'E2E Nested HQ').address).toBe('Levent');

  // The summary sees them immediately — counted, but not blocking: a
  // record-free location goes with the subsidiary when it is deleted.
  const summary = await (await request.get(
    `${API_BASE}/subsidiaries/${sub.id}/summary`, { headers: bearer(token) },
  )).json();
  expect(summary.locations).toBe(2);
  expect(summary.locationsWithRecords).toBe(0);
  expect(summary.hasBlockingDependents).toBe(false);
});

test('a location created this way is indistinguishable in the audit trail', async ({ request }) => {
  // The reason the shared writer lives in LocationsService. If the two paths
  // wrote different rows, the meaning of the audit log would depend on which
  // screen was used — the defect WP16 PR 1 fixed for the geography warning.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const nested = await (await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: {
      legalName: `E2E Test Co Audit Shape ${Date.now()}`,
      geographyCode: 'TR',
      locations: [{ name: 'E2E Shape Nested', geographyCode: 'TR' }],
    },
  })).json();

  const separate = await (await request.post(`${API_BASE}/locations`, {
    headers: bearer(token),
    data: { subsidiaryId: nested.id, name: 'E2E Shape Separate', geographyCode: 'TR' },
  })).json();

  const rowFor = async (id: string) => {
    const page = await (await request.get(
      `${API_BASE}/audit?entity=location&action=create&entityId=${id}`,
      { headers: bearer(token) },
    )).json();
    // Exactly one. Reading `items[0]` alone let a writer that audited TWICE
    // pass both this and the whole E2E suite.
    expect(page.total, 'one create row per location, never two').toBe(1);
    return page.items[0];
  };
  const a = await rowFor((await (await request.get(
    `${API_BASE}/locations?subsidiaryId=${nested.id}`, { headers: bearer(token) },
  )).json()).find((l: { name: string }) => l.name === 'E2E Shape Nested').id);
  const b = await rowFor(separate.id);

  expect(a.action).toBe(b.action);
  expect(a.entity).toBe(b.entity);
  expect(a.userId).toBe(b.userId);
  expect(a.role).toBe(b.role);
  // Same diff SHAPE — the keys, not the values.
  expect(Object.keys(a.diff).sort()).toEqual(Object.keys(b.diff).sort());
  expect(Object.keys(a.diff.after).sort()).toEqual(Object.keys(b.diff.after).sort());
  // The VALUES too, which is the half the name implies. Everything except the
  // fields that must differ between two distinct rows.
  const comparable = (d: Record<string, unknown>) => {
    const { id, name, createdAt, updatedAt, ...rest } = d;
    void id; void name; void createdAt; void updatedAt;
    return rest;
  };
  expect(comparable(a.diff.after)).toEqual(comparable(b.diff.after));
});

test('both create paths normalise a location identically', async ({ request }) => {
  // The docblock on the shared writer claims the two paths produce identical
  // rows. It was false: the nested DTO trimmed and nulled blanks, the
  // standalone one stored "   " and " Holbeck " verbatim — three spellings of
  // "no address" in one column, the exact defect `blankToNull` was written to
  // prevent. Asserted here so the claim cannot quietly stop being true.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const sub = await (await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: {
      legalName: `E2E Test Co Normalise ${Date.now()}`,
      geographyCode: 'TR',
      locations: [{ name: '  E2E Norm Nested  ', geographyCode: 'TR', address: '   ' }],
    },
  })).json();

  await request.post(`${API_BASE}/locations`, {
    headers: bearer(token),
    data: {
      subsidiaryId: sub.id,
      name: '  E2E Norm Separate  ',
      geographyCode: 'TR',
      address: '   ',
    },
  });

  const rows = await (await request.get(
    `${API_BASE}/locations?subsidiaryId=${sub.id}`, { headers: bearer(token) },
  )).json();
  expect(rows).toHaveLength(2);
  for (const row of rows as { name: string; address: string | null }[]) {
    expect(row.address, 'a blank address is null on BOTH paths').toBeNull();
    expect(row.name, 'the name is trimmed on BOTH paths').toMatch(/^E2E Norm/);
    expect(row.name.endsWith(' ')).toBe(false);
  }
});

test('one invalid location fails the whole create', async ({ request }) => {
  // Atomic on purpose: a subsidiary whose location set is partial has a
  // completeness denominator that is quietly wrong rather than obviously
  // missing.
  //
  // Two failures, at two different layers, because they prove different things.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const name = `E2E Test Co Atomic ${Date.now()}`;
  const res = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: {
      legalName: name,
      geographyCode: 'TR',
      locations: [
        { name: 'E2E Atomic Good', geographyCode: 'TR' },
        { name: 'E2E Atomic Bad', geographyCode: 'XX' },
      ],
    },
  });
  expect(res.status(), 'an invalid nested location must fail the whole create').toBe(400);

  const all = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
  expect(
    all.find((s: { legalName: string }) => s.legalName === name),
    'the subsidiary must not exist at all',
  ).toBeUndefined();

  // …and a REAL rollback. A NUL byte passes `@IsString`/`@MinLength(1)` and
  // dies at Postgres (22021, invalid byte sequence for UTF8), so the failure
  // lands mid-transaction rather than at the validation layer — which is the
  // only way to measure that the subsidiary insert is undone rather than
  // merely never attempted. I had written that this input could not be
  // constructed; it can.
  const rollbackName = `E2E Test Co Rollback ${Date.now()}`;
  const midFlight = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: {
      legalName: rollbackName,
      geographyCode: 'TR',
      locations: [
        { name: 'E2E Rollback Good', geographyCode: 'TR' },
        { name: 'E2E Rollback Bad\u0000', geographyCode: 'TR' },
      ],
    },
  });
  expect(midFlight.status()).toBe(500);

  const after = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
  expect(
    after.find((s: { legalName: string }) => s.legalName === rollbackName),
    'the subsidiary insert must be rolled back, not just skipped',
  ).toBeUndefined();
});

test('the create form asks for a location, and the API does not', async ({ page, request }) => {
  // Two different rules on purpose. Requiring it in the contract would break
  // every existing caller; requiring it in the form is what stops a subsidiary
  // starting life with undefined reporting borders.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const apiOnly = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: `E2E Test Co No Locations ${Date.now()}`, geographyCode: 'TR' },
  });
  expect(apiOnly.status(), 'the API stays permissive').toBe(201);

  await login(page, ADMIN_EMAIL);
  await page.goto('/subsidiaries');
  await page.getByRole('button', { name: 'Add Subsidiary' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').first().fill(`E2E Test Co Form Rule ${Date.now()}`);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Add at least one operational location')).toBeVisible();
  // …and nothing was written.
  const after = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
  expect(after.filter((s: { legalName: string }) => s.legalName.startsWith('E2E Test Co Form Rule'))).toHaveLength(0);
});

test('too many locations is a 400 naming the limit, and too large a body is a 413', async ({ request }) => {
  // Both are about the transaction, not the product. Each location is two
  // sequential statements inside ONE interactive transaction, so an unbounded
  // array becomes thousands of round trips: measured locally 2000 locations
  // took ~1s, but at a managed database's RTT the same payload runs 20-60s and
  // blows Prisma's 5s default, holding a pooled connection every attempt.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ name: `E2E Bulk ${i}`, geographyCode: 'TR' }));

  const overCap = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: `E2E Test Co Cap ${Date.now()}`, geographyCode: 'TR', locations: many(51) },
  });
  expect(overCap.status()).toBe(400);
  expect(JSON.stringify(await overCap.json())).toMatch(/locations/);

  const atCap = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: { legalName: `E2E Test Co At Cap ${Date.now()}`, geographyCode: 'TR', locations: many(50) },
  });
  expect(atCap.status(), 'the cap itself must be usable').toBe(201);

  // An oversized body used to surface as a 500 — logged at error and shipped to
  // Sentry as a defect — because body-parser throws before any Nest middleware
  // runs. It is a client sending too much, and this endpoint is the first where
  // a large body is a plausible legitimate request.
  const huge = await request.post(`${API_BASE}/subsidiaries`, {
    headers: bearer(token),
    data: {
      legalName: `E2E Test Co Huge ${Date.now()}`,
      geographyCode: 'TR',
      locations: Array.from({ length: 400 }, (_, i) => ({
        name: `E2E Huge ${i} ${'x'.repeat(400)}`,
        geographyCode: 'TR',
      })),
    },
  });
  expect(huge.status(), 'a client sending too much is not a server defect').toBe(413);
});

test('a draft location can be removed before the subsidiary exists', async ({ page }) => {
  await login(page, ADMIN_EMAIL);
  await page.goto('/subsidiaries');
  await page.getByRole('button', { name: 'Add Subsidiary' }).click();
  const dialog = page.getByRole('dialog');

  await dialog.getByLabel('Location name').fill('E2E Draft One');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await dialog.getByLabel('Location name').fill('E2E Draft Two');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByText('E2E Draft One')).toBeVisible();

  // Removing a draft is a plain list edit — no confirmation, because nothing
  // exists yet to protect. That is why this is not `<LocationsPanel>`.
  await dialog.getByRole('button', { name: 'Remove E2E Draft One' }).click();
  await expect(dialog.getByText('E2E Draft One')).toHaveCount(0);
  await expect(dialog.getByText('E2E Draft Two')).toBeVisible();

  // A duplicate name is refused rather than silently creating two identical
  // sites, which would double WP17's completeness denominator.
  await dialog.getByLabel('Location name').fill('E2E Draft Two');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(/is already in the list/)).toBeVisible();

  // Removing the last one composes with the "at least one" rule — neither test
  // covered the two together, so a removed draft silently surviving into the
  // POST body, or the guard reading a stale count, had nowhere to fail.
  await dialog.getByRole('button', { name: 'Remove E2E Draft Two' }).click();
  await dialog.getByRole('textbox').first().fill(`E2E Test Co Emptied ${Date.now()}`);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Add at least one operational location')).toBeVisible();

  // The dialog resets on reopen. The reset lives in `openAdd`, a different
  // function from the close, so nothing guaranteed they stayed in step.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Add Subsidiary' }).click();
  await expect(page.getByRole('dialog').getByText('E2E Draft Two')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('textbox').first()).toHaveValue('');
});
