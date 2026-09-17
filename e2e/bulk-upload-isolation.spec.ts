import { test, expect } from '@playwright/test';
import type { BulkUploadReportDTO } from '@tonyai/shared-types';
import { randomUUID } from 'node:crypto';
import {
  ADMIN_EMAIL,
  API_BASE,
  bearer,
  buildBulkCsv,
  deleteRecordsAsService,
  E2E_BULK_CATEGORY,
  E2E_BULK_UNIT,
  E2E_PERIOD,
  E2E_YEAR,
  ENTRY_EMAIL,
  getAccessToken,
  OUT_OF_SCOPE_SUB,
  postBulkImport,
  serviceReadRecords,
  waitOutImportThrottle,
  SUB,
  readAuditSince,
} from './helpers';

/**
 * The security half, in its own file so its teardown is simple and its request
 * budget is its own.
 *
 * `OUT_OF_SCOPE_SUB` is `SUB.mfg` — the same ORGANISATION, outside `entry@`'s
 * access set. So what these tests prove is access-set isolation, not cross-org
 * isolation, and the names say so.
 *
 * The entity gate has two directions and both are here: a file naming an entity
 * you cannot reach is refused whole, and one naming an entity you CAN reach, in
 * a spelling the app itself never writes, is not. Only the second writes, in a
 * lane of its own (`SUB.gas` · `Waste`) that it sweeps in its own `finally`.
 */
test.describe.configure({ mode: 'serial' });
/**
 * The import route allows five requests per minute per user, and the bulk group
 * makes far more than two users can spend in one window — so each of these
 * files opens with a fresh one. Counted rather than hoped for: a 429 inside a
 * test that was asserting something else is a failure that blames the wrong
 * code.
 */
test.beforeAll(async () => {
  // The hook's own timeout defaults to the test timeout, which is 60s — one
  // second less than the wait it has to make.
  test.setTimeout(90_000);
  await waitOutImportThrottle();
});


