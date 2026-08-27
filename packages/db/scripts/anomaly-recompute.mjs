#!/usr/bin/env node
/**
 * Re-derive anomaly verdicts against the pool as it stands now, and repair the
 * ones that have gone stale.
 *
 * WHY THIS EXISTS
 * ---------------
 * `anomalyFlag` and its provenance are written at create, update and submit,
 * and never revisited — while the pool underneath them keeps moving. `submit`
 * adds a prior to every later record in the series; `void` and `remove`
 * withdraw one; a re-attribution moves one between pools entirely. Nothing
 * re-scores the records downstream, so a repair like WP18's (six double-counted
 * months withdrawn) silently invalidates the verdicts that were taken against
 * them. `pnpm anomaly:probe` reports that divergence; this is what fixes it.
 *
 * IT DOES NOT RE-IMPLEMENT THE RULE
 * ---------------------------------
 * The verdict comes from `computeAnomalyVerdict` in @tonyai/shared-types — the
 * same function `activity-records.service.ts` calls — so a record re-scored
 * here is bitwise identical to the same record re-saved through the API. That
 * is deliberate and it is the opposite of `anomaly-probe.mjs`, which
 * reimplements the rule in SQL precisely so it CAN disagree. A probe that
 * shares an implementation cannot detect a bug in it; a repair tool that does
 * not share one cannot be trusted to write what the API would.
 *
 * The decisions live in `anomaly-recompute.lib.mjs` and are unit-tested; this
 * file is the IO around them.
 *
 * WHAT IT WILL NOT TOUCH — TWO DIFFERENT REFUSALS
 * -----------------------------------------------
 *  - `approved` and `locked` RECORDS: their verdicts are already printed into
 *    issued reports, and `audit_log` has no correction path.
 *  - any record inside a LOCKED PERIOD, whatever its status. The API refuses
 *    every mutation in a closed period with a 409, and a `draft` can sit inside
 *    one — so an exclusion that is only status-shaped would write into a closed
 *    period with a null actor, which is the shape an auditor reads as tampering.
 *
 * Both are re-checked INSIDE the write transaction, against `updatedAt` as an
 * optimistic-lock token. Classifying from a snapshot read minutes earlier is
 * not a guarantee: on a live stack a record can be approved, locked or edited
 * between the read and the write, and the first cut would have overwritten a
 * freshly-computed verdict with one derived from the pre-edit figure.
 *
 * SAFETY
 * ------
 *  - dry run unless `--apply` is passed;
 *  - a non-loopback database is refused without `--allow-remote`, and loopback
 *    is necessary but NOT sufficient: a production database reached over an SSH
 *    tunnel is on 127.0.0.1, so `--allow-remote=<host>` must name the host;
 *  - unknown flags are a usage error, so a typo'd `--apply` cannot dry-run
 *    silently and report success;
 *  - every write is one transaction carrying a `rescore` audit row — the
 *    append-only trail is how a re-scored verdict stays distinguishable from an
 *    author changing a figure. A skipped row writes nothing at all;
 *  - baselines are compared with a relative tolerance, never equality.
 *
 * Usage:
 *   pnpm anomaly:recompute                                    # report only
 *   pnpm anomaly:recompute --apply
 *   pnpm anomaly:recompute --apply --allow-remote=db.example.com
 *
 * Exit codes: 0 nothing stale, or everything stale was repaired · 1 drift
 * remains (unrepaired, refused, or skipped because the row moved mid-run) ·
 * 2 usage error · 3 the run failed part-way.
 */
import 'dotenv/config';
import {
  buildPools,
  classify,
  exitCodeFor,
  freshVerdict,
  indexRecord,
  isLoopback,
  lockKey,
  parseArgs,
  parseHost,
  REWRITABLE,
  shouldScore,
  storedVerdict,
  verdictsAgree,
} from './anomaly-recompute.lib.mjs';
import { PrismaClient } from '../generated/client/index.js';

const { apply, allowRemote, allowRemoteHost, unknown } = parseArgs(process.argv.slice(2));

