/**
 * `pnpm storage:reconcile` — the database ↔ Storage reconciliation (LP1-02).
 * Replaces `pnpm evidence:reclaim`, which deleted unlinked evidence rows
 * without an audit row, ignored the import-sources bucket and could remove an
 * in-flight upload's object.
 *
 * Usage (from the repository root; arguments after the script name):
 *
 *   pnpm storage:reconcile                       # report only
 *   pnpm storage:reconcile --verify              # + download and hash rows that carry a sha256
 *   pnpm storage:reconcile --sweep               # + one sweep of pending intents now
 *   pnpm storage:reconcile --reclaim-orphans     # + list orphans old enough to reclaim (dry run)
 *   pnpm storage:reconcile --reclaim-orphans --apply [--older-than=168]
 *   pnpm storage:reconcile --forget-uploads      # after a DB restore, under the hold (see below)
 *
 *   --bucket=evidence|import-sources   one bucket (default: both)
 *   --limit=<n>                        rows/objects per check (default 500); a list that
 *                                      reaches it says `truncated: true`
 *   --allow-remote                     required for --sweep, --apply or --forget-uploads off a
 *                                      loopback host — a guard against a typo, not a control: a
 *                                      tunnel to production is "localhost" too. Off loopback,
 *                                      --older-than cannot go below 24 hours.
 *
 * Prints one JSON report. Exit code 0 when nothing needs a person; 1 when a
 * row's bytes are missing or changed, an unlinked evidence row exists, or an
 * intent is stuck; 2 on a usage error or a failure. Orphans alone do not fail
 * the run — they are what --reclaim-orphans is for.
 *
 * Orphans are never removed while STORAGE_CLEANUP_HOLD is set, nor younger
 * than --older-than hours (default 7 days): after a database restore, an
 * object newer than the restore point is an orphan that may be the only copy
 * of a file the restored database no longer remembers.
 *
 * After a database restore: set STORAGE_CLEANUP_HOLD on every API process AND
 * in the shell running this tool (the hold is per process), run
 * `--forget-uploads` (upload intents restored from the restore point name
 * bytes that may be the only copy of a file — forgotten, they become reported
 * orphans), then `--verify`, and lift the hold only after reading the report.
 *
 * Refuses to run at all under a database role that cannot see every row of
 * evidence, import_batches and storage.objects: its "orphans" would be every
 * object, and its "missing" every row.
 *
 * In the API image: `node dist/storage/reconcile.cli.js [flags]`.
 */
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BUCKETS, type Bucket, isBucket } from './buckets';
import { StorageService } from './storage.service';
import { RowsHiddenError, StorageIntentsService, removalsHeld } from './storage-intents.service';
import { StorageReconcileService } from './storage-reconcile.service';

const DEFAULT_LIMIT = 500;
const DEFAULT_ORPHAN_AGE_HOURS = 7 * 24;
/** Off a loopback host, an orphan younger than this is never reclaimed, whatever --older-than says. */
export const REMOTE_MIN_ORPHAN_AGE_HOURS = 24;

export interface Options {
  buckets: Bucket[];
  limit: number;
  verify: boolean;
  sweep: boolean;
  reclaim: boolean;
  apply: boolean;
  forgetUploads: boolean;
  olderThanHours: number;
  allowRemote: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string | true>();
  for (const arg of argv) {
    if (arg === '--') continue;
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new UsageError(`Unknown argument "${arg}"`);
    flags.set(match[1], match[2] ?? true);
  }
  const known = [
    'bucket',
    'limit',
    'verify',
    'sweep',
    'reclaim-orphans',
    'apply',
    'older-than',
    'allow-remote',
    'forget-uploads',
  ];
  const valued = ['bucket', 'limit', 'older-than'];
  for (const [name, value] of flags) {
    if (!known.includes(name)) throw new UsageError(`Unknown flag --${name}`);
    // `--verify=no` must not verify, and `--older-than=` must not mean 0.
    if (!valued.includes(name) && value !== true) throw new UsageError(`--${name} takes no value`);
    if (valued.includes(name) && (value === true || value.trim() === '')) {
      throw new UsageError(`--${name} needs a value: --${name}=<value>`);
    }
  }
  const number = (name: string, fallback: number, min: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      throw new UsageError(`--${name} needs a whole number of at least ${min}`);
    }
    return value;
  };
  const bucket = flags.get('bucket');
  if (bucket !== undefined && (bucket === true || !isBucket(bucket))) {
    throw new UsageError(`--bucket must be one of: ${BUCKETS.join(', ')}`);
  }
  const options: Options = {
    buckets: bucket ? [bucket as Bucket] : [...BUCKETS],
    limit: number('limit', DEFAULT_LIMIT, 1),
    verify: flags.has('verify'),
    sweep: flags.has('sweep'),
    reclaim: flags.has('reclaim-orphans'),
    apply: flags.has('apply'),
    forgetUploads: flags.has('forget-uploads'),
    olderThanHours: number('older-than', DEFAULT_ORPHAN_AGE_HOURS, 0),
    allowRemote: flags.has('allow-remote'),
  };
  if (options.apply && !options.reclaim) {
    throw new UsageError('--apply only applies to --reclaim-orphans');
  }
  return options;
}

