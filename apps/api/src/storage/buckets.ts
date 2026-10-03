import type { PrismaClient } from '@tonyai/db';

/** Private bucket of evidence files; each object is owned by one `evidence` row. */
export const EVIDENCE_BUCKET = 'evidence';

/** Private bucket of applied imports' source files; each object is owned by one `import_batches` row. */
export const IMPORT_SOURCES_BUCKET = 'import-sources';

export const BUCKETS = [EVIDENCE_BUCKET, IMPORT_SOURCES_BUCKET] as const;
export type Bucket = (typeof BUCKETS)[number];

export function isBucket(value: string): value is Bucket {
  return (BUCKETS as readonly string[]).includes(value);
}

type OwnerClient = Pick<PrismaClient, 'evidence' | 'importBatch'>;

/**
 * The table that owns each bucket's objects, as a lookup of the paths it
 * holds. A `Record` over every bucket, so a new bucket does not compile until
 * it names its owner — a bucket checked against the wrong table would read as
 * unowned, and its objects would be removed.
 */
const OWNED: Record<Bucket, (client: OwnerClient, paths: string[]) => Promise<(string | null)[]>> = {
  [EVIDENCE_BUCKET]: async (client, paths) =>
    (await client.evidence.findMany({ where: { storagePath: { in: paths } }, select: { storagePath: true } })).map(
      (r) => r.storagePath,
    ),
  [IMPORT_SOURCES_BUCKET]: async (client, paths) =>
    (await client.importBatch.findMany({ where: { storagePath: { in: paths } }, select: { storagePath: true } })).map(
      (r) => r.storagePath,
    ),
};

/**
 * Which of `paths` a row still points at. The one question asked before any
 * object is removed: bytes a row owns are never deleted, whatever an intent or
 * a reconciliation run says.
 */
export async function ownedPaths(
  client: OwnerClient,
  bucket: Bucket,
  paths: string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const owned = await OWNED[bucket](client, paths);
  return new Set(owned.filter((p): p is string => p !== null));
}
