#!/usr/bin/env node
/**
 * Measure the anomaly baseline (VAR §4) against what the database actually holds.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two claims about the anomaly rule were written into the project log from
 * reasoning rather than from a query, and one of them was wrong. The rule is
 * cheap to recompute in SQL and expensive to argue about, so it is a probe now.
 *
 * It answers three questions the API cannot:
 *
 *  1. HOW STRONG IS THE BASELINE that each committed record was scored against?
 *     The record carries `baselinePriorCount` since WP21 PR 2a, but this probe
 *     recomputes it rather than reading it — a column that describes the pool
 *     as it stood at write time cannot verify itself against the pool as it
 *     stands now, which is exactly what question 2 asks.
 *
 *  2. HAS THE STORED VERDICT DRIFTED? The flag is written at create/update/
 *     submit and never revisited, while the pool underneath it keeps moving:
 *     `submit` adds a prior to every later record, `void` and `remove` withdraw
 *     one, and a re-attribution moves one between pools. Nothing re-scores the
 *     records downstream, so a repair like WP18's silently invalidates them.
 *
 *  3. WHICH RECORDS SIT ON A WEAK BASELINE — the WP18 fingerprint. A series
 *     whose attribution changed hands restarts its run-up mid-year, which is
 *     indistinguishable on every screen from a series that simply began there.
 *
 * THE RULE IS REIMPLEMENTED HERE, DELIBERATELY
 * --------------------------------------------
 * This SQL does not call the service and shares no code with it. That is the
 * point: an independent reimplementation can DISAGREE with the implementation,
 * which is the only way question 2 has an answer. The cost is that a change to
 * `detectAnomaly` must be mirrored here in the SAME PR — the constants below
 * are the whole of it.
 *
 * SAFETY
 * ------
 * Read-only by construction: every statement is a SELECT, and the script never
 * writes, so there is no --apply. It still refuses a non-local database without
 * --allow-remote: it prints one tenant's whole inventory to stdout, and a
 * remote DATABASE_URL is a data-exposure decision, not a typo.
 *
 * Usage:
 *   node packages/db/scripts/anomaly-probe.mjs
 *   node packages/db/scripts/anomaly-probe.mjs --allow-remote
 *
 * Exit code: 1 when the stored verdict disagrees with the rule (real drift),
 * 0 otherwise — a weak baseline is a fact to look at, not a failure.
 */
import 'dotenv/config';
import { PrismaClient } from '../generated/client/index.js';

/* ---- the rule, mirrored from apps/api/src/activity-records/activity-records.service.ts ---- */

/** VAR §4.2 — more than 50% from the rolling average. */
const ANOMALY_THRESHOLD = 0.5;
/** VAR §4.1 — the rolling average is over the previous 3 comparable periods. */
const BASELINE_MAX_PERIODS = 3;
/**
 * How many of those periods must actually carry a figure for the rule to run.
 * Equal to the window since 2026-08-27: the implementation used to evaluate on
 * as few as ONE, which VAR §4.1 does not sanction and no surface disclosed.
 * Kept as its own constant because section 3 still reports the shortfall —
 * "2 of 3" is the finding, and a single constant could not express it.
 */
const BASELINE_MIN_PERIODS = 3;
/** COUNTED_STATUSES — the only statuses that seed a baseline. `voided` never does. */
const BASELINE_STATUSES = ['submitted', 'under_review', 'approved', 'locked'];

const args = process.argv.slice(2);
const allowRemote = args.includes('--allow-remote');

const url = process.env.DATABASE_URL ?? '';
if (!url) {
  console.error('DATABASE_URL is required (packages/db/.env).');
  process.exit(2);
}
const isLocal = /@(127\.0\.0\.1|localhost)[:/]/.test(url);
if (!isLocal && !allowRemote) {
  console.error(
    'Refusing to run against a non-local database.\n' +
      'This prints every committed activity record it finds to stdout, across\n' +
      'every tenant. Pass --allow-remote if you really mean it.',
  );
  process.exit(2);
}

const prisma = new PrismaClient();

/**
 * The baseline, per record. No parameters are interpolated from input — the
 * only substitutions are the constants above — so `$queryRawUnsafe` here is a
 * static string, used because the three reports share this prefix and a tagged
 * template cannot be concatenated.
 */
