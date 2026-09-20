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
  deleteRecordsAsService,
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
 *
 * The third test is the same shape for a different write — the stored UNIT —
 * and takes Logistics·Q1·Water, which nothing else in `e2e/` creates. It
 * deletes its own row in a `finally` rather than holding the tuple for the
 * rest of the run, because unlike the two above it needs no state afterwards.
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

test('the stored unit is the vocabulary spelling, the snapshot keeps the entered one', async ({
  request,
}) => {
  // #123, through HTTP. Its unit tests mock Prisma, so they pin what the
  // service PASSES to `update`/`create` — not what a later reader gets back.
  // Between those two lies everything this cannot otherwise see: the DTO
  // (`IsActivityUnit` admits aliases, which is why a non-canonical spelling
  // reaches the service at all), the column, and `toDTO`.
  //
  // Water, because it is the one category recordable with no factor: the
  // record is uncalculated, and `inputUnit` is on that arm of the snapshot
  // too, so both halves are readable without seeding a factor.
  const token = await getAccessToken(request, ADMIN_EMAIL);
  const body = {
    subsidiaryId: SUB.logistics,
    locationId: null,
    reportingYear: E2E_YEAR,
    reportingPeriod: E2E_PERIOD,
    periodValue: PERIOD,
    category: 'Water',
    activityValue: 640,
    // An ALIAS, not a case variant: `m3` is a different string from the
    // vocabulary's `cubic_metres`, so a column that kept the caller's text
    // cannot accidentally agree with the assertion below.
    activityUnit: 'm3',
    varianceReason: null,
    input: null,
  };

  const created = await request.post(`${API_BASE}/activity-records`, {
    headers: bearer(token),
    data: body,
  });
  expect(created.status()).toBe(201);
  const record = await created.json();
  const id = record.id as string;

  try {
    // The two halves, on the way out of the write.
    expect(record.activityUnit).toBe('cubic_metres');
    expect(record.calculation.inputUnit).toBe('m3');

    // …and on a FRESH read, which is the half a service-level test cannot
    // reach: what came back above could have been the DTO echoing its input.
    const read = await request.get(`${API_BASE}/activity-records/${id}`, {
      headers: bearer(token),
    });
    expect(read.ok()).toBe(true);
    const stored = await read.json();
    expect(stored.activityUnit).toBe('cubic_metres');
    expect(stored.calculation.inputUnit).toBe('m3');

    // An edit that never names the unit leaves the stored spelling alone.
    // This is the gate #123 added in a second commit, and it is the branch a
    // careless `storedUnit(dto.activityUnit)` on every update would break —
    // silently, because `storedUnit(undefined)` has no reason to throw.
    const valueOnly = await request.patch(`${API_BASE}/activity-records/${id}`, {
      headers: bearer(token),
      data: { activityValue: 700 },
    });
    expect(valueOnly.ok()).toBe(true);
    const afterValue = await valueOnly.json();
    expect(afterValue.activityValue).toBe(700);
    expect(afterValue.activityUnit).toBe('cubic_metres');
    // Deliberately NOT asserting `calculation.inputUnit` here. The snapshot is
    // recomputed on any edit and `storedUnit`'s docstring is explicit that the
    // entered spelling survives "until the record is next edited", so pinning
    // it either way would pin an implementation detail this test is not about.
    // Left as a note so nobody completes the pattern by filling it in.

    // An edit that DOES name one canonicalises it, and the snapshot follows
    // the newly entered spelling rather than the first one.
    const unitEdit = await request.patch(`${API_BASE}/activity-records/${id}`, {
      headers: bearer(token),
      data: { activityUnit: 'm³' },
    });
    expect(unitEdit.ok()).toBe(true);
    const afterUnit = await unitEdit.json();
    expect(afterUnit.activityUnit).toBe('cubic_metres');
    expect(afterUnit.calculation.inputUnit).toBe('m³');
  } finally {
    await deleteRecordsAsService(request, [id]);
  }
});
