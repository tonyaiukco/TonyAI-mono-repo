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
  const rows =
    bucket === EVIDENCE_BUCKET
      ? await client.evidence.findMany({
          where: { storagePath: { in: paths } },
          select: { storagePath: true },
        })
      : await client.importBatch.findMany({
          where: { storagePath: { in: paths } },
          select: { storagePath: true },
        });
  return new Set(rows.map((r) => r.storagePath).filter((p): p is string => p !== null));
}
