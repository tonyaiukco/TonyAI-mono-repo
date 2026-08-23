import { test, expect } from '@playwright/test';
import {
  ADMIN_EMAIL,
  API_BASE,
  E2E_PERIOD,
  E2E_YEAR,
  SUB,
  approveRecord,
  bearer,
  createCommittedRecord,
  findRecordId,
  getAccessToken,
  lockPeriod,
} from './helpers';

/**
 * API probes, not UI flows: the defect is unreachable through the app.
 *
 * Both period controls are fixed dropdowns bound to the canonical vocabulary,
 * so only a direct caller — an integration, a script, the bulk importer WP8
 * will add — could send `"q1"`. That is precisely why it needed closing before
 * such a caller exists rather than after.
 *
 * `isValidPeriodValue` has always compared case-insensitively and trimmed,
 * while every write stored the caller's string verbatim — and every reader
 * compares RAW strings. Two consequences, and this file covers both.
 *
 * Tuple isolation, and note which axis actually couples: everything here is
 * `TonyAI Logistics · Q1`. Category alone would not have been enough. "Previous
 * submissions" on Data Entry is fetched by SUBSIDIARY only and rendered
 * unfiltered, and `analytics.spec.ts` clicks a button matched by `/Q4 2026/`
 * after deep-linking to Logistics — so a Logistics·Q4 row of ours, in ANY
 * category, would have made that locator ambiguous in a different file. Q1 is
 * unclaimed on this subsidiary: Q3 is review-queue's, Q4 is analytics'. The
 * second test also takes a period LOCK on Logistics·Q1 and reopens it in a
 * `finally`, so it cannot outlive the test even on failure.
 */

const PERIOD = 'Q1';

test('a period is one period, whatever the caller capitalises', async ({ request }) => {
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const body = (periodValue: string) => ({
    subsidiaryId: SUB.logistics,
    locationId: null,
    reportingYear: E2E_YEAR,
    reportingPeriod: E2E_PERIOD,
    periodValue,
    category: 'Natural Gas',
    activityValue: 5100,
    activityUnit: 'kWh',
    varianceReason: null,
    input: null,
  });

  // Lower case, and padded — both passed validation before, because it trims
  // and lower-cases only to COMPARE.
  const first = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: body('  q1  '),
  });
  expect(first.status()).toBe(201);
  // Stored canonical, so what comes back is what every other surface keys on —
  // not what was typed.
  expect((await first.json()).periodValue).toBe(PERIOD);

  // The same period, spelled the way the app spells it. Before canonicalisation
  // this was a DIFFERENT index key and returned 201, leaving two live rows for
  // one quarter, both inside COUNTED_STATUSES and both counted.
  const second = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: body(PERIOD),
  });
  expect(second.status()).toBe(409);
  // WHICH conflict matters: the period-lock gate raises 409 too, and a test
  // that accepted either would pass for the wrong reason.
  expect(await second.text()).toMatch(
    /activity record already exists for this reporting entity/i,
  );

  // And the ledger holds one row for that period, not two.
  const list = await request.get(
    `${API_BASE}/activity-records?subsidiaryId=${SUB.logistics}`,
    { headers: bearer(token) },
  );
  expect(list.ok()).toBe(true);
  const rows = (await list.json()) as Array<Record<string, string | null>>;
  const forThisPeriod = rows.filter(
    (r) =>
      r.category === 'Natural Gas' &&
      r.reportingPeriod === E2E_PERIOD &&
      String(r.reportingYear) === String(E2E_YEAR) &&
      (r.periodValue ?? '').toLowerCase() === PERIOD.toLowerCase(),
  );
  expect(forThisPeriod).toHaveLength(1);
  expect(forThisPeriod[0].periodValue).toBe(PERIOD);
});

test('a closed period is closed whatever spelling closed it', async ({ request }) => {
  // The sharper consequence, and the one the uniqueness half does not cover.
  // The lock gate and the `approved -> locked` flip are raw Postgres equality,
  // so a lock recorded under one spelling neither blocked, counted, nor flipped
  // records recorded under another: a period a super_admin believed closed went
  // on accepting writes.
  const token = await getAccessToken(request, ADMIN_EMAIL);

  const id = await createCommittedRecord(request, token, {
    subsidiaryId: SUB.logistics,
    // A category with a seeded TR factor. `Waste` and the other factor-less
    // ones are refused at creation (only `Water` is recordable without one), so
    // using one here would fail for a reason that has nothing to do with locks.
    // Fuel·Q1 on this subsidiary is unclaimed — `analytics.spec.ts` holds Q4.
    category: 'Fuel',
    activityUnit: 'litres',
    periodValue: PERIOD,
    activityValue: 260,
  });
  await approveRecord(request, token, id);

  // Locked with a DIFFERENT spelling from the record it must cover.
  const lockId = await lockPeriod(request, token, {
    subsidiaryId: SUB.logistics,
    periodValue: '  q1  ',
  });

  try {
    // The flip found the record: proof the lock and the record agree on which
    // period they are talking about.
    const after = await request.get(`${API_BASE}/activity-records/${id}`, {
      headers: bearer(token),
    });
    expect(after.ok()).toBe(true);
    expect((await after.json()).status).toBe('locked');

    // …and the gate refuses a new record in it, sent either way.
    for (const spelling of [PERIOD, ' q1 ']) {
      const blocked = await request.post(`${API_BASE}/activity-records`, {
        headers: bearer(token),
        data: {
          subsidiaryId: SUB.logistics,
          locationId: null,
          reportingYear: E2E_YEAR,
          reportingPeriod: E2E_PERIOD,
          periodValue: spelling,
          category: 'Electricity',
          activityValue: 120,
          activityUnit: 'kWh',
          varianceReason: null,
          input: null,
        },
      });
      expect(blocked.status()).toBe(409);
      expect(await blocked.text()).toMatch(/is locked/i);
    }
  } finally {
    // Reopen, so the lock does not outlive this test for the rest of the run.
    // Teardown would reclaim it, but a stray lock is the kind of leftover that
    // fails a later spec in a way that looks like the later spec's fault.
    const unlocked = await request.delete(`${API_BASE}/period-locks/${lockId}`, {
      headers: bearer(token),
    });
    expect(unlocked.ok()).toBe(true);
  }

  // Reopening put the record back where it was, which is what makes the lock a
  // reversible gate rather than a state change.
  const reopened = await findRecordId(request, token, {
    subsidiaryId: SUB.logistics,
    category: 'Fuel',
    periodValue: PERIOD,
  });
  expect(reopened).toBe(id);
});
