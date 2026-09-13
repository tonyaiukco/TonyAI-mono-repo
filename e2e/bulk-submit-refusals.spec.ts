import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  ADMIN_EMAIL,
  API_BASE,
  attachEvidence,
  bearer,
  buildBulkCsv,
  CONSULTANT_EMAIL,
  deleteRecordsAsService,
  E2E_BULK_CATEGORY,
  E2E_PERIOD,
  ENTRY_EMAIL,
  getAccessToken,
  lockPeriod,
  postBulkImport,
  readAuditSince,
  serviceReadRecords,
  waitOutImportThrottle,
  SUB,
} from './helpers';

/**
 * One real record driven into each refusal, asserting the code AND the
 * sentence.
 *
 * Its own file because it is the only one that produces `submitted` records,
 * and a stray one turns `gates.spec.ts` red four files later with an error that
 * names neither this file nor the record: `lockPeriod` returns 409 while any
 * record in its tuple is pending review, and the API refuses to delete a
 * submitted record, so the `finally` here must go through the service role.
 *
 * Lane: `SUB.logistics` / quarterly `E2E_YEAR` / Q2, Q3 and Q4 — the least
 * contended of the two subsidiaries `entry@` can reach. Q2 is the one this file
 * also LOCKS, and unlocks again in its `finally`. `SUB.trading` Q1 is never
 * touched: that is the tuple `gates` locks.
 */
const SUBSIDIARY = SUB.logistics;

test.describe.configure({ mode: 'serial' });
/**
 * This file spends four imports, and it used to rely on nothing that sorts
 * before `bulk-s…` touching the import route — an invariant written down
 * nowhere, which the first spec to break it would turn into a 429 inside a test
 * asserting something else. It buys its own window instead, like the other
 * three bulk files.
 */
test.beforeAll(async () => {
  // The hook's own timeout defaults to the test timeout, which is 60s — one
  // second less than the wait it has to make.
  test.setTimeout(90_000);
  await waitOutImportThrottle();
});

/** Import one row and return its id — the arrange step for most cases here. */
async function importOne(
  request: Parameters<typeof serviceReadRecords>[0],
  token: string,
  periodValue: string,
  over: { category?: string; activityUnit?: string; activityValue?: number } = {},
): Promise<string> {
  const res = await postBulkImport(request, token, {
    buffer: buildBulkCsv([
      {
        subsidiaryId: SUBSIDIARY,
        periodValue,
        activityValue: over.activityValue ?? 10,
        category: over.category,
        activityUnit: over.activityUnit,
      },
    ]),
    dryRun: 'false',
  });
  const body = await res.json();
  if (body.accepted?.length !== 1) {
    throw new Error(`importOne did not import: ${JSON.stringify(body)}`);
  }
  return body.accepted[0].recordId as string;
}

function submitMany(
  request: Parameters<typeof serviceReadRecords>[0],
  token: string,
  recordIds: string[],
) {
  return request.post(`${API_BASE}/activity-records/bulk-submit`, {
    headers: bearer(token),
    data: { recordIds },
  });
}