async function createDraftOn(
  request: Parameters<typeof serviceReadRecords>[0],
  token: string,
  subsidiaryId: string,
  periodValue: string,
): Promise<string> {
  const res = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: {
      subsidiaryId,
      reportingYear: E2E_YEAR,
      reportingPeriod: E2E_PERIOD,
      periodValue,
      category: E2E_BULK_CATEGORY,
      activityValue: 9,
      activityUnit: E2E_BULK_UNIT,
    },
  });
  if (!res.ok()) throw new Error(`createDraftOn failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).id as string;
}

test('a record outside your access set is refused, and the ROW does not move', async ({
  request,
}) => {
  // The response alone cannot prove this. A write that succeeded and then
  // reported `not_found` would look identical from the outside — which is why
  // `updated_at` is compared, not just `status`.
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  let foreignId = '';

  try {
    foreignId = await createDraftOn(request, adminToken, OUT_OF_SCOPE_SUB, 'Q4');
    const [before] = await serviceReadRecords(request, `id=eq.${foreignId}`);

    const res = await request.post(`${API_BASE}/activity-records/bulk-submit`, {
      headers: bearer(entryToken),
      data: { recordIds: [foreignId] },
    });

    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.submitted).toHaveLength(0);
    expect(body.failed).toEqual([
      {
        recordId: foreignId,
        code: 'not_found',
        message: 'This record does not exist, or it is not yours.',
      },
    ]);

    const [after] = await serviceReadRecords(request, `id=eq.${foreignId}`);
    expect(after.status).toBe('draft');
    expect(after.submitted_at).toBeNull();
    expect(after.updated_at).toBe(before.updated_at);
  } finally {
    await deleteRecordsAsService(request, [foreignId].filter(Boolean));
  }
});

test('an unreachable id is indistinguishable from one that does not exist', async ({
  request,
}) => {
  // Otherwise the endpoint is an existence oracle for another tenant's ids.
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  let foreignId = '';

  try {
    foreignId = await createDraftOn(request, adminToken, OUT_OF_SCOPE_SUB, 'Q3');
    const absentId = randomUUID();

    const res = await request.post(`${API_BASE}/activity-records/bulk-submit`, {
      headers: bearer(entryToken),
      data: { recordIds: [foreignId, absentId] },
    });

    const { failed } = await res.json();
    // Without this the test can pass having proved nothing: `{ ...undefined }`
    // is `{}`, so an empty `failed` array compares equal to itself.
    expect(failed).toHaveLength(2);
    const [foreign, absent] = failed;
    // Byte-identical apart from the id itself.
    expect({ ...foreign, recordId: '' }).toEqual({ ...absent, recordId: '' });
  } finally {
    await deleteRecordsAsService(request, [foreignId].filter(Boolean));
  }
});

test('a file naming an entity you cannot reach is refused WHOLE', async ({ request }) => {
  // Not row by row: a foreign id means the wrong file, and importing the rows
  // that happen to match would be a worse outcome than refusing all of them.
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const before = (
    await serviceReadRecords(request, `subsidiary_id=eq.${OUT_OF_SCOPE_SUB}&reporting_period=eq.${E2E_PERIOD}`)
  ).length;

  const since = new Date().toISOString();
  const res = await postBulkImport(request, entryToken, {
    buffer: buildBulkCsv([
      { subsidiaryId: SUB.energy, periodValue: 'Q3', activityValue: 5 },
      { subsidiaryId: OUT_OF_SCOPE_SUB, periodValue: 'Q3', activityValue: 5 },
    ]),
    dryRun: 'false',
  });

  expect(res.status()).toBe(400);
  const { message } = await res.json();
  expect(message).toMatch(/Row\(s\) 3\b/);
  // And it is one of the two refusals the trail keeps — a file naming an
  // entity outside the caller's tenant says something about the caller — under
  // the batch verb, with the same oracle-free sentence as its reason.
  const audit = await readAuditSince(request, {
    entity: 'activity_record',
    action: 'bulk_import',
    since,
  });
  expect(
    audit.filter((r) => r.diff?.refused === true && /Row\(s\) 3\b/.test(String(r.diff?.reason))),
  ).toHaveLength(1);
  // The consequence is the panel's to state: it prints "Nothing was imported."
  // under every whole-file refusal, and the server repeating it showed it twice.
  expect(message).not.toMatch(/Nothing was imported/);
  // Including the row that WAS reachable.
  expect(
    await serviceReadRecords(
      request,
      `subsidiary_id=eq.${SUB.energy}&reporting_period=eq.${E2E_PERIOD}&period_value=eq.Q3&category=eq.${E2E_BULK_CATEGORY}`,
    ),
  ).toHaveLength(0);
  expect(
    await serviceReadRecords(request, `subsidiary_id=eq.${OUT_OF_SCOPE_SUB}&reporting_period=eq.${E2E_PERIOD}`),
  ).toHaveLength(before);
});

/**
 * The other direction of the same gate: an id that IS yours, spelled a way the
 * app never spells it.
 *
 * `canonicalUuid` folds the spellings of one uuid onto the one Postgres stores,
 * and the importer rewrites both id cells with it BEFORE the access check —
 * which compares ids as STRINGS. Its accepted grammar is a table transcribed by
 * hand, measured once against Prisma 6.19 / Postgres 17, and the unit suite
 * cannot reach past it: those specs pin the function against the table, never
 * the table against a database.
 *
 * `urn:uuid:` is the spelling worth an import. Postgres itself refuses it
 * (`invalid input syntax for type uuid`, re-measured against the running
 * Postgres 17), so nothing that passes here can be explained by the database's
 * more liberal reader — and before the fold existed, a file naming its
 * reporting entity that way was refused WHOLE as another tenant's, by the test
 * above. The braced row rides along in the same file, so the second spelling
 * costs no second import.
 *
 * What it can and cannot see, stated rather than implied. It fails if the fold
 * is removed, moved after the access check, applied to the report alone, or
 * ever folds onto a DIFFERENT id — the last being the expensive one, because
 * the row then lands against an entity nobody named. It does NOT detect Prisma
 * changing its own grammar: the cell is canonical by the time Prisma sees it,
 * which is the whole point of the fold, and this repo deliberately offers no
 * path that hands Prisma a raw spelling.
 *
 * Not asserted, deliberately: hex CASE. Every seeded id is decimal digits, so
 * `toUpperCase()` is a no-op on them and the assertion would be vacuous here.
 * `canonical-uuid.spec.ts` owns that one.
 *
 * Lane: `SUB.gas` / quarterly `E2E_YEAR` / Q3 and Q4, category `Waste` — a
 * subsidiary no bulk spec writes and a category no spec pairs with it. It is
 * outside `entry@`'s access set, so the import is admin@'s, whose set is the
 * organisation's five ids — real strings, compared the same way.
 *
 * Budget: one import, and the first this file spends as admin@. The throttle
 * test below is the one that deliberately empties that bucket, so this stays
 * above it; it loops up to eight times to find its 429 and still does.
 */
test('an id spelled the way only Prisma resolves is still YOURS, and the row lands under the canonical id', async ({
  request,
}) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  // Scoped by YEAR as well as by tuple: these ids are handed to a service-role
  // delete, which goes past the period locks, the status gates and RLS alike.
  const lane =
    `subsidiary_id=eq.${SUB.gas}&reporting_year=eq.${E2E_YEAR}` +
    `&reporting_period=eq.${E2E_PERIOD}&period_value=in.(Q3,Q4)` +
    `&category=eq.${E2E_BULK_CATEGORY}`;

  try {
    const res = await postBulkImport(request, token, {
      buffer: buildBulkCsv([
        { subsidiaryId: `urn:uuid:${SUB.gas}`, periodValue: 'Q3', activityValue: 12 },
        { subsidiaryId: `{${SUB.gas}}`, periodValue: 'Q4', activityValue: 14 },
      ]),
      dryRun: 'false',
    });

    // The body as TEXT first, and the refusal quoted in the failure message. A
    // whole-file refusal is a 400 carrying no `accepted`, and reaching into one
    // fails as `TypeError: … reading 'map'` — the refusal blaming the wrong
    // code, which is the confusion this whole group is written to avoid.
    const raw = await res.text();
    expect(res.ok(), `the import was refused: ${raw}`).toBe(true);
    const report = JSON.parse(raw) as BulkUploadReportDTO;
    expect(report.errors).toEqual([]);

    // The report's own echo: the canonical spelling, not the file's. It is what
    // a preview shows the user and what the panel keys its rows on, so a fold
    // that reached the database but not the report would still mislead.
    expect(report.accepted.map((a) => [a.periodValue, a.subsidiaryId])).toEqual([
      ['Q3', SUB.gas],
      ['Q4', SUB.gas],
    ]);

    // …and what the DATABASE holds, asked for BY the canonical id and read past
    // the API with the service role. Both rows, and exactly the two the report
    // named: a lane that matched nothing, or rows filed against some other
    // entity, fails here instead of agreeing with the report that produced it.
    const stored = await serviceReadRecords(request, lane);
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((r) => String(r.id)))).toEqual(
      new Set(report.accepted.map((a) => a.recordId)),
    );
  } finally {
    // The LANE, not the report's ids: if an assertion above threw, the rows are
    // still written and still have to go, whatever the report said about them.
    const strays = await serviceReadRecords(request, lane);
    await deleteRecordsAsService(
      request,
      strays.map((r) => String(r.id)),
    );
  }
});

test('the bulk-submit body is validated by its DTO', async ({ request }) => {
  // Dropping `@Body()` or retyping the parameter survives every unit test —
  // direct invocation ignores decorators, and vitest/esbuild emits no
  // `design:paramtypes`, so a Nest testing module cannot resolve the
  // controller either. Without the binding the cap and the UUID shape are both
  // unenforced: a caller posts thousands of ids, or non-UUIDs that reach
  // Prisma as P2023 and surface as a 500.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const post = (data: unknown) =>
    request.post(`${API_BASE}/activity-records/bulk-submit`, {
      headers: bearer(token),
      data: data as Record<string, unknown>,
    });

  // 2,500 UUIDs is ~97 KB, just under Express's unconfigured 100 KB JSON
  // default — deliberately, so this tests the DTO's cap and not the body
  // parser.
  const over = await post({ recordIds: Array.from({ length: 2500 }, () => randomUUID()) });
  expect(over.status()).toBe(400);

  const malformed = await post({ recordIds: ['not-a-uuid'] });
  expect(malformed.status()).toBe(400);
  expect(JSON.stringify(await malformed.json())).toContain('recordIds must contain record ids');

  // The one reading of `[]` nobody wants is "all".
  expect((await post({ recordIds: [] })).status()).toBe(400);
  expect((await post({})).status()).toBe(400);
  expect((await post({ recordIds: [randomUUID()], force: true })).status()).toBe(400);
});

test('the import throttle fires, and each user has their own budget', async ({ request }) => {
  // Last in the file, because it deliberately exhausts a budget.
  //
  // The bug this exists for: `ThrottlerGuard`'s default tracker is `req.ip`,
  // and this API sets no `trust proxy` — so behind an ingress every caller
  // presents the same address and "five a minute" becomes five a minute for
  // the whole product. It looks correct locally, where the browser connects
  // straight to the process, which is exactly why only this layer can see it.
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  // A refused file costs the same as a real one — the guard runs before the
  // handler — so the budget is spent without writing anything.
  const cheap = { buffer: Buffer.from('x'), fileName: 'x.txt', dryRun: 'true' as const };

  let sawThrottle = false;
  for (let i = 0; i < 8 && !sawThrottle; i += 1) {
    const res = await postBulkImport(request, adminToken, cheap);
    if (res.status() === 429) sawThrottle = true;
  }
  expect(sawThrottle, 'the import route must rate-limit').toBe(true);

  // The whole assertion: a DIFFERENT user, immediately after, must not be
  // caught by the first one's bucket.
  const other = await postBulkImport(request, entryToken, cheap);
  expect(other.status(), 'a second user must have their own budget').not.toBe(429);
});
