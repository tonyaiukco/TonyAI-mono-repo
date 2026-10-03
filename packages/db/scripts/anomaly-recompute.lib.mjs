/**
 * The decisions `anomaly-recompute.mjs` makes, separated from the IO it does.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The review of the first cut measured what the script's gates actually were:
 * `packages/db` had no test script, its lint is a stub, and its tsconfig covers
 * `prisma` and `src` but not `scripts` — so ten mutations of the pool-selection
 * logic passed typecheck, lint and (for five of them) the tool's own dry run
 * against the dev database. The most important survivor was widening
 * `REWRITABLE` to include `approved` and `locked`: the "never touch a terminal
 * record" rule this tool is built around was invisible to every gate it had.
 *
 * Everything here is pure and takes plain data, so it can be tested without a
 * database — which is the point. The shell keeps the Prisma calls, the flags
 * and the printing.
 */
import {
  anomalyNotEvaluated,
  computeAnomalyVerdict,
  COUNTED_STATUSES,
  canonicalPeriodValue,
  isCalculated,
  PERIOD_VALUES,
} from '@tonyai/shared-types';

/**
 * Statuses this tool may rewrite. NOT the complement of COUNTED_STATUSES:
 * `submitted` and `under_review` ARE counted and are also still in play — a
 * reviewer can send them back — so a fresh verdict is exactly what their
 * reviewer should be looking at. `voided` is absent for a different reason: a
 * withdrawn figure's verdict is not a claim about anything, so it is never
 * scored at all (see `shouldScore`).
 */
export const REWRITABLE = Object.freeze(['draft', 'rejected', 'submitted', 'under_review']);

/**
 * Far above the ULP difference between Postgres's `avg()` (which wrote the
 * backfilled values) and this codebase's left fold — measured at 3.6e-16
 * relative — and far below any change a moving pool could produce. Comparing by
 * equality reports 33 stale rows on a database with none.
 */
export const BASELINE_TOLERANCE = 1e-9;

/** A withdrawn record holds a verdict about an inventory it is no longer in.
 *  Scoring it produces drift nobody can act on and nothing can clear — the
 *  WP18 shape exactly: void six months of a series and each withdrawn row
 *  loses the others from its own pool, forever. */
export const shouldScore = (status) => status !== 'voided';

/** Position of a period within its year — the service's `periodOrdinal`, over
 *  the same shared vocabulary, so the two order a series identically. */
export function periodOrdinal(reportingPeriod, periodValue) {
  const canonical = canonicalPeriodValue(reportingPeriod, periodValue);
  if (canonical === null) return 0;
  const allowed = PERIOD_VALUES[reportingPeriod] ?? [];
  const i = allowed.indexOf(canonical);
  return reportingPeriod === 'quarterly' ? i + 1 : i;
}

/** The reporting entity + granularity, as one key. JSON rather than a joined
 *  string: `category` and `reporting_period` are plain text columns with no
 *  database constraint, so a separator character inserted by direct SQL would
 *  merge two pools that must never merge. */
export const poolKey = (r) =>
  JSON.stringify([r.subsidiaryId, r.locationId, r.category, r.reportingPeriod]);

/** The lock key, matched the way `assertPeriodNotLocked` matches it: exact
 *  equality on all four columns. */
export const lockKey = (r) =>
  JSON.stringify([r.subsidiaryId, r.reportingYear, r.reportingPeriod, r.periodValue]);

export const sortKey = (r) => r.reportingYear * 100 + periodOrdinal(r.reportingPeriod, r.periodValue);

/** True when two baselines are the same figure. Never equality: see
 *  BASELINE_TOLERANCE. Null is a state, not a number — a verdict that gained or
 *  lost its baseline is always drift. */
export function sameBaseline(a, b) {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= BASELINE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b), 1);
}

/** Group the scoreable records into the pools a verdict is taken against. Only
 *  committed rows seed a baseline. */
export function buildPools(indexed) {
  const pools = new Map();
  for (const item of indexed) {
    if (!COUNTED_STATUSES.includes(item.row.status)) continue;
    const k = poolKey(item.row);
    if (!pools.has(k)) pools.set(k, []);
    pools.get(k).push(item);
  }
  for (const pool of pools.values()) pool.sort((a, b) => b.key - a.key);
  return pools;
}

/** Index a raw record for scoring: its ordinal key and its own figure. */
export const indexRecord = (row) => ({
  row,
  key: sortKey(row),
  tCo2e: isCalculated(row.calculation) ? row.calculation.tCo2e : null,
});

