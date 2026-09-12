import { test, expect } from '@playwright/test';
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
  SUB,
} from './helpers';

/**
 * The security half, in its own file so its teardown is simple and its request
 * budget is its own.
 *
 * `OUT_OF_SCOPE_SUB` is `SUB.mfg` — the same ORGANISATION, outside `entry@`'s
 * access set. So what these tests prove is access-set isolation, not cross-org
 * isolation, and the names say so.
 */
test.describe.configure({ mode: 'serial' });

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
  expect(message).toMatch(/Nothing was imported\./);
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
