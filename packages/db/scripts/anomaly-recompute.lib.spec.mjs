import { describe, expect, it } from 'vitest';
import {
  BASELINE_TOLERANCE,
  buildPools,
  classify,
  exitCodeFor,
  freshVerdict,
  indexRecord,
  isLoopback,
  lockKey,
  parseArgs,
  parseHost,
  poolKey,
  REWRITABLE,
  sameBaseline,
  shouldScore,
  verdictsAgree,
} from './anomaly-recompute.lib.mjs';

const rec = (over = {}) => ({
  id: 'rec-1',
  subsidiaryId: 'sub-1',
  locationId: null,
  category: 'Electricity',
  reportingPeriod: 'monthly',
  reportingYear: 2026,
  periodValue: 'January',
  status: 'draft',
  calculation: { factorId: 'f-1', tCo2e: 10 },
  anomalyFlag: false,
  anomalyBaselinePriorCount: null,
  anomalyBaselineTCo2e: null,
  ...over,
});

describe('what may be rewritten', () => {
  // The safety decision this whole tool is built around, and the one the review
  // proved was invisible to every gate: widening REWRITABLE to include
  // `approved` and `locked` passed typecheck, lint and the tool's own dry run.
  it('is exactly the four non-terminal statuses', () => {
    expect([...REWRITABLE].sort()).toEqual(
      ['draft', 'rejected', 'submitted', 'under_review'].sort(),
    );
  });

  it.each(['approved', 'locked'])('refuses %s because the record is terminal', (status) => {
    expect(classify(rec({ status }), new Set())).toBe('terminal_status');
  });

  it.each(['draft', 'rejected', 'submitted', 'under_review'])(
    'rewrites %s when its period is open',
    (status) => {
      expect(classify(rec({ status }), new Set())).toBe('rewritable');
    },
  );

  it('refuses a DRAFT inside a closed period', () => {
    // The category error in the first cut: the exclusion was status-shaped
    // while the product's immutability boundary is period-shaped. A draft in a
    // locked period is a normal state — `lock` only refuses on records awaiting
    // review — and the API 409s every mutation on it.
    const row = rec({ status: 'draft' });
    expect(classify(row, new Set([lockKey(row)]))).toBe('locked_period');
  });

  it('matches a lock on all four columns, not fewer', () => {
    const row = rec();
    for (const differing of [
      { reportingYear: 2025 },
      { reportingPeriod: 'quarterly' },
      { periodValue: 'February' },
      { subsidiaryId: 'sub-2' },
    ]) {
      expect(classify(row, new Set([lockKey({ ...row, ...differing })]))).toBe('rewritable');
    }
  });

  it('never scores a withdrawn record', () => {
    // A voided figure's verdict is not a claim about anything, and scoring it
    // produces drift nobody can act on and nothing can clear: void six months
    // and each withdrawn row loses the others from its own pool, forever.
    expect(shouldScore('voided')).toBe(false);
    for (const s of [...REWRITABLE, 'approved', 'locked']) expect(shouldScore(s)).toBe(true);
  });
});

describe('exit codes', () => {
  it('reports drift a dry run did NOT repair', () => {
    // The first cut returned 0 here, so a drift check wired to a cron read
    // green while every draft in the system carried an invalidated verdict.
    expect(exitCodeFor({ stale: 5, unrepairable: 0, skipped: 0, applied: false })).toBe(1);
  });

  it('is 0 for a clean dry run', () => {
    expect(exitCodeFor({ stale: 0, unrepairable: 0, skipped: 0, applied: false })).toBe(0);
  });

  it('is 0 when apply repaired everything', () => {
    expect(exitCodeFor({ stale: 5, unrepairable: 0, skipped: 0, applied: true })).toBe(0);
  });

  it.each([
    ['refused', { unrepairable: 1, skipped: 0 }],
    ['skipped mid-run', { unrepairable: 0, skipped: 1 }],
  ])('is 1 when apply left drift behind (%s)', (_label, over) => {
    expect(exitCodeFor({ stale: 5, applied: true, ...over })).toBe(1);
  });
});

