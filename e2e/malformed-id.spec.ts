import { test, expect } from '@playwright/test';
import { bearer, getAccessToken, ADMIN_EMAIL, API_BASE } from './helpers';

/**
 * A malformed id used to reach `findUnique`, where Prisma raised P2023 and Nest
 * rendered it as `500 Internal Server Error`. Robustness, not isolation — the
 * status was the same regardless of scope, and the role gate fires first for
 * non-admin callers — but it matters more since WP16, because the subsidiary
 * delete now returns a 409 that actively points users at these endpoints.
 */

const BAD = 'not-a-uuid';

const ROUTES: { method: 'get' | 'delete'; path: string }[] = [
  { method: 'get', path: `/subsidiaries/${BAD}` },
  { method: 'delete', path: `/subsidiaries/${BAD}` },
  { method: 'get', path: `/locations/${BAD}` },
  { method: 'delete', path: `/locations/${BAD}` },
  { method: 'delete', path: `/targets/${BAD}` },
  { method: 'delete', path: `/denominators/${BAD}` },
  { method: 'delete', path: `/period-locks/${BAD}` },
  { method: 'get', path: `/activity-records/${BAD}` },
  { method: 'delete', path: `/activity-records/${BAD}` },
  { method: 'get', path: `/activity-records/${BAD}/evidence` },
  { method: 'get', path: `/evidence/${BAD}/url` },
  { method: 'delete', path: `/evidence/${BAD}` },
];

test('a malformed id is a 400 everywhere, never a 500', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const results: string[] = [];
  for (const { method, path } of ROUTES) {
    const res = await request[method](`${API_BASE}${path}`, { headers: bearer(token) });
    results.push(`${method.toUpperCase()} ${path} -> ${res.status()}`);
  }
  // Reported together rather than one assertion per route: a failure should
  // name every route that is still wrong, not just the first.
  expect(results.filter((r) => !r.endsWith('-> 400'))).toEqual([]);
});

test('the seeded ids still resolve — the pipe must not be stricter than Postgres', async ({ request }) => {
  // The trap this whole change nearly walked into. Nest's ParseUUIDPipe checks
  // the RFC 4122 variant nibble for every version, and the seed's fixed ids
  // (`2222…`) fail it, so the obvious implementation would have 400'd the first
  // subsidiary every user opens. Postgres itself checks no such thing.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const subs = await (await request.get(`${API_BASE}/subsidiaries`, { headers: bearer(token) })).json();
  expect(subs.length).toBeGreaterThan(0);

  const seeded = subs.find((s: { id: string }) => s.id.startsWith('22222222-'));
  expect(seeded, 'the seed should own the 2222… subsidiary ids').toBeTruthy();

  const res = await request.get(`${API_BASE}/subsidiaries/${seeded.id}`, { headers: bearer(token) });
  expect(res.status(), `GET /subsidiaries/${seeded.id} must still resolve`).toBe(200);

  const locs = await (await request.get(`${API_BASE}/locations`, { headers: bearer(token) })).json();
  const seededLoc = locs.find((l: { id: string }) => l.id.startsWith('33333333-'));
  expect(seededLoc, 'the seed should own the 3333… location ids').toBeTruthy();
  expect(
    (await request.get(`${API_BASE}/locations/${seededLoc.id}`, { headers: bearer(token) })).status(),
  ).toBe(200);
});
