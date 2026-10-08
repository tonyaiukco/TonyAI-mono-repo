import {
  ConflictException,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Prisma, StorageIntentKind } from '@tonyai/db';
import { errorBody } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { captureException } from '../observability/sentry';
import { StorageService } from './storage.service';
import { type Bucket, isBucket, ownedPaths } from './buckets';

/** One object in one bucket. */
export interface ObjectRef {
  bucket: Bucket;
  path: string;
}

/** Who wrote an intent — for operators reading the table, never for access. */
export interface IntentOrigin {
  reason: string;
  organisationId?: string | null;
  subsidiaryId?: string | null;
}

type IntentClient = Pick<Prisma.TransactionClient, 'storageIntent'>;
type EnqueueClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

/**
 * An `upload` intent older than this is abandoned by the sweeper. Its owning
 * transaction runs under LIFECYCLE_TX (15 s), so one this old cannot still
 * commit — and if it tried, adopting the intent would fail and roll it back.
 */
export const UPLOAD_GRACE_SECONDS = 15 * 60;

/** How long one process may hold a claimed intent before another may take it over. */
export const CLAIM_LEASE_SECONDS = 120;

/** The most intents one sweep handles: bounded work per tick, whatever the backlog. */
export const SWEEP_BATCH = 100;

/** An intent that has failed this many times is reported as stuck, on every sweep it stays. */
export const STUCK_AFTER_ATTEMPTS = 5;

/** First retry after 30 s, doubling, capped at 6 h — and never given up. */
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 6 * 3600;

/** Storage caps one remove() at 1,000 keys; stay well under it. */
const REMOVE_CHUNK = 100;

/** `STORAGE_CLEANUP_HOLD` — set while a backup or a restore runs: nothing removes bytes. */
export function removalsHeld(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.STORAGE_CLEANUP_HOLD?.trim() ?? '');
}

/** `STORAGE_SWEEP_INTERVAL_SECONDS` — default 300; 0 turns the in-process sweeper off. */
export function sweepIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STORAGE_SWEEP_INTERVAL_SECONDS?.trim();
  if (!raw) return 300;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 300;
}

/**
 * The owning row's transaction found its upload intent gone: the sweeper took
 * it (the upload outlived `UPLOAD_GRACE_SECONDS`), so its object is being
 * removed and no row may point at it. A 409 — the caller retries — not a 5xx:
 * nothing is down, and a 5xx would page whoever watches the error rate.
 */
export class UploadExpiredError extends ConflictException {
  constructor() {
    super(errorBody('upload_expired', 'The upload took too long and was discarded. Upload the file again.'));
  }
}

/**
 * Removal refused: this database role cannot see every row of the tables that
 * own objects, so "no row owns this object" would be a guess — under a role
 * RLS filters, every object looks like an orphan (`security-rls`, LP1-02).
 */
export class RowsHiddenError extends Error {
  constructor() {
    super(
      'Storage removal refused: this database role cannot see every row of evidence, import_batches and storage.objects (it needs BYPASSRLS, ownership of the tables, or tables without RLS). Run it as the API\'s runtime role, tonyai_runtime (LP1-03).',
    );
    this.name = 'RowsHiddenError';
  }
}

export interface Backlog {
  /** Uploads whose owning row is not committed yet — normally a handful, in flight. */
  uploads: number;
  /** Objects committed to removal and not yet confirmed gone. */
  deletes: number;
  /** Intents that failed `STUCK_AFTER_ATTEMPTS` times or more. */
  stuck: number;
  oldest: Date | null;
}

export interface SweepReport {
  held: boolean;
  /** Upload intents past their grace, turned into deletes. */
  abandoned: number;
  /** Objects removed, intents closed. */
  removed: number;
  /** Removals that failed in this sweep; retried with backoff. */
  failed: number;
  /** Intents closed WITHOUT removing, because a row owns the object. */
  kept: number;
  backlog: Backlog;
}

interface ClaimedIntent {
  id: string;
  bucket: string;
  objectPath: string;
  attempts: number;
  /** The lease this claim set, as the database's own text (microseconds): the close is conditional on it. */
  lease: string;
}