describe('sameBaseline', () => {
  it('absorbs the ULP difference between Postgres avg() and the JS fold', () => {
    // Measured at 3.6e-16 relative on 32 of 66 rows. Comparing by equality
    // reported 33 stale rows on a database with zero real drift.
    expect(sameBaseline(21.948, 21.947999999999997)).toBe(true);
  });

  it('treats a gained or lost baseline as drift', () => {
    expect(sameBaseline(null, 10)).toBe(false);
    expect(sameBaseline(10, null)).toBe(false);
    expect(sameBaseline(null, null)).toBe(true);
  });

  it('does not call a real change equal', () => {
    expect(sameBaseline(10, 10.001)).toBe(false);
    expect(sameBaseline(-5, 5)).toBe(false);
  });

  it('handles zero without a divide-by-zero', () => {
    expect(sameBaseline(0, 0)).toBe(true);
    expect(sameBaseline(0, 1)).toBe(false);
    // The Math.max(...,1) floor: a pure relative comparison would call these
    // different and report permanent drift on a zero-averaging window.
    expect(sameBaseline(0, BASELINE_TOLERANCE / 2)).toBe(true);
  });

  it('never calls NaN equal to anything, including itself', () => {
    expect(sameBaseline(NaN, NaN)).toBe(false);
    expect(sameBaseline(NaN, 10)).toBe(false);
  });
});

describe('pool identity', () => {
  it('separates the reporting entity, the category and the granularity', () => {
    const base = rec();
    const keys = new Set(
      [
        {},
        { subsidiaryId: 'sub-2' },
        { locationId: 'loc-1' },
        { category: 'Fuel' },
        { reportingPeriod: 'quarterly' },
      ].map((o) => poolKey({ ...base, ...o })),
    );
    expect(keys.size).toBe(5);
  });

  it('cannot merge two pools through a separator character', () => {
    // `category` and `reporting_period` are plain text with no DB constraint,
    // so a joined-string key could be forged by direct SQL.
    expect(poolKey(rec({ category: 'A|B', reportingPeriod: 'monthly' }))).not.toBe(
      poolKey(rec({ category: 'A', reportingPeriod: 'B|monthly' })),
    );
  });

  it('keeps a whole-company series apart from a site one', () => {
    expect(poolKey(rec({ locationId: null }))).not.toBe(poolKey(rec({ locationId: 'loc-1' })));
  });

  it('keeps each activity type in its own baseline (LP3-03)', () => {
    // Diesel and petrol of one site and month are two records; one series must
    // never baseline the other. An untyped (pre-LP3-03) record pools only with
    // untyped ones, and a record read without the field is untyped.
    const fuel = rec({ category: 'Fuel' });
    const keys = new Set(
      [{ activityType: 'diesel' }, { activityType: 'petrol' }, { activityType: null }].map((o) =>
        poolKey({ ...fuel, ...o }),
      ),
    );
    expect(keys.size).toBe(3);
    expect(poolKey(fuel)).toBe(poolKey({ ...fuel, activityType: null }));
  });
});

