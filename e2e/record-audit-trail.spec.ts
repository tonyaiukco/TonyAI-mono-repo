import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_BASE,
  APPROVER_EMAIL,
  AUDITOR_EMAIL,
  E2E_YEAR,
  ENTRY_EMAIL,
  SUB,
  bearer,
  createCommittedRecord,
  deleteRecordsAsService,
  getAccessToken,
  login,
  seenSubmittedAt,
} from './helpers';
import enRecordTrail from '../apps/web/messages/en/recordTrail.json';
import trRecordTrail from '../apps/web/messages/tr/recordTrail.json';
import trRecordStatus from '../apps/web/messages/tr/recordStatus.json';

/**
 * WP5 (`uat4-review-resubmit`): a record's history as a timeline.
 *
 * - The record's approver (the standard user's record in Energy, so the
 *   company's super_admin) opens it from the review sheet of a recalled,
 *   edited and resubmitted record: the edit's value before and after is
 *   there, the sheet behind it holds current values only.
 * - An author, in Turkish, opens it from Data Entry for a record its approver
 *   returned (an auditor asking to return it is refused first): the reason is
 *   there, and the four steps a revised record goes through read in Turkish.
 *
 * Lane: `SUB.energy` / quarterly `E2E_YEAR` / Q2, Q3 and Q4 (Q1 is `data-entry-happy`'s), Electricity, whole
 * company. Each test deletes its record in `finally`; the author's language is
 * put back on a request context of its own.
 */

async function setEntryLanguage(language: 'tr' | 'en') {
  const api = await playwrightRequest.newContext();
  try {
    const token = await getAccessToken(api, ENTRY_EMAIL);
    const res = await api.patch(`${API_BASE}/me/preferences`, { headers: bearer(token), data: { language } });
    if (res.status() !== 200) throw new Error(`language ${language}: ${res.status()}`);
  } finally {
    await api.dispose();
  }
}

test.afterAll(async () => setEntryLanguage('en'));

/** Recall it, change its value and send it again, as its author, through the API. */
async function reviseAsAuthor(request: APIRequestContext, token: string, id: string, activityValue: number) {
  for (const [method, path, data] of [
    ['post', '/recall', undefined],
    ['patch', '', { activityValue }],
    ['post', '/submit', undefined],
  ] as const) {
    const res = await request[method](`${API_BASE}/activity-records/${id}${path}`, {
      headers: bearer(token),
      ...(data ? { data } : {}),
    });
    expect(res.ok(), await res.text()).toBe(true);
  }
}

