import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@tonyai/db';
import { PrismaService } from '../prisma/prisma.service';
import { EVIDENCE_BUCKET, type Bucket } from './buckets';
import { StorageObjectMissingError, StorageService } from './storage.service';
import { StorageIntentsService, removalsHeld } from './storage-intents.service';

/** An object in a bucket that no row owns and no intent names. */
export interface OrphanObject {
  bucket: Bucket;
  path: string;
  createdAt: Date;
  sizeBytes: number | null;
}

/** A row whose bytes Storage does not hold — or holds, changed. Always for a person; never tidied away. */
export interface MissingBytes {
  bucket: Bucket;
  /** `evidence.id` or `import_batches.id`. */
  rowId: string;
  path: string;
  problem: 'no-object' | 'hash-mismatch';
  /** For evidence: the records the file backs, so an approved one is visible at a glance. */
  records?: { id: string; status: string }[];
}

export interface Page {
  limit: number;
  /** Keyset cursor: the last `path` (orphans) or row id (rows) of the previous page. */
  after?: string;
  /** Only objects whose key starts with this — one tenant's subsidiary or organisation. */
  prefix?: string;
}

/** The SQL that differs between the buckets: which table owns its objects. */
const OWNERS: Record<Bucket, { owned: Prisma.Sql; rows: Prisma.Sql }> = {
  evidence: {
    owned: Prisma.sql`EXISTS (SELECT 1 FROM evidence e WHERE e.storage_path = o.name)`,
    rows: Prisma.sql`SELECT e.id, e.storage_path AS path, e.sha256 FROM evidence e`,
  },
  'import-sources': {
    owned: Prisma.sql`EXISTS (SELECT 1 FROM import_batches b WHERE b.storage_path = o.name)`,
    rows: Prisma.sql`SELECT b.id, b.storage_path AS path, b.sha256 FROM import_batches b WHERE b.storage_path IS NOT NULL`,
  },
  // LP3-04 PR D: an issuance's sha256 is its stored PDF's, so `--verify` hashes it.
  'report-artifacts': {
    owned: Prisma.sql`EXISTS (SELECT 1 FROM report_issuances r WHERE r.storage_path = o.name)`,
    rows: Prisma.sql`SELECT r.id, r.storage_path AS path, r.sha256 FROM report_issuances r`,
  },
};

/**
 * What no intent records (LP1-02, F14): the two directions in which the
 * database and Storage can disagree, found by comparing them — for
 * `pnpm storage:reconcile`, never on a request path.
 *
 *  - ORPHANS — objects no row owns and no intent names: an upload from before
 *    intents existed, a cascade below the API, a database restored to a point
 *    before the object was written. Reported; removed only by `reclaimOrphans`,
 *    which an operator runs, past an age threshold, and never while
 *    `STORAGE_CLEANUP_HOLD` is set — after a restore those bytes may be the
 *    only copy of something the restored database no longer remembers.
 *  - MISSING BYTES — rows whose object is gone (`missingObjects`, against
 *    Storage's catalogue) or whose bytes no longer hash to the stored sha256
 *    (`verifyHashes`, which downloads them: the catalogue can name an object
 *    whose bytes a restore did not bring back). Reported, never deleted: a row
 *    is the record that the file existed, and an approved record's only
 *    evidence going missing is an incident for a person.
 *
 * Every query is keyset-paged and bounded by `limit`. Storage's catalogue is
 * the `storage.objects` table in this same database, read through two pinned
 * SECURITY DEFINER functions in `public` (`storage_catalogue_page`,
 * `storage_catalogue_has`): the runtime role (`tonyai_runtime`, LP1-03) holds
 * no USAGE on Supabase's `storage` schema, whose own helper functions would
 * run a caller's temporary types as Storage's owner.
 */