test('each refusal a seeded database can reach names its own record, code and sentence', async ({
  request,
}) => {
  // Five of the seven `BULK_SUBMIT_ISSUE_CODES`. `unexpected` is unreachable by
  // design — it is the catch-all for an exception nobody classified — and
  // `variance_reason_required` needs an anomaly baseline (three committed
  // priors in the same subsidiary+category+period) that costs more to arrange
  // than the refusal is worth proving twice: the import already warns
  // `would_block_submit` for it, and that path has unit coverage.
  // `not_submittable` is the second test below.
  const adminToken = await getAccessToken(request, ADMIN_EMAIL);
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const created: string[] = [];
  let lockId: string | null = null;

  try {
    // evidence_required — and it has to be an EVIDENCE-REQUIRED category to
    // produce that refusal. The fixture category this file otherwise uses
    // (`Waste`) exists precisely because it needs no evidence, so importing
    // there and calling the variable `needsEvidence` produced a record that
    // submitted cleanly and a test that asserted a code the server never sent.
    const needsEvidence = await importOne(request, entryToken, 'Q3', {
      category: 'Electricity',
      activityUnit: 'kWh',
      activityValue: 120000,
    });
    created.push(needsEvidence);

    // not_author — admin writes it, entry@ tries to send it.
    const someoneElses = await importOne(request, adminToken, 'Q4');
    created.push(someoneElses);

    // period_locked — its own period, closed under it.
    const locked = await importOne(request, entryToken, 'Q2');
    created.push(locked);

    const absentId = randomUUID(); // not_found
    const res = await submitMany(request, entryToken, [absentId, needsEvidence, someoneElses]);

    expect(res.ok()).toBe(true);
    const body = await res.json();
    // Keyed by RECORD, not by code. A bag of codes is byte-identical whether
    // each refusal names its own record or every one of them names the first —
    // and that mutation (`toIssue(eligible[0].id, …)`, or a positional lookup
    // in `preflight`) tells a user their COLLEAGUE's row is the one missing an
    // invoice. The set of codes cannot see it.
    const byRecord: Record<string, { code: string; message: string }> = Object.fromEntries(
      body.failed.map((f: { recordId: string; code: string; message: string }) => [f.recordId, f]),
    );

    expect(Object.keys(byRecord).sort()).toEqual(
      [absentId, needsEvidence, someoneElses].sort(),
    );
    expect(byRecord[absentId].code).toBe('not_found');
    expect(byRecord[absentId].message).toBe('This record does not exist, or it is not yours.');
    expect(byRecord[someoneElses].code).toBe('not_author');
    expect(byRecord[someoneElses].message).toBe('Someone else created this record.');
    expect(byRecord[needsEvidence].code).toBe('evidence_required');
    // The exported fragment, not a retyped prefix: the bulk mapper
    // discriminates this refusal from the status one by that exact string.
    expect(byRecord[needsEvidence].message).toContain(
      'requires at least one evidence file before submitting',
    );
    // Every requested id lands in exactly one list.
    expect(body.submitted.length + body.failed.length).toBe(body.requested);

    // period_locked, separately — locking needs the period free of pending rows.
    lockId = await lockPeriod(request, adminToken, {
      subsidiaryId: SUBSIDIARY,
      periodValue: 'Q2',
    });
    const lockedRes = await submitMany(request, entryToken, [locked]);
    const lockedBody = await lockedRes.json();
    expect(lockedBody.failed[0].code).toBe('period_locked');
    expect(lockedBody.failed[0].message).toMatch(/is locked/);
  } finally {
    if (lockId) {
      const adminToken = await getAccessToken(request, ADMIN_EMAIL);
      await request.delete(`${API_BASE}/period-locks/${lockId}`, {
        headers: bearer(adminToken),
      });
    }
    await deleteRecordsAsService(request, created);
  }
});

test('a draft with evidence really does move, and only once', async ({ request }) => {
  // The (d) path's shape: import, attach evidence per record through the
  // ordinary single-record endpoint, then bulk-submit. But the import is
  // `Waste`, the fixture category, and it needs no file, so the evidence
  // here is incidental: this test would pass without it. The
  // evidence-required path, with the file attached through the vault, is
  // `drafts-bulk-submit-evidence.spec.ts`.
  const entryToken = await getAccessToken(request, ENTRY_EMAIL);
  const since = new Date().toISOString();
  const created: string[] = [];

  try {
    const id = await importOne(request, entryToken, 'Q3');
    created.push(id);
    await attachEvidence(request, entryToken, id);

    const first = await (await submitMany(request, entryToken, [id])).json();
    expect(first.submitted).toHaveLength(1);
    expect(first.submitted[0]).toMatchObject({
      recordId: id,
      subsidiaryId: SUBSIDIARY,
      reportingPeriod: E2E_PERIOD,
      periodValue: 'Q3',
      category: E2E_BULK_CATEGORY,
    });
    expect(first.failed).toHaveLength(0);

    const [row] = await serviceReadRecords(request, `id=eq.${id}`);
    expect(row.status).toBe('submitted');
    expect(row.submitted_at).not.toBeNull();

    // The per-record audit row, which the unit suite cannot see.
    const audit = await readAuditSince(request, {
      entity: 'activity_record',
      action: 'submit',
      since,
    });
    expect(audit.some((r) => r.entityId === id)).toBe(true);
    expect(audit.some((r) => r.entityId === null && r.diff?.bulk === true)).toBe(true);

    // A second send is the commonest real mistake — a click after a partial
    // success — and it must say so rather than moving anything.
    const second = await (await submitMany(request, entryToken, [id])).json();
    expect(second.submitted).toHaveLength(0);
    expect(second.failed[0].code).toBe('not_submittable');
    expect(second.failed[0].message).toMatch(/Only a draft can be submitted in bulk/);
  } finally {
    await deleteRecordsAsService(request, created);
  }
});

test('a role that may not author gets one 403, and it is recorded', async ({ request }) => {
  // Not a per-record report: a role cannot change mid-batch. And the refusal
  // is audited, because a seat probing the write surface is the interaction
  // most worth keeping on an append-only trail.
  const consultantToken = await getAccessToken(request, CONSULTANT_EMAIL);
  const since = new Date().toISOString();

  const res = await submitMany(request, consultantToken, [randomUUID()]);

  expect(res.status()).toBe(403);
  expect(JSON.stringify(await res.json())).toContain(
    'Your role may not submit activity records',
  );

  const audit = await readAuditSince(request, {
    entity: 'activity_record',
    action: 'submit',
    since,
  });
  expect(audit.some((r) => r.diff?.refused === true)).toBe(true);
});
