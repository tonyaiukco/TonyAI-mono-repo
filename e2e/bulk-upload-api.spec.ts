import { test, expect } from '@playwright/test';
import type { BulkUploadRowIssue } from '@tonyai/shared-types';
import {
  ADMIN_EMAIL,
  buildBulkCsv,
  deleteRecordsAsService,
  E2E_BULK_CATEGORY,
  E2E_BULK_UNIT,
  E2E_PERIOD,
  E2E_YEAR,
  getAccessToken,
  postBulkImport,
  readAuditSince,
  serviceReadRecords,
  waitOutImportThrottle,
  SUB,
} from './helpers';

/**
 * The wire contract for bulk upload — the properties no unit test can reach.
 *
 * Four PRs built this feature with ~330 unit tests, and three review passes
 * each concluded the same thing: a specific set of claims is structurally
 * unreachable from a mocked suite. This file is those claims. Every assertion
 * here died as a mutation somewhere and survived the unit suite.
 *
 * Lane: `SUB.energy` / quarterly 2026 / Q3. The seed writes monthly only, so no
 * seeded row can collide; the collision risk is other SPECS, and the teardown
 * below is what keeps it one-directional.
 *
 * Budget: the import route allows five requests per minute per user, so this
 * file keeps to four as `admin@`.
 */
const LANE = { subsidiaryId: SUB.energy, periodValue: 'Q3' };

/**
 * Three rows that pass every gate on a freshly seeded database.
 *
 * Three period values rather than three years, and `E2E_YEAR` is load-bearing
 * twice over. The fixture factor is seeded for that year alone, so a row dated
 * a year earlier is refused `no_factor` — asserted deliberately further down,
 * having first arrived here as a failure. And `cleanupQuarterly` sweeps that
 * year alone, so a row outside it would outlive the run that wrote it.
 *
 * Q1 is free: `data-entry-happy` writes Electricity there, and the category is
 * part of the uniqueness key, so that is a different slot.
 */
const rows = (over: Partial<Parameters<typeof buildBulkCsv>[0][number]>[] = []) =>
  buildBulkCsv([
    { ...LANE, activityValue: 12, ...over[0] },
    { ...LANE, periodValue: 'Q4', activityValue: 14, ...over[1] },
    { ...LANE, periodValue: 'Q1', activityValue: 11, ...over[2] },
  ]);

async function laneRows(request: Parameters<typeof serviceReadRecords>[0]) {
  return serviceReadRecords(
    request,
    `subsidiary_id=eq.${SUB.energy}&reporting_period=eq.${E2E_PERIOD}&category=eq.${E2E_BULK_CATEGORY}`,
  );
}

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


test('the multipart field name is `file`, and nothing else is accepted', async ({
  request,
}) => {
  // `FileInterceptor('file', …)` closes the name over inside a class generated
  // at decoration time: reflection cannot read it, and the browser can only
  // ever send `file`. Renaming it passes every unit test and breaks every
  // upload.
  const token = await getAccessToken(request, ADMIN_EMAIL);

  const wrong = await postBulkImport(request, token, {
    buffer: rows(),
    dryRun: 'true',
    fieldName: 'upload',
  });
  expect(wrong.status()).toBe(400);
  // The exact sentence, because a 400 also fires for a missing `dryRun` and
  // mistaking one for the other is how this test would pass while proving
  // nothing. The sentence is multer's, not ours — it refuses the unknown field
  // before the handler runs, which is a stronger refusal than the service's own
  // "No file was uploaded." that this assertion originally expected.
  expect((await wrong.json()).message).toBe('Unexpected field - upload');
});

test('a Turkish filename survives multipart, into the report AND the audit row', async ({
  request,
}) => {
  // multer decodes filename bytes as latin1 unless told otherwise, so the name
  // arrives mangled before any of our code sees it — and this one is echoed in
  // the report and written to an append-only audit row. Deleting
  // `defParamCharset` passes the whole unit suite.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const since = new Date().toISOString();
  const NAME = 'Şubat-İçe-Aktarım-ığüöçĞÜÖÇ.csv';

  const res = await postBulkImport(request, token, {
    buffer: rows(),
    fileName: NAME,
    dryRun: 'true',
  });

  expect(res.ok()).toBe(true);
  // `toBe`, never a regex: mojibake still contains letters.
  expect((await res.json()).fileName).toBe(NAME);

  const audit = await readAuditSince(request, {
    entity: 'activity_record',
    action: 'create',
    since,
  });
  const batch = audit.find((r) => r.entityId === null && r.diff?.bulk === true);
  expect(batch, 'a dry run still writes its batch audit row').toBeTruthy();
  expect(batch!.diff.fileName).toBe(NAME);
});