const BASE_SQL = `
WITH r AS (
  SELECT id, subsidiary_id, location_id, category, activity_type, reporting_period,
         reporting_year, period_value, status, anomaly_flag,
         reporting_year * 100 + COALESCE(CASE reporting_period
           WHEN 'monthly'   THEN array_position(ARRAY['January','February','March','April','May','June','July','August','September','October','November','December'], period_value) - 1
           WHEN 'quarterly' THEN array_position(ARRAY['Q1','Q2','Q3','Q4'], period_value)
           ELSE 0 END, 0) AS key,
         CASE WHEN jsonb_typeof(calculation->'factorId') = 'string'
                   AND length(calculation->>'factorId') > 0
                   AND jsonb_typeof(calculation->'tCo2e') = 'number'
              THEN (calculation->>'tCo2e')::float8 END AS tco2e
  FROM activity_records
),
counted AS (
  SELECT * FROM r WHERE status = ANY(ARRAY[${BASELINE_STATUSES.map((s) => `'${s}'`).join(',')}]::"ActivityRecordStatus"[])
),
scored AS (
  SELECT c.*, s.legal_name AS sub, l.name AS loc, p.slots, p.priors, p.baseline
  FROM counted c
  JOIN subsidiaries s ON s.id = c.subsidiary_id
  LEFT JOIN locations l ON l.id = c.location_id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS slots, count(t.tco2e)::int AS priors, avg(t.tco2e) AS baseline
    FROM (
      SELECT b.tco2e FROM counted b
      WHERE b.subsidiary_id = c.subsidiary_id
        AND b.location_id IS NOT DISTINCT FROM c.location_id
        AND b.category = c.category
        AND b.activity_type IS NOT DISTINCT FROM c.activity_type
        AND b.reporting_period = c.reporting_period
        AND b.key < c.key
        AND b.id <> c.id
      ORDER BY b.key DESC
      LIMIT ${BASELINE_MAX_PERIODS}
    ) t
  ) p ON TRUE
),
verdict AS (
  SELECT *, CASE
    WHEN tco2e IS NULL THEN false
    WHEN priors < ${BASELINE_MIN_PERIODS} OR baseline IS NULL OR baseline = 0 THEN false
    ELSE abs(tco2e - baseline) / baseline > ${ANOMALY_THRESHOLD} END AS computed
  FROM scored
)`;

const q = (sql) => prisma.$queryRawUnsafe(`${BASE_SQL}\n${sql}`);
const entity = (row) => row.loc ?? '-- whole company --';
const period = (row) => `${row.period_value} ${row.reporting_year}`;

async function main() {
  const target = url.replace(/:\/\/[^@]*@/, '://***@');
  console.log(`Target:  ${target}${isLocal ? ' (local)' : '  ** REMOTE **'}`);
  console.log(
    `Rule:    key = subsidiary + location + category + granularity · ` +
      `${BASELINE_MIN_PERIODS} priors required of a ${BASELINE_MAX_PERIODS}-period window · ` +
      `threshold ${ANOMALY_THRESHOLD * 100}%\n`,
  );

  const strength = await q(`
    SELECT priors, slots, count(*)::int AS records,
           count(*) FILTER (WHERE anomaly_flag)::int AS stored_flagged,
           count(*) FILTER (WHERE computed)::int     AS rule_flagged
    FROM verdict GROUP BY 1, 2 ORDER BY 1, 2;`);

  const total = strength.reduce((n, row) => n + row.records, 0);
  console.log(`1. Baseline strength over ${total} committed records`);
  console.log('   priors  slots  records  stored flagged  rule flagged');
  for (const row of strength) {
    console.log(
      `   ${String(row.priors).padStart(6)}  ${String(row.slots).padStart(5)}  ` +
        `${String(row.records).padStart(7)}  ${String(row.stored_flagged).padStart(14)}  ` +
        `${String(row.rule_flagged).padStart(12)}`,
    );
  }
  const droppedSlots = strength.filter((row) => row.slots !== row.priors);
  if (droppedSlots.length > 0) {
    console.log(
      `   note: ${droppedSlots.reduce((n, row) => n + row.records, 0)} record(s) had a prior WITHOUT a\n` +
        '   figure inside the 3-period window. It consumes a slot and is then dropped,\n' +
        '   so the baseline is thinner than the window suggests.',
    );
  }

  const drift = await q(`
    SELECT id, sub, loc, category, period_value, reporting_year, status, tco2e,
           priors, baseline, anomaly_flag, computed
    FROM verdict WHERE anomaly_flag <> computed ORDER BY sub, category, key;`);

  console.log(`\n2. Drift — stored anomaly_flag vs the rule over today's pool`);
  if (drift.length === 0) {
    console.log('   none. Every stored verdict still matches the pool beneath it.');
  } else {
    for (const row of drift) {
      console.log(
        `   ${row.id}  ${row.sub} · ${entity(row)} · ${row.category} · ${period(row)}` +
          ` [${row.status}]\n     stored ${row.anomaly_flag} → rule says ${row.computed}` +
          ` (${row.tco2e?.toFixed(3)} tCO₂e vs baseline ${row.baseline?.toFixed(3)} over ${row.priors} prior(s))`,
      );
    }
  }

  const weak = await q(`
    SELECT sub, loc, category, period_value, reporting_year, status, tco2e, priors
    FROM verdict WHERE priors < ${BASELINE_MAX_PERIODS} ORDER BY sub, loc NULLS FIRST, category, key;`);

  console.log(
    `\n3. Records scored on a baseline weaker than VAR §4.1's three periods (${weak.length} of ${total})`,
  );
  for (const row of weak) {
    const gate =
      row.priors === 0
        ? 'NOT EVALUATED — no prior period'
        : `thin — ${row.priors} of ${BASELINE_MAX_PERIODS} priors`;
    console.log(
      `   ${row.sub} · ${entity(row)} · ${row.category} · ${period(row)} ` +
        `[${row.status}] ${row.tco2e?.toFixed(3)} tCO₂e — ${gate}`,
    );
  }
  console.log(
    '\n   A run-up that restarts mid-year is the fingerprint of an attribution\n' +
      '   change (WP18), and it reads exactly like a series that began there.',
  );

  return drift.length > 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(2);
  });