interface Outcome {
  removed: number;
  failed: number;
  kept: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Database ↔ Storage effects that survive a failure at any boundary (LP1-02,
 * F14). Storage has no transaction, so the database records what it has
 * committed to and this service carries it out, retrying until Storage
 * confirms:
 *
 *  - UPLOAD: `beginUpload` commits an `upload` intent BEFORE the bytes go up;
 *    the transaction that writes the owning row calls `adoptUpload`, which
 *    deletes it. If that transaction fails, `abandonUpload` turns the intent
 *    into a delete — but only while it is still an upload, so a transaction
 *    that DID commit (its acknowledgement lost) keeps its object. A crash in
 *    between leaves the intent for the sweeper, which abandons uploads older
 *    than `UPLOAD_GRACE_SECONDS`.
 *  - DELETE: `enqueueDeletes` writes a `delete` intent in the same transaction
 *    as the row delete and its audit row; after the commit `runNow` removes
 *    the object and closes the intent. A failure, or a crash before it, leaves
 *    the intent for the sweeper.
 *
 * Removal is by lease (`claimed_until`), so no transaction is held across a
 * Storage call and two processes never remove the same object at once; a
 * failed removal is released with exponential backoff and retried forever,
 * and one that keeps failing is reported as stuck. Bytes a row still owns are
 * never removed (`ownedPaths`), whatever an intent says. While
 * `STORAGE_CLEANUP_HOLD` is set nothing is removed at all — intents wait.
 *
 * The sweeper runs in-process every `STORAGE_SWEEP_INTERVAL_SECONDS` (each
 * replica; the lease keeps them apart). `pnpm storage:reconcile` covers what
 * no intent records: orphans and rows whose bytes are missing.
 */
@Injectable()
export class StorageIntentsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StorageIntentsService.name);
  private interval: NodeJS.Timeout | null = null;
  private firstTick: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastStuck = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // --- The writer's side ------------------------------------------------------

  /** Commit an `upload` intent, on its own, before the bytes are sent. Returns its id for `adoptUpload`. */
  async beginUpload(ref: ObjectRef, origin: IntentOrigin): Promise<string> {
    const { id } = await this.prisma.storageIntent.create({
      data: { kind: StorageIntentKind.upload, bucket: ref.bucket, objectPath: ref.path, ...origin },
      select: { id: true },
    });
    return id;
  }

  /**
   * In the transaction that writes the row owning the object: the row takes
   * the object over. Refused when the sweeper got there first — the delete it
   * made of the intent is already on its way, so no row may point at it.
   */
  async adoptUpload(tx: IntentClient, intentId: string): Promise<void> {
    const { count } = await tx.storageIntent.deleteMany({
      where: { id: intentId, kind: StorageIntentKind.upload },
    });
    if (count !== 1) throw new UploadExpiredError();
  }

  /**
   * After the owning transaction failed with `cause`. If the intent is still
   * an upload, no row was committed and the object goes now. If it is gone,
   * either the transaction committed after all — its acknowledgement was lost
   * — and the object stays with its row; or the sweeper abandoned it first,
   * which is certain when `cause` is this request's own failed adoption
   * (`UploadExpiredError`): then the transaction rolled back, and bytes that
   * landed AFTER the sweeper's removal are removed again. Never throws: what
   * it cannot do, the sweeper does.
   */
  async abandonUpload(
    intentId: string,
    ref: ObjectRef,
    cause?: unknown,
    origin: Omit<IntentOrigin, 'reason'> = {},
  ): Promise<void> {
    try {
      const { count } = await this.prisma.storageIntent.updateMany({
        where: { id: intentId, kind: StorageIntentKind.upload },
        // Its next_attempt_at is its creation time, already past: due at
        // once. Never stamped from this process's clock.
        data: { kind: StorageIntentKind.delete },
      });
      if (count === 0 && cause instanceof UploadExpiredError) {
        await this.enqueueDeletes(this.prisma, [ref], { reason: 'upload.expired', ...origin });
      }
      if (count === 1 || cause instanceof UploadExpiredError) await this.runNow([ref]);
    } catch (error) {
      this.logger.error(
        `Could not abandon the upload of ${ref.bucket}/${ref.path}; the sweeper removes it after ${UPLOAD_GRACE_SECONDS / 60} minutes`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * In the transaction that deleted the rows owning these objects: record
   * that the objects must go. An object that already has a `delete` intent
   * gets that one reset — due now, its lease cleared — rather than a second:
   * the existing one may belong to a sweep whose removal ran BEFORE bytes
   * landed, and whose close would otherwise swallow this request (`qa-auditor`,
   * measured). The sweep's close is conditional on its own lease, so a reset
   * intent survives it and is removed again.
   */
  async enqueueDeletes(tx: EnqueueClient, refs: ObjectRef[], origin: IntentOrigin): Promise<void> {
    for (const [bucket, paths] of groupPaths(refs)) {
      await tx.$executeRaw`
        INSERT INTO storage_intents (id, kind, bucket, object_path, reason, organisation_id, subsidiary_id)
        SELECT gen_random_uuid(), 'delete', ${bucket}, path, ${origin.reason},
               ${origin.organisationId ?? null}::uuid, ${origin.subsidiaryId ?? null}::uuid
        FROM unnest(${[...new Set(paths)]}::text[]) AS path
        ON CONFLICT (bucket, object_path) DO UPDATE
          SET claimed_until = NULL, next_attempt_at = now()
          WHERE storage_intents.kind = 'delete'`;
    }
  }

  /**
   * After the commit: remove these objects now and close their intents.
   * Never throws — the change they belong to has happened; a failure stays an
   * intent, retried by the sweeper.
   */
  async runNow(refs: ObjectRef[]): Promise<void> {
    if (refs.length === 0) return;
    if (removalsHeld()) {
      this.logger.warn(
        `STORAGE_CLEANUP_HOLD is set: ${refs.length} object(s) wait for removal as intents`,
      );
      return;
    }
    try {
      for (const [bucket, paths] of groupPaths(refs)) {
        const claimed = await this.claim(
          Prisma.sql`bucket = ${bucket} AND object_path = ANY(${paths}::text[])`,
          paths.length,
        );
        await this.execute(claimed);
      }
    } catch (error) {
      this.logger.error(
        `Could not remove ${refs.length} object(s) after the commit; their intents stay for the sweeper: ${refs
          .map((r) => `${r.bucket}/${r.path}`)
          .join(', ')}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  // --- The sweeper ------------------------------------------------------------

  /**
   * One bounded pass: abandon uploads past their grace, then remove the due
   * deletes — at most `limit` of each — and report the backlog left.
   */
  async sweep(limit = SWEEP_BATCH): Promise<SweepReport> {
    const held = removalsHeld();
    let abandoned = 0;
    let outcome: Outcome = { removed: 0, failed: 0, kept: 0 };
    if (!held) {
      abandoned = await this.abandonStale(limit);
      outcome = await this.execute(await this.claim(Prisma.sql`next_attempt_at <= now()`, limit));
    }
    const backlog = await this.backlog();
    const report: SweepReport = { held, abandoned, ...outcome, backlog };
    this.reportSweep(report);
    return report;
  }

  /**
   * Whether the role `client` runs as sees every row of the tables that own
   * objects and of Storage's catalogue: a superuser, a BYPASSRLS role, the
   * table's owner (unless the table FORCEs RLS), or a table without RLS.
   * Asked before any removal, in the SAME transaction as the owned-bytes
   * read it vouches for — a pooled connection can carry another role, so a
   * check on one connection says nothing about a read on the next. Never
   * cached, for the same reason and because a role can lose BYPASSRLS
   * mid-process. Membership of an owning role does not count: that fails
   * closed.
   */
  async seesEveryRow(client: Pick<Prisma.TransactionClient, '$queryRaw'> = this.prisma): Promise<boolean> {
    const [{ ok }] = await client.$queryRaw<{ ok: boolean | null }[]>`
      SELECT bool_and(
               r.rolsuper
               OR r.rolbypassrls
               OR (c.relowner = r.oid AND NOT c.relforcerowsecurity)
               OR NOT c.relrowsecurity
             ) AS ok
      FROM pg_roles r
      CROSS JOIN pg_class c
      WHERE r.rolname = current_user
        AND c.oid IN ('public.evidence'::regclass, 'public.import_batches'::regclass, 'storage.objects'::regclass)`;
    return ok === true;
  }

  /**
   * Turn up to `limit` upload intents past their grace into deletes; returns
   * how many. Part of `sweep`, on its own so its bound can be pinned.
   */
  async abandonStale(limit = SWEEP_BATCH): Promise<number> {
    // An upload intent this old belongs to a transaction that cannot still
    // commit. SKIP LOCKED passes over one an owning transaction is adopting
    // right now; if that transaction then rolls back, the next sweep takes it.
    // A MATERIALIZED CTE, not `WHERE id IN (SELECT … LIMIT n)`: a plan that
    // rescans that subquery skips the rows it already updated and takes n
    // MORE each time, so the LIMIT bounded nothing (`qa-auditor`, measured:
    // 5 claimed under LIMIT 2). A CTE is scanned once.
    return this.prisma.$executeRaw`
      WITH stale AS MATERIALIZED (
        SELECT id FROM storage_intents
        WHERE kind = 'upload'
          AND created_at < now() - ${UPLOAD_GRACE_SECONDS}::int * interval '1 second'
        ORDER BY created_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE storage_intents s
      SET kind = 'delete', next_attempt_at = now()
      FROM stale
      WHERE s.id = stale.id`;
  }

  /** What is waiting, for the sweep's log line and `storage:reconcile`. */
  async backlog(): Promise<Backlog> {
    const rows = await this.prisma.$queryRaw<
      { kind: string; n: bigint; stuck: bigint; oldest: Date | null }[]
    >`
      SELECT kind::text AS kind,
             count(*) AS n,
             count(*) FILTER (WHERE attempts >= ${STUCK_AFTER_ATTEMPTS}::int) AS stuck,
             min(created_at) AS oldest
      FROM storage_intents
      GROUP BY kind`;
    const backlog: Backlog = { uploads: 0, deletes: 0, stuck: 0, oldest: null };
    for (const row of rows) {
      if (row.kind === 'upload') backlog.uploads = Number(row.n);
      else backlog.deletes = Number(row.n);
      backlog.stuck += Number(row.stuck);
      if (row.oldest && (!backlog.oldest || row.oldest < backlog.oldest)) backlog.oldest = row.oldest;
    }
    return backlog;
  }

  onApplicationBootstrap(): void {
    const seconds = sweepIntervalSeconds();
    if (seconds === 0) {
      this.logger.warn('The storage sweeper is off (STORAGE_SWEEP_INTERVAL_SECONDS=0); run pnpm storage:reconcile --sweep');
      return;
    }
    // The first pass soon after boot — a replica scaled up from zero should
    // not wait a whole interval — jittered so replicas do not start together.
    this.firstTick = setTimeout(() => void this.tick(), 10_000 + Math.random() * 30_000);
    this.firstTick.unref();
    this.interval = setInterval(() => void this.tick(), seconds * 1000);
    this.interval.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.firstTick) clearTimeout(this.firstTick);
    if (this.interval) clearInterval(this.interval);
    await this.running;
  }

  /** One sweep at a time per process; an error is logged and the next tick tries again. */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = this.sweep()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error('Storage sweep failed', error instanceof Error ? error.stack : String(error));
      })
      .finally(() => {
        this.running = null;
      });
    await this.running;
  }

  private reportSweep(report: SweepReport): void {
    const { held, abandoned, removed, failed, kept, backlog } = report;
    const summary =
      `Storage sweep: removed ${removed}, failed ${failed}, kept ${kept}, abandoned ${abandoned}; ` +
      `waiting ${backlog.deletes} delete(s), ${backlog.uploads} upload(s), ${backlog.stuck} stuck` +
      (backlog.oldest ? `, oldest ${backlog.oldest.toISOString()}` : '');
    if (held && backlog.deletes + backlog.uploads > 0) {
      this.logger.warn(`STORAGE_CLEANUP_HOLD is set, nothing removed. ${summary}`);
    } else if (failed > 0 || kept > 0) {
      this.logger.error(summary);
    } else if (removed + abandoned + backlog.deletes > 0) {
      this.logger.log(summary);
    }
    // Stuck intents page an operator — once per change, not once per tick.
    if (backlog.stuck > 0 && backlog.stuck !== this.lastStuck) {
      const error = new Error(
        `${backlog.stuck} storage intent(s) have failed ${STUCK_AFTER_ATTEMPTS} or more times; see storage_intents.last_error`,
      );
      this.logger.error(error.message);
      captureException(error);
    }
    this.lastStuck = backlog.stuck;
  }

  // --- Execution --------------------------------------------------------------

  /**
   * Take a lease on up to `limit` delete intents matching `filter`. A short
   * statement of its own, so no transaction stays open across the Storage
   * call; SKIP LOCKED and the lease keep two processes off one intent.
   */
  private claim(filter: Prisma.Sql, limit: number): Promise<ClaimedIntent[]> {
    // MATERIALIZED for the bound — see the abandon statement in `sweep`.
    return this.prisma.$queryRaw<ClaimedIntent[]>`
      WITH due AS MATERIALIZED (
        SELECT id FROM storage_intents
        WHERE kind = 'delete'
          AND (claimed_until IS NULL OR claimed_until < now())
          AND ${filter}
        ORDER BY next_attempt_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE storage_intents s
      SET claimed_until = now() + ${CLAIM_LEASE_SECONDS}::int * interval '1 second',
          attempts = s.attempts + 1
      FROM due
      WHERE s.id = due.id
      RETURNING s.id, s.bucket, s.object_path AS "objectPath", s.attempts, s.claimed_until::text AS lease`;
  }

  private async execute(claimed: ClaimedIntent[]): Promise<Outcome> {
    const outcome: Outcome = { removed: 0, failed: 0, kept: 0 };
    if (claimed.length === 0) return outcome;
    const byBucket = new Map<string, ClaimedIntent[]>();
    for (const intent of claimed) {
      byBucket.set(intent.bucket, [...(byBucket.get(intent.bucket) ?? []), intent]);
    }
    for (const [bucket, intents] of byBucket) {
      if (!isBucket(bucket)) {
        await this.release(intents, `Unknown bucket "${bucket}"`);
        outcome.failed += intents.length;
        continue;
      }
      let owned: Set<string>;
      try {
        // One short read-only transaction: the visibility check and the read
        // it vouches for share a connection, and so a role. Fail closed —
        // under a role RLS filters every object would read as unowned; the
        // intents go back untouched and wait for a role that sees.
        owned = await this.prisma.$transaction(async (tx) => {
          if (!(await this.seesEveryRow(tx))) throw new RowsHiddenError();
          return ownedPaths(tx, bucket, intents.map((i) => i.objectPath));
        });
      } catch (error) {
        if (!(error instanceof RowsHiddenError)) throw error;
        await this.release(intents, error.message);
        this.logger.error(error.message);
        captureException(error);
        outcome.failed += intents.length;
        continue;
      }
      const keep = intents.filter((i) => owned.has(i.objectPath));
      if (keep.length > 0) {
        // Unreachable under the protocol — an upload intent is adopted in its
        // row's own transaction, a delete intent is written as its row goes —
        // so a row and an intent disagree. The bytes stay; the intent is
        // closed and reported.
        await this.closeUnderLease(keep);
        // Keys carry a cleaned file name, which can be personal data: the log
        // line names them for an operator, the Sentry event only the intents.
        this.logger.error(
          `${keep.length} storage intent(s) named objects a row still owns; the objects were kept: ${keep
            .map((i) => `${bucket}/${i.objectPath}`)
            .join(', ')}`,
        );
        captureException(
          new Error(
            `${keep.length} storage intent(s) named objects a row still owns; kept. Intents: ${keep.map((i) => i.id).join(', ')}`,
          ),
        );
        outcome.kept += keep.length;
      }
      const remove = intents.filter((i) => !owned.has(i.objectPath));
      for (let start = 0; start < remove.length; start += REMOVE_CHUNK) {
        const chunk = remove.slice(start, start + REMOVE_CHUNK);
        try {
          await this.storage.remove(bucket, chunk.map((i) => i.objectPath));
        } catch (error) {
          await this.release(chunk, message(error));
          outcome.failed += chunk.length;
          this.logger.error(
            `Could not remove ${chunk.length} ${bucket} object(s), retried with backoff: ${chunk
              .map((i) => `${i.objectPath} (attempt ${i.attempts})`)
              .join(', ')}`,
            error instanceof Error ? error.stack : String(error),
          );
          continue;
        }
        // Storage confirmed. Closed only while still under THIS claim's lease:
        // an intent reset meanwhile (`enqueueDeletes`) names bytes that may
        // have landed after the removal, and stays. If closing fails, the
        // lease runs out and the next sweep removes again — idempotently.
        await this.closeUnderLease(chunk);
        outcome.removed += chunk.length;
      }
    }
    return outcome;
  }

  /**
   * Close intents only while they are still under the lease this claim set:
   * one reset meanwhile (`enqueueDeletes`) names bytes that may have landed
   * after the removal, and stays for the next pass.
   */
  private async closeUnderLease(intents: ClaimedIntent[]): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM storage_intents s
      USING unnest(${intents.map((i) => i.id)}::uuid[], ${intents.map((i) => i.lease)}::timestamptz[]) AS c(id, lease)
      WHERE s.id = c.id AND s.claimed_until = c.lease`;
  }

  /** Give a failed removal back with its error and the next attempt's time. */
  private async release(intents: ClaimedIntent[], error: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE storage_intents
      SET claimed_until = NULL,
          last_error = ${error.slice(0, 1000)},
          next_attempt_at = now() + LEAST(
            ${BACKOFF_BASE_SECONDS}::int * power(2, LEAST(GREATEST(attempts - 1, 0), 20)),
            ${BACKOFF_MAX_SECONDS}::int
          ) * interval '1 second'
      WHERE id = ANY(${intents.map((i) => i.id)}::uuid[])`;
  }
}

function groupPaths(refs: ObjectRef[]): Map<Bucket, string[]> {
  const groups = new Map<Bucket, string[]>();
  for (const ref of refs) groups.set(ref.bucket, [...(groups.get(ref.bucket) ?? []), ref.path]);
  return groups;
}