/**
 * The verdict this record would get today. Selecting the pool is this file's
 * job; judging it is `computeAnomalyVerdict`'s, shared with the API so a record
 * re-scored here is bitwise identical to the same record re-saved through it.
 */
export function freshVerdict(item, pools) {
  if (item.tCo2e === null) return anomalyNotEvaluated();
  return computeAnomalyVerdict(
    item.tCo2e,
    (pools.get(poolKey(item.row)) ?? [])
      .filter((p) => p.key < item.key && p.row.id !== item.row.id)
      .map((p) => p.tCo2e),
  );
}

export const storedVerdict = (row) => ({
  anomalous: row.anomalyFlag,
  priorCount: row.anomalyBaselinePriorCount,
  baseline: row.anomalyBaselineTCo2e,
});

export function verdictsAgree(stored, fresh) {
  return (
    stored.anomalous === fresh.anomalous &&
    stored.priorCount === fresh.priorCount &&
    sameBaseline(stored.baseline, fresh.baseline)
  );
}

/**
 * What may be done about a stale record.
 *
 * TWO reasons to refuse, and they are different shapes. `terminal_status` is
 * about the record: an approved or locked figure has already been printed into
 * issued reports. `locked_period` is about the period around it, and it was the
 * gap in the first cut: a `draft` inside a closed period is rewritable BY
 * STATUS, while the API refuses every mutation on it with a 409. The product's
 * immutability boundary is period-shaped; an exclusion that is only
 * status-shaped writes into closed periods with a null actor, which is the
 * shape an auditor reads as tampering.
 */
export function classify(row, lockedPeriods) {
  if (!REWRITABLE.includes(row.status)) return 'terminal_status';
  if (lockedPeriods.has(lockKey(row))) return 'locked_period';
  return 'rewritable';
}

/**
 * Exit codes, in one place because the first cut got the dry-run case wrong:
 * it returned 0 whenever the only stale rows were repairable, so a dry run that
 * found every draft in the system invalidated reported success. A drift check
 * wired to a cron would have read green.
 *
 * 0 — nothing stale, or everything stale was repaired.
 * 1 — drift remains: unrepaired (dry run), refused (terminal or closed period),
 *     or skipped because the row moved mid-run.
 */
export function exitCodeFor({ stale, unrepairable, skipped, applied }) {
  if (!applied) return stale > 0 ? 1 : 0;
  return unrepairable > 0 || skipped > 0 ? 1 : 0;
}

/**
 * Is this DSN pointing at the developer's own machine?
 *
 * Parsed, not pattern-matched. The first cut tested `/@(127\.0\.0\.1|localhost)[:/]/`
 * anywhere in the string, so a password or a query parameter containing
 * `@localhost/` made a remote database read as local. It still would not have
 * saved the case that matters: a production database reached over an SSH tunnel
 * or `kubectl port-forward` IS on 127.0.0.1, which is how a private Azure
 * Postgres is normally reached — so loopback is treated as necessary, never as
 * sufficient, and `--allow-remote` must NAME the host it is allowing.
 */
export function parseHost(url) {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '') || null;
  } catch {
    return null;
  }
}

export const LOOPBACK = Object.freeze(['127.0.0.1', '::1', 'localhost']);
export const isLoopback = (url) => {
  const host = parseHost(url);
  return host !== null && LOOPBACK.includes(host);
};

const FLAGS = ['--apply', '--allow-remote'];

/** Reject what we do not understand. `--aply` used to dry-run silently and exit
 *  0, so a scripted caller could not tell a typo from a successful repair. */
export function parseArgs(argv) {
  // A bare `--` is the conventional end-of-options marker, and `pnpm run x --
  // --apply` forwards it verbatim — it is the form this repo's README documents
  // (`pnpm anomaly:recompute -- --apply`). Rejecting it would refuse that invocation.
  const unknown = argv.filter(
    (a) => a !== '--' && !FLAGS.includes(a) && !a.startsWith('--allow-remote='),
  );
  const allowRemoteHost = argv
    .filter((a) => a.startsWith('--allow-remote='))
    .map((a) => a.slice('--allow-remote='.length))[0];
  return {
    apply: argv.includes('--apply'),
    allowRemote: argv.includes('--allow-remote'),
    allowRemoteHost: allowRemoteHost ?? null,
    unknown,
  };
}