test('a dry run writes nothing — asserted against the database, not the report', async ({
  request,
}) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const since = new Date().toISOString();
  const before = (await laneRows(request)).length;

  const report = await (
    await postBulkImport(request, token, { buffer: rows(), dryRun: 'true' })
  ).json();

  expect(report.dryRun).toBe(true);
  expect(report.accepted).toHaveLength(3);
  // No ids, by contract — not placeholder ids.
  expect(report.accepted.every((a: { recordId: null }) => a.recordId === null)).toBe(true);

  // The two proofs the report cannot give, and either alone can be faked:
  expect(await laneRows(request)).toHaveLength(before);
  const audit = await readAuditSince(request, {
    entity: 'activity_record',
    action: 'create',
    since,
  });
  expect(
    audit.filter((r) => r.entityId !== null),
    'a dry run must write no PER-RECORD audit rows',
  ).toHaveLength(0);
  expect(audit.filter((r) => r.diff?.dryRun === true)).toHaveLength(1);
});

test('an apply writes one audit row per record, plus one for the batch', async ({
  request,
}) => {
  // CLAUDE.md calls audit-on-every-mutation non-negotiable, and the unit suite
  // structurally cannot see the per-record rows: the bulk service mocks the
  // record service wholesale.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const since = new Date().toISOString();
  let created: string[] = [];

  try {
    const report = await (
      await postBulkImport(request, token, { buffer: rows(), dryRun: 'false' })
    ).json();
    created = report.accepted.map((a: { recordId: string }) => a.recordId);
    expect(created).toHaveLength(3);

    const audit = await readAuditSince(request, {
      entity: 'activity_record',
      action: 'create',
      since,
    });

    // The id SET, not a count: a count survives a write that made three rows
    // against the wrong records.
    expect(new Set(audit.filter((r) => r.entityId !== null).map((r) => r.entityId))).toEqual(
      new Set(created),
    );

    const batch = audit.filter((r) => r.entityId === null && r.diff?.bulk === true);
    expect(batch).toHaveLength(1);
    expect(batch[0].diff).toMatchObject({
      bulk: true,
      dryRun: false,
      totalRows: 3,
      acceptedCount: 3,
      rejectedCount: 0,
    });

    // Every imported row is a draft that carries a figure — the fixture factor
    // exists so a non-evidence category can be calculated at all.
    const stored = await serviceReadRecords(request, `id=in.(${created.map((id) => `"${id}"`).join(',')})`);
    expect(stored.every((r) => r.status === 'draft')).toBe(true);
    expect(stored.every((r) => r.category === E2E_BULK_CATEGORY)).toBe(true);
    expect(stored.every((r) => r.activity_unit === E2E_BULK_UNIT)).toBe(true);
  } finally {
    await deleteRecordsAsService(request, created);
  }
});

test('a refused file still leaves a trace on the audit trail', async ({ request }) => {
  // The one event most worth keeping is the one that accomplished nothing. The
  // import's batch row used to be written only after the loop, so a refusal
  // left no trace at all.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const since = new Date().toISOString();

  const res = await postBulkImport(request, token, {
    buffer: Buffer.from('not a spreadsheet'),
    fileName: 'payload.txt',
    dryRun: 'true',
  });
  expect(res.status()).toBe(400);

  const audit = await readAuditSince(request, {
    entity: 'activity_record',
    action: 'create',
    since,
  });
  expect(audit.some((r) => r.diff?.refused === true)).toBe(true);
});

test('the row-level refusals arrive with the codes the contract names', async ({
  request,
}) => {
  // A dry run, so the whole table costs one request and writes nothing.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const csv = buildBulkCsv([
    { ...LANE, activityValue: 12 },
    // The same slot twice in one file — a conflict Postgres would only raise
    // on the insert, which is why the importer checks it itself.
    { ...LANE, activityValue: 13 },
    { ...LANE, periodValue: 'Q4', activityValue: 'N/A' },
    { ...LANE, periodValue: 'Q4', category: 'Refrigerants', activityValue: 5, activityUnit: 'tonnes' },
    // The same category and unit as row 2, one year earlier. The factor
    // library is year-scoped with no fallback, and the fixture covers
    // `E2E_YEAR` alone — so this row can only be refused if the importer reads
    // `reportingYear` PER ROW and carries it into the factor lookup. A column
    // dropped on the floor would default to the file's other rows and import
    // cleanly. It is also the case `toIssue` was written for: history older
    // than the factor library, reported as coverage rather than access.
    { ...LANE, periodValue: 'Q1', reportingYear: E2E_YEAR - 1, activityValue: 9 },
  ]);

  const report = await (
    await postBulkImport(request, token, { buffer: csv, dryRun: 'true' })
  ).json();

  // Code BY ROW, not a bag of codes: four right codes attached to the wrong
  // four lines would satisfy any `toContain`, and the row number is the only
  // part of an issue the user can act on — it is the line they open in Excel.
  // Row 1 is the header, so the data starts at 2.
  expect(
    Object.fromEntries(report.errors.map((e: BulkUploadRowIssue) => [e.row, e.code])),
  ).toEqual({
    3: 'duplicate_in_file',
    4: 'invalid',
    // The archetypal bulk-import failure, and the one that used to be reported
    // as a tenant/permission problem.
    5: 'no_factor',
    6: 'no_factor',
  });
  expect(report.accepted).toHaveLength(1);
});