/** The run's refusals that depend on where it points, separate from the database work so they can be tested alone. */
export function refuseUnsafe(options: Options, local: boolean): void {
  const mutates = options.sweep || options.apply || options.forgetUploads;
  if (mutates && !local && !options.allowRemote) {
    throw new UsageError(
      '--sweep, --apply and --forget-uploads change Storage or its intents; off a loopback host they need --allow-remote. The service-role key reaches every tenant at once.',
    );
  }
  if (options.apply && !local && options.olderThanHours < REMOTE_MIN_ORPHAN_AGE_HOURS) {
    throw new UsageError(
      `Off a loopback host, --older-than cannot go below ${REMOTE_MIN_ORPHAN_AGE_HOURS} hours: an orphan that young may be an upload still in flight.`,
    );
  }
}

export function isLoopback(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

export async function run(options: Options): Promise<{ report: unknown; needsAPerson: boolean }> {
  refuseUnsafe(options, isLoopback(process.env.DATABASE_URL) && isLoopback(process.env.SUPABASE_URL));
  const prisma = new PrismaService();
  try {
    const storage = new StorageService();
    const intents = new StorageIntentsService(prisma, storage);
    const reconcile = new StorageReconcileService(prisma, storage, intents);
    if (!(await intents.seesEveryRow())) throw new RowsHiddenError();
    const page = { limit: options.limit };
    const forgottenUploads = options.forgetUploads ? await reconcile.forgetUploadIntents() : null;
    const listed = <T>(items: T[]) => ({ count: items.length, truncated: items.length === options.limit, items });

    const sweep = options.sweep ? await intents.sweep(options.limit) : null;
    const buckets: Record<string, unknown> = {};
    let needsAPerson = false;
    for (const bucket of options.buckets) {
      const missing = await reconcile.missingObjects(bucket, page);
      const verified = options.verify ? await reconcile.verifyHashes(bucket, page) : null;
      let orphans = await reconcile.orphans(bucket, page);
      let reclaim: unknown = null;
      if (options.reclaim) {
        if (options.apply) {
          const { reclaimed } = await reconcile.reclaimOrphans(bucket, options.olderThanHours, options.limit);
          // The paths are the run's trail: a reclaimed intent is closed once Storage confirms.
          reclaim = {
            applied: true,
            olderThanHours: options.olderThanHours,
            reclaimed: reclaimed.map((o) => o.path),
          };
          orphans = await reconcile.orphans(bucket, page);
        } else {
          const eligible = await reconcile.orphans(bucket, { limit: options.limit }, options.olderThanHours);
          reclaim = {
            applied: false,
            olderThanHours: options.olderThanHours,
            wouldReclaim: eligible.length,
            held: removalsHeld(),
          };
        }
      }
      const unlinked = bucket === 'evidence' ? await reconcile.unlinkedEvidence(page) : [];
      if (missing.length > 0 || unlinked.length > 0 || (verified?.problems.length ?? 0) > 0) {
        needsAPerson = true;
      }
      buckets[bucket] = {
        rowsMissingObject: listed(missing),
        ...(verified
          ? { verifiedHashes: { checked: verified.checked, truncated: verified.checked === options.limit, problems: verified.problems } }
          : {}),
        orphans: listed(orphans),
        ...(reclaim ? { reclaim } : {}),
        ...(bucket === 'evidence' ? { unlinkedEvidenceRows: listed(unlinked) } : {}),
      };
    }
    const backlog = await intents.backlog();
    if (backlog.stuck > 0) needsAPerson = true;
    return {
      report: {
        held: removalsHeld(),
        limit: options.limit,
        intents: backlog,
        ...(forgottenUploads ? { forgottenUploads } : {}),
        sweep,
        buckets,
      },
      needsAPerson,
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  }
  try {
    const { report, needsAPerson } = await run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(needsAPerson ? 1 : 0);
  } catch (error) {
    new Logger('storage:reconcile').error(
      error instanceof Error ? error.message : String(error),
      error instanceof Error && !(error instanceof UsageError) ? error.stack : undefined,
    );
    process.exit(2);
  }
}

if (require.main === module) void main();