if (unknown.length > 0) {
  console.error(
    `Unrecognised argument(s): ${unknown.join(', ')}\n` +
      'Known flags: --apply, --allow-remote=<host>.\n' +
      'Refusing rather than ignoring them: a typo\'d --apply would otherwise dry-run and report success.',
  );
  process.exit(2);
}

const url = process.env.DATABASE_URL ?? '';
if (!url) {
  console.error('DATABASE_URL is required (packages/db/.env).');
  process.exit(2);
}
const host = parseHost(url);
const loopback = isLoopback(url);
if (!loopback && !(allowRemote || allowRemoteHost)) {
  console.error(
    `Refusing to run against ${host ?? 'a database whose host could not be parsed'}.\n` +
      'This rewrites anomaly verdicts across every tenant. Pass --allow-remote=<host> if you really mean it.',
  );
  process.exit(2);
}
if (allowRemoteHost && host !== allowRemoteHost) {
  console.error(
    `--allow-remote=${allowRemoteHost} does not match the configured host (${host ?? 'unparseable'}).\n` +
      'Naming the host is the point: loopback proves nothing on its own, because a\n' +
      'production database reached over an SSH tunnel is also on 127.0.0.1.',
  );
  process.exit(2);
}

const prisma = new PrismaClient();

const describe = (v) =>
  v.priorCount === null
    ? 'not evaluated (no figure)'
    : v.baseline === null
      ? `not evaluated (${v.priorCount} priors)`
      : `${v.anomalous ? 'ANOMALOUS' : 'clean'} vs ${v.baseline.toFixed(6)} over ${v.priorCount} priors`;

