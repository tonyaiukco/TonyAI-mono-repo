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
 * KNOWN DIFFERENCE, NOT DRIFT (BUG-R2-07, 2026-11-11)
 * ---------------------------------------------------
 * Until 2026-11-11 a record with one or two priors was stored as "not
 * evaluated": a prior count of 1 or 2 beside a NULL average. The rule now
 * judges such a window, but those verdicts are KEPT, not re-scored (owner
 * decision) — a committed record would otherwise gain a flag its author never
 * saw. So where the rule would flag one today, that is reported in its own
 * section and does not count as drift: nothing moved beneath the record, the
 * rule did. `anomaly:recompute` leaves the same records alone.
 *
 * A second known difference since 2026-11-13 (BUG-R2-07 tier 3): a first
 * period is held to a typo ceiling, and one stored unflagged before the
 * ceilings existed — still with no earlier period, above its ceiling today —
 * is kept the same way (section 2c). A FLAG beside no earlier period whose
 * amount is not above its ceiling is a row no writer produced: drift.
 *
 * THE RULE IS REIMPLEMENTED HERE, DELIBERATELY
 * --------------------------------------------
 * This SQL does not call the service and shares no code with it. That is the
 * point: an independent reimplementation can DISAGREE with the implementation,
 * which is the only way question 2 has an answer. The cost is that a change to
 * `detectAnomaly` must be mirrored in the SAME PR — the constants and the SQL
 * in `anomaly-probe.lib.mjs` are the whole of it.
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
 * Exit code: 1 when the stored verdict — flag, count or average — disagrees
 * with the rule (real drift),
 * 0 otherwise — a weak baseline is a fact to look at, not a failure.
 */
import 'dotenv/config';
import { PrismaClient } from '../generated/client/index.js';

import {
  ANOMALY_THRESHOLD,
  BASE_SQL,
  BASELINE_MAX_PERIODS,
  BASELINE_MIN_PERIODS,
  DRIFT_WHERE,
  LEGACY_WHERE,
  PRE_CEILING_WHERE,
} from './anomaly-probe.lib.mjs';

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

const q = (sql) => prisma.$queryRawUnsafe(`${BASE_SQL}\n${sql}`);
const entity = (row) => row.loc ?? '-- whole company --';
const period = (row) => `${row.period_value} ${row.reporting_year}`;

async function main() {
  const target = url.replace(/:\/\/[^@]*@/, '://***@');
  console.log(`Target:  ${target}${isLocal ? ' (local)' : '  ** REMOTE **'}`);
  console.log(
    `Rule:    key = subsidiary + location + category + granularity · ` +
      `at least ${BASELINE_MIN_PERIODS} prior of a ${BASELINE_MAX_PERIODS}-period window · ` +
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
           priors, baseline, anomaly_flag, computed,
           stored_priors, stored_baseline, expected_priors, expected_baseline
    FROM verdict WHERE ${DRIFT_WHERE} ORDER BY sub, category, key;`);

  console.log(`\n2. Drift — the stored verdict (flag, count, average) vs the rule over today's pool`);
  if (drift.length === 0) {
    console.log('   none. Every stored verdict still matches the pool beneath it.');
  } else {
    for (const row of drift) {
      console.log(
        `   ${row.id}  ${row.sub} · ${entity(row)} · ${row.category} · ${period(row)}` +
          ` [${row.status}] ${row.tco2e?.toFixed(3)} tCO₂e\n` +
          `     stored: flag ${row.anomaly_flag}, ${row.stored_priors ?? 'no'} prior(s), average ${row.stored_baseline?.toFixed(3) ?? 'none'}\n` +
          `     rule:   flag ${row.computed}, ${row.expected_priors ?? 'no'} prior(s), average ${row.expected_baseline?.toFixed(3) ?? 'none'}`,
      );
    }
  }

  const legacy = await q(`
    SELECT id, sub, loc, category, period_value, reporting_year, status, tco2e,
           priors, baseline, anomaly_flag, computed
    FROM verdict WHERE ${LEGACY_WHERE} ORDER BY sub, category, key;`);
  const legacyFlaggedNow = legacy.filter((row) => row.anomaly_flag !== row.computed);

  console.log(
    `
2b. Known difference — ${legacy.length} verdict(s) scored before the short-history check (kept, not drift)`,
  );
  if (legacyFlaggedNow.length === 0) {
    console.log('   none of them would be flagged by the rule today.');
  } else {
    console.log(`   ${legacyFlaggedNow.length} would be flagged by the rule today:`);
    for (const row of legacyFlaggedNow) {
      console.log(
        `   ${row.id}  ${row.sub} · ${entity(row)} · ${row.category} · ${period(row)}` +
          ` [${row.status}]
     ${row.tco2e?.toFixed(3)} tCO₂e vs baseline ${row.baseline?.toFixed(3)}` +
          ` over ${row.priors} prior(s)`,
      );
    }
  }

  const preCeiling = await q(`
    SELECT id, sub, loc, category, period_value, reporting_year, status, tco2e
    FROM verdict WHERE ${PRE_CEILING_WHERE} ORDER BY sub, category, key;`);
  console.log(
    `\n2c. Known difference — ${preCeiling.length} record(s) above their typo ceiling where history cannot judge ` +
      `(no earlier period, or a zero average), scored before the ceilings existed (kept, not drift)`,
  );
  for (const row of preCeiling) {
    console.log(
      `   ${row.id}  ${row.sub} · ${entity(row)} · ${row.category} · ${period(row)} [${row.status}]`,
    );
  }

  const weak = await q(`
    SELECT sub, loc, category, period_value, reporting_year, status, tco2e, priors, baseline, legacy,
           anomaly_flag, above_ceiling
    FROM verdict WHERE priors < ${BASELINE_MAX_PERIODS} ORDER BY sub, loc NULLS FIRST, category, key;`);

  console.log(
    `\n3. Records on less than VAR §4.1's three-period window (${weak.length} of ${total})`,
  );
  for (const row of weak) {
    // What the pool supports TODAY, and whether the stored verdict used it: a
    // row kept from before the short-history check has the priors and was
    // still not checked, and a zero average yields no ratio at any count.
    const gate =
      row.priors === 0
        ? row.anomaly_flag
          ? row.above_ceiling
            ? 'FLAGGED — first period above its typo ceiling'
            : 'FLAGGED with no earlier period, NOT above its ceiling — drift (section 2)'
          : row.above_ceiling
            ? 'NOT EVALUATED — no prior period (above its ceiling; scored before the ceilings)'
            : 'NOT EVALUATED — no prior period'
        : row.legacy
          ? `NOT EVALUATED — scored before the short-history check (${row.priors} of ${BASELINE_MAX_PERIODS} priors today)`
          : Number(row.baseline) === 0
            ? row.anomaly_flag && row.above_ceiling
              ? `FLAGGED — above its typo ceiling, ${row.priors} prior(s) averaging zero`
              : `NOT EVALUATED — ${row.priors} prior(s) averaging zero`
            : `limited history — ${row.priors} of ${BASELINE_MAX_PERIODS} priors`;
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