test('the company\'s super admin reads a revised record\'s history from the review sheet; the sheet keeps current values', async ({ page, request }) => {
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  const id = await createCommittedRecord(request, entry, {
    subsidiaryId: SUB.energy,
    category: 'Electricity',
    periodValue: 'Q2',
    activityValue: 1000,
    varianceReason: 'e2e: WP5 trail lane',
  });
  try {
    await reviseAsAuthor(request, entry, id, 1200);

    await login(page, APPROVER_EMAIL);
    await page.goto('/review');
    await page
      .locator('table tbody tr', { hasText: 'TonyAI Energy' })
      .filter({ hasText: `Q2 ${E2E_YEAR}` })
      .filter({ hasText: 'Electricity' })
      .click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('1,200');
    await expect(sheet).not.toContainText('1,000 kWh');

    await page.getByTestId('review-sheet-history').click();
    const trail = page.getByTestId('record-trail');
    await expect(trail.getByTestId('record-trail-event').first()).toBeVisible();
    const kinds = await trail.getByTestId('record-trail-event').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    expect(kinds).toEqual(['created', 'submitted', 'recalled', 'edited', 'resubmitted', 'review_started']);
    const edit = trail.locator('[data-testid="record-trail-event"][data-kind="edited"]');
    await expect(edit).toContainText(enRecordTrail.kinds.edited);
    const value = edit.locator('[data-testid="record-trail-change"][data-field="activityValue"]');
    await expect(value).toContainText(enRecordTrail.fields.activityValue);
    await expect(value).toContainText('1,000');
    await expect(value).toContainText('1,200');
    await expect(trail.locator('[data-kind="resubmitted"]')).toContainText('Submission 2');
    await page.screenshot({ path: test.info().outputPath('trail-en.png'), fullPage: true });
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('an author reads, in Turkish, the history of a record a reviewer returned, reason included', async ({ page, request }) => {
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  const auditor = await getAccessToken(request, AUDITOR_EMAIL);
  const approver = await getAccessToken(request, APPROVER_EMAIL);
  const id = await createCommittedRecord(request, entry, {
    subsidiaryId: SUB.energy,
    category: 'Electricity',
    periodValue: 'Q3',
    activityValue: 4000,
    varianceReason: 'e2e: WP5 trail lane',
  });
  try {
    await reviseAsAuthor(request, entry, id, 4321);
    // An auditor reads the record but returns nothing (INC-2.6 §1): refused on
    // the role, and the record is still waiting.
    const byAuditor = await request.post(`${API_BASE}/activity-records/${id}/reject`, {
      headers: bearer(auditor),
      data: { varianceReason: 'An auditor may not return it', seenSubmittedAt: await seenSubmittedAt(request, auditor, id) },
    });
    expect(byAuditor.status()).toBe(403);
    expect((await (await request.get(`${API_BASE}/activity-records/${id}`, { headers: bearer(entry) })).json()).status).toBe('submitted');
    const returned = await request.post(`${API_BASE}/activity-records/${id}/reject`, {
      headers: bearer(approver),
      data: { varianceReason: 'The March invoice is missing', seenSubmittedAt: await seenSubmittedAt(request, approver, id) },
    });
    expect(returned.status(), await returned.text()).toBe(200);
    expect((await returned.json()).status).toBe('rejected');

    await setEntryLanguage('tr');
    await login(page, ENTRY_EMAIL);
    // By the URL: the field label is Turkish here.
    await page.goto(`/data-entry?subsidiaryId=${SUB.energy}`);
    const row = page.locator('[data-testid="previous-submissions"] tr', { hasText: '4.321' });
    // Returned, in Turkish, and offered for edit like a draft.
    await expect(row).toContainText(trRecordStatus.label.rejected);
    await expect(row.getByRole('button', { name: /kaydını düzenle$/ })).toBeVisible();

    await row.getByTestId('record-history-open').click();
    const trail = page.getByTestId('record-trail');
    const back = trail.locator('[data-testid="record-trail-event"][data-kind="returned"]');
    await expect(back).toContainText(trRecordTrail.kinds.returned);
    await expect(back.getByTestId('record-trail-reason')).toContainText('The March invoice is missing');
    for (const kind of ['recalled', 'edited', 'resubmitted'] as const) {
      await expect(trail.locator(`[data-kind="${kind}"]`)).toContainText(trRecordTrail.kinds[kind]);
    }
    // A Turkish number: 4,000 → 4,321 reads "4.000" and "4.321".
    const value = trail.locator('[data-kind="edited"] [data-field="activityValue"]');
    await expect(value).toContainText('4.000');
    await expect(value).toContainText('4.321');
    // Each of the four steps has a colour of its own, as rendered.
    const colours = await trail.getByTestId('record-trail-event').evaluateAll((els) =>
      Object.fromEntries(
        els.map((e) => [e.getAttribute('data-kind'), getComputedStyle(e.querySelector('span[aria-hidden="true"]')!).backgroundColor]),
      ),
    );
    const four = ['recalled', 'returned', 'edited', 'resubmitted'].map((k) => colours[k]);
    expect(four.every(Boolean)).toBe(true);
    expect(new Set(four).size).toBe(4);
    // The dialog fits the window: nothing of it is drawn off screen.
    const box = await trail.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: test.info().outputPath('trail-tr.png'), fullPage: true });
  } finally {
    // English again in `afterAll`, on a request context of its own.
    await deleteRecordsAsService(request, [id]);
  }
});

test('a standard user is offered no history for a colleague\'s record', async ({ page, request }) => {
  // An auditor cannot author; the colleague is the admin.
  const admin = await getAccessToken(request, ADMIN_EMAIL);
  const id = await createCommittedRecord(request, admin, {
    subsidiaryId: SUB.energy,
    category: 'Electricity',
    periodValue: 'Q2',
    activityValue: 5555,
    varianceReason: 'e2e: WP5 trail lane',
  });
  try {
    // Whatever language the author was left in: by the URL, the figure either way.
    await login(page, ENTRY_EMAIL);
    await page.goto(`/data-entry?subsidiaryId=${SUB.energy}`);
    const row = page.locator('[data-testid="previous-submissions"] tr', { hasText: /5[.,]555/ });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('record-history-open')).toHaveCount(0);
    // ...and the API agrees.
    const entry = await getAccessToken(request, ENTRY_EMAIL);
    const res = await request.get(`${API_BASE}/activity-records/${id}/audit-trail`, { headers: bearer(entry) });
    expect(res.status()).toBe(403);
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('the timeline says when it is loading, empty, refused, failed or cut short', async ({ page, request }) => {
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  const id = await createCommittedRecord(request, entry, {
    subsidiaryId: SUB.energy,
    category: 'Electricity',
    periodValue: 'Q2',
    activityValue: 1500,
    varianceReason: 'e2e: WP5 trail lane',
  });
  try {
    type Answer = { status: number; json: unknown } | 'hold';
    const answers: Answer[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/v1/activity-records/${id}/audit-trail`, async (route) => {
      const next = answers.shift();
      if (next === 'hold') {
        await held;
        return route.fulfill({ json: { recordId: id, events: [], truncated: false } });
      }
      return route.fulfill({ status: next!.status, json: next!.json });
    });
    const CORS_FREE = (status: number, json: unknown): Answer => ({ status, json });
    const event = (n: number) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      at: new Date(Date.UTC(2026, 10, 25, 9, n)).toISOString(),
      kind: 'edited', action: 'update', actor: { name: 'Entry User', role: 'standard_user' },
      submission: null, reason: null, changes: [],
    });

    await login(page, APPROVER_EMAIL);
    await page.goto('/review');
    await page
      .locator('table tbody tr', { hasText: 'TonyAI Energy' })
      .filter({ hasText: `Q2 ${E2E_YEAR}` })
      .filter({ hasText: 'Electricity' })
      .click();
    const trail = page.getByTestId('record-trail');
    const open = async (answer: Answer) => {
      answers.push(answer);
      await page.getByTestId('review-sheet-history').click();
      await expect(trail).toBeVisible();
    };
    const close = async () => {
      await page.keyboard.press('Escape');
      await expect(trail).toHaveCount(0);
    };

    await open('hold');
    await expect(trail.getByTestId('record-trail-loading')).toBeVisible();
    release();
    await expect(trail.getByTestId('record-trail-empty')).toHaveText(enRecordTrail.empty);
    await close();

    await open(CORS_FREE(403, { statusCode: 403, message: 'Forbidden' }));
    await expect(trail.getByTestId('record-trail-refused')).toHaveText(enRecordTrail.refused);
    await expect(trail.getByTestId('record-trail-event')).toHaveCount(0);
    await close();

    await open(CORS_FREE(500, { statusCode: 500, code: 'internal_error', message: 'Simulated outage' }));
    await expect(trail.getByTestId('record-trail-error')).toContainText(enRecordTrail.error);
    // Retry reads again.
    answers.push(CORS_FREE(200, { recordId: id, events: [event(1), event(2)], truncated: true }));
    await trail.getByRole('button', { name: enRecordTrail.retry }).click();
    await expect(trail.getByTestId('record-trail-truncated')).toHaveText(enRecordTrail.truncated.replace('{count}', '2'));
    await expect(trail.getByTestId('record-trail-event')).toHaveCount(2);
    await close();
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});

test('the audit page opens a record event in its timeline, marked; a deleted draft\'s event shows its stored content', async ({ page, request }) => {
  const entry = await getAccessToken(request, ENTRY_EMAIL);
  const draft = async (periodValue: string, activityValue: number) => {
    const res = await request.post(`${API_BASE}/activity-records`, {
      headers: bearer(entry),
      data: {
        subsidiaryId: SUB.energy, locationId: null, reportingYear: E2E_YEAR, reportingPeriod: 'quarterly',
        periodValue, category: 'Electricity', activityValue, activityUnit: 'kWh', varianceReason: null, input: null,
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).id as string;
  };
  const kept = await draft('Q2', 700);
  try {
    const edited = await request.patch(`${API_BASE}/activity-records/${kept}`, { headers: bearer(entry), data: { activityValue: 750 } });
    expect(edited.ok()).toBe(true);

    await login(page, ADMIN_EMAIL);
    await page.goto('/audit');
    // Newest first: the edit just made.
    await page.locator('table tbody tr').first().click();
    const trail = page.getByTestId('record-trail');
    const marked = trail.locator('[data-testid="record-trail-event"][data-marked="true"]');
    await expect(marked).toHaveAttribute('data-kind', 'edited');
    await expect(marked).toContainText(enRecordTrail.marked);
    await expect(marked.locator('[data-field="activityValue"]')).toContainText('750');
    // The way back to the row's stored entry, which the timeline summarises.
    await trail.getByTestId('record-trail-stored').click();
    await expect(trail).toHaveCount(0);
    await expect(page.getByRole('dialog')).toContainText(kept);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // A draft deleted since: the row's own stored content, as before.
    const gone = await draft('Q4', 900);
    expect((await request.delete(`${API_BASE}/activity-records/${gone}`, { headers: bearer(entry) })).ok()).toBe(true);
    await page.reload();
    await page.locator('table tbody tr').first().click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText(gone);
    await expect(page.getByTestId('record-trail')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // A late 404 from an opening the admin has left never closes what they chose since.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const TRAIL = `**/api/v1/activity-records/${gone}/audit-trail`;
    await page.route(TRAIL, async (route) => {
      await held;
      return route.fallback();
    });
    const answered = page.waitForResponse((r) => r.url().endsWith(`/activity-records/${gone}/audit-trail`));
    await page.locator('table tbody tr').first().click();
    await expect(page.getByTestId('record-trail-loading')).toBeVisible();
    await page.getByTestId('record-trail-stored').click();
    await expect(sheet).toContainText(gone);
    release();
    expect((await answered).status()).toBe(404);
    await page.waitForTimeout(300);
    await expect(sheet).toContainText(gone);
    await page.unroute(TRAIL);
  } finally {
    await deleteRecordsAsService(request, [kept]);
  }
});