@Injectable()
export class StorageReconcileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly intents: StorageIntentsService,
  ) {}

  /** Objects no row owns and no intent names, older than `olderThanHours`, in key order. */
  async orphans(bucket: Bucket, page: Page, olderThanHours = 0): Promise<OrphanObject[]> {
    const found: OrphanObject[] = [];
    let after = page.after ?? '';
    // A page of the catalogue's keys at a time, each judged in the same
    // statement; the next page starts after the last key SCANNED, owned or
    // not, so the walk ends with the bucket and never repeats a key. Ordered
    // by the row's place in the page — the order of the column's own
    // collation, the one the reader's cursor compares in.
    for (;;) {
      const rows = await this.prisma.$queryRaw<
        { name: string; created_at: Date; size: bigint | null; orphan: boolean }[]
      >`
        SELECT o.name, o.created_at, o.size_bytes AS size,
               NOT ${OWNERS[bucket].owned}
                 AND NOT EXISTS (
                   SELECT 1 FROM storage_intents i WHERE i.bucket = ${bucket} AND i.object_path = o.name
                 ) AS orphan
        FROM storage_catalogue_page(
               ${bucket}, ${page.prefix ?? ''}, ${after},
               now() - ${olderThanHours}::float8 * interval '1 hour', ${page.limit}::integer
             ) WITH ORDINALITY AS o (name, created_at, size_bytes, n)
        ORDER BY o.n`;
      for (const r of rows) {
        if (!r.orphan || found.length === page.limit) continue;
        found.push({
          bucket,
          path: r.name,
          createdAt: r.created_at,
          sizeBytes: r.size === null ? null : Number(r.size),
        });
      }
      if (found.length === page.limit || rows.length < page.limit) return found;
      after = rows[rows.length - 1].name;
    }
  }

  /** Rows whose object is absent from Storage's catalogue, in id order. */
  async missingObjects(bucket: Bucket, page: Page): Promise<MissingBytes[]> {
    // Paged on the uuid itself, so the primary key orders it — not on its text.
    const rows = await this.prisma.$queryRaw<{ id: string; path: string }[]>`
      SELECT r.id::text AS id, r.path FROM (${OWNERS[bucket].rows}) r
      WHERE (${page.after ?? null}::uuid IS NULL OR r.id > ${page.after ?? null}::uuid)
        AND NOT storage_catalogue_has(${bucket}, r.path)
      ORDER BY r.id
      LIMIT ${page.limit}`;
    return this.withRecords(
      bucket,
      rows.map((r) => ({ bucket, rowId: r.id, path: r.path, problem: 'no-object' as const })),
    );
  }

  /**
   * Download and hash up to `limit` rows that carry a sha256, in id order:
   * finds bytes that are gone behind a catalogue entry, and bytes that
   * changed. Rows from before LP1-02 have no hash and are skipped.
   */
  async verifyHashes(
    bucket: Bucket,
    page: Page,
  ): Promise<{ checked: number; last: string | null; problems: MissingBytes[] }> {
    const rows = await this.prisma.$queryRaw<{ id: string; path: string; sha256: string }[]>`
      SELECT r.id::text AS id, r.path, r.sha256 FROM (${OWNERS[bucket].rows}) r
      WHERE r.sha256 IS NOT NULL
        AND (${page.after ?? null}::uuid IS NULL OR r.id > ${page.after ?? null}::uuid)
      ORDER BY r.id
      LIMIT ${page.limit}`;
    const problems: MissingBytes[] = [];
    for (const row of rows) {
      let bytes: Buffer;
      try {
        bytes = await this.storage.download(bucket, row.path);
      } catch (error) {
        if (!(error instanceof StorageObjectMissingError)) throw error;
        problems.push({ bucket, rowId: row.id, path: row.path, problem: 'no-object' });
        continue;
      }
      if (createHash('sha256').update(bytes).digest('hex') !== row.sha256.trim()) {
        problems.push({ bucket, rowId: row.id, path: row.path, problem: 'hash-mismatch' });
      }
    }
    return {
      checked: rows.length,
      last: rows.at(-1)?.id ?? null,
      problems: await this.withRecords(bucket, problems),
    };
  }

  /**
   * Evidence rows no record links to. The API never commits one (a file goes
   * with its last link, in the same transaction), so each is a defect or a
   * change made below the API. Reported, not deleted: deleting a file is an
   * audited mutation, which a reconciliation tool does not make.
   */
  async unlinkedEvidence(page: Page): Promise<{ id: string; path: string }[]> {
    const rows = await this.prisma.evidence.findMany({
      where: { links: { none: {} }, ...(page.after ? { id: { gt: page.after } } : {}) },
      select: { id: true, storagePath: true },
      orderBy: { id: 'asc' },
      take: page.limit,
    });
    return rows.map((r) => ({ id: r.id, path: r.storagePath }));
  }

  /**
   * Remove orphans older than `olderThanHours`: each becomes a `delete`
   * intent (reason `reconcile.orphan`) and is removed through the same
   * guarded path as every other removal — which checks again that no row
   * owns it. Refused while `STORAGE_CLEANUP_HOLD` is set.
   */
  async reclaimOrphans(
    bucket: Bucket,
    olderThanHours: number,
    limit: number,
    prefix?: string,
  ): Promise<{ reclaimed: OrphanObject[] }> {
    if (removalsHeld()) {
      throw new Error(
        'STORAGE_CLEANUP_HOLD is set: orphans are not reclaimed while a backup or restore runs.',
      );
    }
    const orphans = await this.orphans(bucket, { limit, prefix }, olderThanHours);
    if (orphans.length === 0) return { reclaimed: [] };
    const refs = orphans.map((o) => ({ bucket, path: o.path }));
    await this.intents.enqueueDeletes(this.prisma, refs, { reason: 'reconcile.orphan' });
    await this.intents.runNow(refs);
    return { reclaimed: orphans };
  }

  /**
   * After a database restore, before `STORAGE_CLEANUP_HOLD` is lifted: forget
   * every `upload` intent. One restored from the restore point names an upload
   * that was in flight then — and committed later, in the history the restore
   * discarded — so its bytes may be the only copy of a file nothing remembers
   * now. Left alone, the sweeper would abandon it and remove those bytes;
   * forgotten, the object becomes an orphan, reported and judged by a person
   * (K5). Refused unless the hold is set, so it cannot race live uploads.
   */
  async forgetUploadIntents(): Promise<{ bucket: string; path: string }[]> {
    if (!removalsHeld()) {
      throw new Error('--forget-uploads is for a restore: set STORAGE_CLEANUP_HOLD first, on every API process too.');
    }
    const forgotten = await this.prisma.$queryRaw<{ bucket: string; path: string }[]>`
      DELETE FROM storage_intents WHERE kind = 'upload' RETURNING bucket, object_path AS path`;
    return forgotten;
  }

  private async withRecords(bucket: Bucket, found: MissingBytes[]): Promise<MissingBytes[]> {
    if (bucket !== EVIDENCE_BUCKET || found.length === 0) return found;
    const links = await this.prisma.activityRecordEvidence.findMany({
      where: { evidenceId: { in: found.map((f) => f.rowId) } },
      select: { evidenceId: true, activityRecord: { select: { id: true, status: true } } },
    });
    return found.map((f) => ({
      ...f,
      records: links
        .filter((l) => l.evidenceId === f.rowId)
        .map((l) => ({ id: l.activityRecord.id, status: l.activityRecord.status })),
    }));
  }
}