async function main() {
  const target = url.replace(/:\/\/[^@]*@/, '://***@');
  console.log(`Target:  ${target}${loopback ? ' (loopback)' : '  ** REMOTE **'}`);
  console.log(
    `Mode:    ${apply ? 'APPLY — stale verdicts will be rewritten' : 'dry run (pass --apply to repair)'}\n`,
  );

  const records = await prisma.activityRecord.findMany({
    // Only what the rule and the report need. `input` is a whole JSON column
    // this never reads, and the table is loaded in full.
    select: {
      id: true,
      subsidiaryId: true,
      locationId: true,
      category: true,
      reportingPeriod: true,
      reportingYear: true,
      periodValue: true,
      status: true,
      calculation: true,
      anomalyFlag: true,
      anomalyBaselinePriorCount: true,
      anomalyBaselineTCo2e: true,
      updatedAt: true,
      subsidiary: { select: { legalName: true, organisationId: true } },
    },
  });
  const lockedPeriods = new Set(
    (
      await prisma.periodLock.findMany({
        select: { subsidiaryId: true, reportingYear: true, reportingPeriod: true, periodValue: true },
      })
    ).map(lockKey),
  );

  const scoreable = records.filter((r) => shouldScore(r.status)).map(indexRecord);
  // The POOLS are built from every counted record, including ones this run will
  // not score — narrowing the pool would change the verdicts themselves.
  const pools = buildPools(records.map(indexRecord));

  const stale = [];
  for (const item of scoreable) {
    const stored = storedVerdict(item.row);
    const fresh = freshVerdict(item, pools);
    if (verdictsAgree(stored, fresh)) continue;
    stale.push({ item, stored, fresh, disposition: classify(item.row, lockedPeriods) });
  }

  console.log(
    `Checked ${scoreable.length} record(s)` +
      (records.length !== scoreable.length
        ? ` (${records.length - scoreable.length} withdrawn record(s) hold no verdict and were skipped)`
        : '') +
      `; ${stale.length} carry a stale verdict.`,
  );
  if (stale.length === 0) {
    console.log('\nNothing to repair.');
    return exitCodeFor({ stale: 0, unrepairable: 0, skipped: 0, applied: apply });
  }

  const rewritable = stale.filter((s) => s.disposition === 'rewritable');
  const terminal = stale.filter((s) => s.disposition === 'terminal_status');
  const inLockedPeriod = stale.filter((s) => s.disposition === 'locked_period');

  for (const group of [
    { label: 'Stale and rewritable', rows: rewritable },
    { label: 'Stale, but the record is terminal — reported, not touched', rows: terminal },
    { label: 'Stale, but the PERIOD is closed — reported, not touched', rows: inLockedPeriod },
  ]) {
    if (group.rows.length === 0) continue;
    console.log(`\n${group.label} (${group.rows.length}):`);
    for (const { item, stored, fresh } of group.rows) {
      const r = item.row;
      console.log(
        `  ${r.id}  ${r.subsidiary.legalName} · ${r.category} · ${r.periodValue} ${r.reportingYear} [${r.status}]\n` +
          `    stored: ${describe(stored)}\n` +
          `    now:    ${describe(fresh)}`,
      );
    }
  }

  const unrepairable = terminal.length + inLockedPeriod.length;
  if (unrepairable > 0) {
    console.log(
      `\n${unrepairable} record(s) are stale and this tool will not rewrite them:\n` +
        `  ${terminal.length} because the record itself is approved or locked — its verdict is\n` +
        '  already in issued reports;\n' +
        `  ${inLockedPeriod.length} because the reporting period is closed, which the API refuses to\n` +
        '  write into at all.\n' +
        'Each is a decision, not a repair.',
    );
  }

  if (!apply) {
    console.log(
      `\nDry run — nothing written. Pass --apply to rewrite the ${rewritable.length} rewritable row(s).`,
    );
    return exitCodeFor({ stale: stale.length, unrepairable, skipped: 0, applied: false });
  }

  const skipped = [];
  for (const { item, stored, fresh } of rewritable) {
    const r = item.row;
    await prisma.$transaction(async (tx) => {
      // The classification above came from a snapshot; this is the guarantee.
      // `updatedAt` is the optimistic-lock token precisely because every API
      // write path bumps it, so a record approved, locked or edited since the
      // read fails the predicate and is skipped rather than clobbered.
      const stillLocked = await tx.periodLock.findFirst({
        where: {
          subsidiaryId: r.subsidiaryId,
          reportingYear: r.reportingYear,
          reportingPeriod: r.reportingPeriod,
          periodValue: r.periodValue,
        },
        select: { id: true },
      });
      if (stillLocked) {
        skipped.push({ id: r.id, why: 'its period was closed mid-run' });
        return;
      }
      const written = await tx.activityRecord.updateMany({
        where: { id: r.id, status: { in: [...REWRITABLE] }, updatedAt: r.updatedAt },
        data: {
          anomalyFlag: fresh.anomalous,
          anomalyBaselinePriorCount: fresh.priorCount,
          anomalyBaselineTCo2e: fresh.baseline,
        },
      });
      if (written.count === 0) {
        skipped.push({ id: r.id, why: 'it changed between the read and the write' });
        return;
      }
      // Its own verb, and a null actor: no person performed this. `update`
      // would put a system re-score in the same bucket as an author changing a
      // figure, and "who changed this number" has to stay answerable.
      await tx.auditLog.create({
        data: {
          userId: null,
          role: null,
          organisationId: r.subsidiary.organisationId,
          action: 'rescore',
          entity: 'activity_record',
          entityId: r.id,
          diff: {
            // `status` and `updatedAt` are recorded so the trail alone proves
            // this tool honoured its own exclusions — otherwise "it never
            // touched a closed record" is unverifiable after the fact.
            before: { ...stored, status: r.status, updatedAt: r.updatedAt.toISOString() },
            after: fresh,
            source: 'anomaly:recompute',
          },
        },
      });
    });
  }

  const rewritten = rewritable.length - skipped.length;
  console.log(
    rewritten === 0
      ? '\nNothing was rewritten.'
      : `\nRewrote ${rewritten} verdict(s), each with a \`rescore\` audit row.`,
  );
  for (const s of skipped) {
    console.log(`  skipped ${s.id} — ${s.why}. Re-run to pick it up.`);
  }
  return exitCodeFor({ stale: stale.length, unrepairable, skipped: skipped.length, applied: true });
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    // Not 2: a usage error means nothing ran, this means the run stopped
    // part-way. Re-running is safe — every write is idempotent against the
    // pool it recomputes — but an operator should know which happened.
    process.exit(3);
  });
