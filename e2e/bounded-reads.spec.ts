import { test, expect, type APIRequestContext } from '@playwright/test';
import { ADMIN_EMAIL, API_BASE, SUB, bearer, getAccessToken, listAllPages, login } from './helpers';

/**
 * LP4-05 PR C — bounded reads, through the real API and screens: every list a
 * screen reads is a `CursorPage`, its cursor continues the same request and
 * nothing else, and a count is the whole filtered set's, never one page's.
 * Asserted on shapes and on the seed's subsidiaries, so rows other specs leave
 * behind change no outcome here.
 */

interface Page<T> {
  items: T[];
  limit: number;
  nextCursor: string | null;
}

async function page<T>(request: APIRequestContext, token: string, path: string): Promise<{ status: number; body: Page<T> }> {
  const res = await request.get(`${API_BASE}${path}`, { headers: bearer(token) });
  return { status: res.status(), body: (await res.json()) as Page<T> };
}

test.describe('every bounded list answers one page shape, and its cursor walks it', () => {
  const routes = [
    `/activity-records?subsidiaryId=${SUB.energy}`,
    '/activity-records?sort=review_queue&status=submitted,under_review',
    '/period-locks',
    '/targets',
    '/denominators',
    '/users',
  ];
  for (const route of routes) {
    test(`GET ${route}`, async ({ request }) => {
      const token = await getAccessToken(request, ADMIN_EMAIL);
      const sep = route.includes('?') ? '&' : '?';
      const first = await page<{ id: string }>(request, token, `${route}${sep}limit=1`);
      expect(first.status).toBe(200);
      expect(first.body.limit).toBe(1);
      expect(first.body.items.length).toBeLessThanOrEqual(1);
      // A walk one row at a time visits each row once — the same rows a walk
      // a hundred at a time does.
      const ids: string[] = [...first.body.items.map((r) => r.id)];
      let cursor = first.body.nextCursor;
      while (cursor !== null && ids.length < 60) {
        const next = await page<{ id: string }>(request, token, `${route}${sep}limit=1&cursor=${encodeURIComponent(cursor)}`);
        expect(next.status).toBe(200);
        ids.push(...next.body.items.map((r) => r.id));
        cursor = next.body.nextCursor;
      }
      expect(new Set(ids).size, 'no row twice').toBe(ids.length);
      if (cursor === null) {
        const all = await listAllPages<{ id: string }>(request, token, route);
        expect(ids).toEqual(all.map((r) => r.id));
      }
    });
  }
});

test('refusals: a limit past the bound, a malformed cursor and a cursor of another filter', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  for (const path of ['/activity-records?limit=101', '/activity-records?limit=0', '/activity-records?cursor=not-a-cursor']) {
    const res = await request.get(`${API_BASE}${path}`, { headers: bearer(token) });
    expect(res.status(), path).toBe(400);
    expect((await res.json()).code, path).toBe('validation_failed');
  }
  const first = await page(request, token, '/activity-records?limit=1');
  test.skip(first.body.nextCursor === null, 'needs at least two records');
  const moved = await request.get(
    `${API_BASE}/activity-records?limit=1&subsidiaryId=${SUB.gas}&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    { headers: bearer(token) },
  );
  expect(moved.status()).toBe(400);
});

test('target progress answers the ids it was given, in their order, and never every target', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const missing = await request.get(`${API_BASE}/targets/progress`, { headers: bearer(token) });
  expect(missing.status(), 'no ids is refused, not every target').toBe(400);
  const targets = (await page<{ id: string }>(request, token, '/targets?limit=2')).body.items;
  test.skip(targets.length < 2, 'the seed has two targets');
  const ids = [targets[1].id, targets[0].id];
  const res = await request.get(`${API_BASE}/targets/progress?targetIds=${ids.join(',')}`, { headers: bearer(token) });
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { targetId: string }[]).map((p) => p.targetId)).toEqual(ids);
});

test('the review queue counts the whole queue, not the rows on screen', async ({ page: browser, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const meta = await (await request.get(`${API_BASE}/activity-records/metadata?status=submitted,under_review`, { headers: bearer(token) })).json();
  await login(browser, ADMIN_EMAIL);
  await browser.goto('/review');
  await expect(browser.getByTestId('review-queue-total')).toHaveText(`${meta.total} awaiting review`);
  if (meta.total === 0) {
    await expect(browser.getByText('Nothing is waiting for review.')).toBeVisible();
    return;
  }
  // The rows shown are at most one page, and say how many of the whole they are.
  await expect(browser.getByTestId('review-queue-shown')).toHaveText(
    `Showing ${Math.min(50, meta.total)} of ${meta.total} — the longest wait first`,
  );
  expect(await browser.locator('table tbody tr').count()).toBeLessThanOrEqual(Math.min(50, meta.total));
});

test('Previous submissions says which records a selection covers', async ({ page: browser, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const meta = await (await request.get(`${API_BASE}/activity-records/metadata?subsidiaryId=${SUB.energy}`, { headers: bearer(token) })).json();
  test.skip(meta.total === 0, 'needs a record for TonyAI Energy');
  await login(browser, ADMIN_EMAIL);
  await browser.goto(`/data-entry?subsidiaryId=${SUB.energy}`);
  await expect(browser.getByTestId('previous-submissions-shown')).toHaveText(
    `Showing ${Math.min(50, meta.total)} of ${meta.total}. Selections apply to the records loaded here.`,
  );
});

test('Emissions History shows one page of the whole ledger, and Load more appends the next', async ({ page: browser, request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const { total } = (await (await request.get(`${API_BASE}/activity-records/metadata?year=2026`, { headers: bearer(token) })).json()) as { total: number };
  // The seed alone holds 96 records for 2026, so the first page cannot be the whole ledger.
  expect(total).toBeGreaterThan(50);
  await login(browser, ADMIN_EMAIL);
  await browser.goto('/emissions?year=2026');
  await browser.getByRole('tab', { name: 'History' }).click();
  const shown = browser.getByTestId('history-shown');
  const rows = browser.locator('table tbody tr');
  // Anchored: the count is the metadata's, never the rows on screen.
  await expect(shown).toHaveText(`Showing 50 of ${total} records, newest first`);
  await expect(rows).toHaveCount(50);
  await browser.getByTestId('history-load-more').click();
  const next = Math.min(100, total);
  await expect(shown).toHaveText(`Showing ${next} of ${total} records, newest first`);
  await expect(rows).toHaveCount(next);
});