describe('freshVerdict', () => {
  const pool = (rows) => buildPools(rows.map(indexRecord));

  it('scores against the three most recent committed priors', () => {
    const priors = ['January', 'February', 'March'].map((periodValue, i) =>
      rec({
        id: `p-${i}`,
        periodValue,
        status: 'approved',
        calculation: { factorId: 'f-1', tCo2e: 10 },
      }),
    );
    const subject = indexRecord(
      rec({ id: 'subject', periodValue: 'April', calculation: { factorId: 'f-1', tCo2e: 19.8 } }),
    );
    expect(freshVerdict(subject, pool(priors))).toEqual({
      anomalous: true,
      priorCount: 3,
      baseline: 10,
    });
  });

  it('excludes the record itself and every later period', () => {
    const rows = [
      rec({ id: 'subject', periodValue: 'March', status: 'approved', calculation: { factorId: 'f-1', tCo2e: 19.8 } }),
      rec({ id: 'later', periodValue: 'April', status: 'approved', calculation: { factorId: 'f-1', tCo2e: 40 } }),
    ];
    const subject = indexRecord(rows[0]);
    // Only itself and a later month exist, so there is no window at all.
    expect(freshVerdict(subject, pool(rows)).priorCount).toBe(0);
  });

  it('does not let an uncommitted neighbour seed a baseline', () => {
    const rows = ['January', 'February', 'March'].map((periodValue, i) =>
      rec({ id: `d-${i}`, periodValue, status: 'draft', calculation: { factorId: 'f-1', tCo2e: 10 } }),
    );
    const subject = indexRecord(
      rec({ id: 'subject', periodValue: 'April', calculation: { factorId: 'f-1', tCo2e: 19.8 } }),
    );
    expect(freshVerdict(subject, pool(rows)).priorCount).toBe(0);
  });

  it('reaches across the year boundary', () => {
    const rows = [
      rec({ id: 'd', periodValue: 'December', reportingYear: 2025, status: 'approved', calculation: { factorId: 'f-1', tCo2e: 10 } }),
      rec({ id: 'n', periodValue: 'November', reportingYear: 2025, status: 'approved', calculation: { factorId: 'f-1', tCo2e: 10 } }),
      rec({ id: 'o', periodValue: 'October', reportingYear: 2025, status: 'approved', calculation: { factorId: 'f-1', tCo2e: 10 } }),
    ];
    const subject = indexRecord(rec({ id: 'subject', periodValue: 'January', calculation: { factorId: 'f-1', tCo2e: 19.8 } }));
    expect(freshVerdict(subject, pool(rows)).priorCount).toBe(3);
  });

  it('reports no pool at all for a record with no figure', () => {
    const subject = indexRecord(rec({ id: 'subject', calculation: { reasonCode: 'no_emission_factor' } }));
    expect(freshVerdict(subject, pool([]))).toEqual({
      anomalous: false,
      priorCount: null,
      baseline: null,
    });
  });
});

describe('verdictsAgree', () => {
  it('compares the flag and the count exactly', () => {
    const v = { anomalous: false, priorCount: 3, baseline: 10 };
    expect(verdictsAgree(v, { ...v, anomalous: true })).toBe(false);
    expect(verdictsAgree(v, { ...v, priorCount: 2 })).toBe(false);
    expect(verdictsAgree(v, { ...v, baseline: 10 + 1e-15 })).toBe(true);
  });
});

describe('the remote guard', () => {
  it.each([
    ['postgresql://postgres:postgres@127.0.0.1:54322/postgres', true],
    ['postgresql://u:p@localhost:5432/db', true],
    ['postgresql://u:p@[::1]:5432/db', true],
    ['postgresql://u:p@db.example.com:5432/db', false],
    // The first cut matched the pattern anywhere in the string, so a password
    // or a query parameter could forge "local".
    ['postgresql://u:p%40localhost%2F@db.example.com:5432/db', false],
    ['postgresql://u:p@db.example.com:5432/db?opt=@localhost:1', false],
    ['postgresql://u:p@localhost.evil.com:5432/db', false],
    ['not a url', false],
  ])('%s → loopback %s', (url, expected) => {
    expect(isLoopback(url)).toBe(expected);
  });

  it('extracts the host so a refusal can name it', () => {
    expect(parseHost('postgresql://u:p@db.example.com:5432/db')).toBe('db.example.com');
    expect(parseHost('nonsense')).toBeNull();
  });
});

describe('parseArgs', () => {
  it('refuses what it does not understand', () => {
    // `--aply` used to dry-run silently and exit 0, so a scripted caller could
    // not tell a typo from a successful repair.
    expect(parseArgs(['--aply']).unknown).toEqual(['--aply']);
    expect(parseArgs(['--apply=true']).unknown).toEqual(['--apply=true']);
    expect(parseArgs(['-apply']).unknown).toEqual(['-apply']);
  });

  it('lets the end-of-options separator through', () => {
    // `pnpm anomaly:recompute -- --apply` forwards the `--` verbatim, and that
    // is the documented invocation. A strict parser that rejected it refused
    // the README's own command.
    expect(parseArgs(['--', '--apply'])).toMatchObject({ apply: true, unknown: [] });
  });

  it('accepts the flags it documents', () => {
    expect(parseArgs(['--apply'])).toMatchObject({ apply: true, unknown: [] });
    expect(parseArgs(['--allow-remote=db.example.com'])).toMatchObject({
      allowRemoteHost: 'db.example.com',
      unknown: [],
    });
  });
});
