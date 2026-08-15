#!/usr/bin/env node
/**
 * Reclaim evidence blobs that no `evidence` row points at any more.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Evidence.activityRecord` is `onDelete: Cascade` (schema.prisma), so whenever
 * an activity record goes, Postgres removes the evidence ROWS on its own —
 * below the application, where no code can see it and therefore no code can
 * delete the corresponding objects. Storage is a different system; nothing ever
 * reconciled the two. Measured on a local stack: 1501 objects in the `evidence`
 * bucket against 102 rows.
 *
 * These files are utility invoices. Commercial and personal data outliving
 * every pointer to it is a retention problem (KVKK/GDPR), not wasted disk —
 * the whole set weighed 188 kB.
 *
 * The API now deletes blobs on both paths it can see (`DELETE /evidence/:id`
 * and `DELETE /activity-records/:id`). This script is for the paths it cannot:
 * the FK cascade, `pnpm db:reset` (which drops the schema and leaves the bucket
 * untouched), and any future direct-SQL surgery.
 *
 * SAFETY
 * ------
 * Deleted objects are unrecoverable — there is no bucket versioning — and they
 * are the primary evidence behind filed emissions figures. So:
 *
 *  - dry run unless `--apply` is passed;
 *  - only objects OLDER than `--older-than` hours (default 24). `upload()`
 *    writes the blob and the row in two steps, so an in-flight upload
 *    legitimately has no row for a moment; without this window a run against a
 *    live API would delete it;
 *  - orphan-hood is decided by exact `storage_path` equality with the table,
 *    never by parsing the key. There are two key schemes under the same
 *    `<recordId>/` prefix — the API writes `<uuid>-<name>`, the seed writes
 *    `seed-evidence.csv` — and a pattern-matching filter would treat them
 *    inconsistently;
 *  - non-local targets are refused unless `--allow-remote` is passed. The
 *    service-role key bypasses RLS, so a wrong query here reaches every
 *    tenant's invoices at once.
 *
 * It also reports the INVERSE orphan (a row whose object is missing), which
 * nothing else detects: those rows hand out signed URLs that 404 at download.
 * It never deletes them — a missing file is a fact worth investigating, not
 * tidying away.
 *
 * Usage:
 *   node packages/db/scripts/reclaim-evidence.mjs                  # report only
 *   node packages/db/scripts/reclaim-evidence.mjs --apply
 *   node packages/db/scripts/reclaim-evidence.mjs --apply --older-than=0
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '../generated/client/index.js';

const BUCKET = 'evidence';
/** Supabase caps a single remove() call; stay well under it. */
const DELETE_BATCH = 100;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const apply = has('--apply');
const allowRemote = has('--allow-remote');
const olderThanHours = Number(valueOf('older-than', '24'));

if (!Number.isFinite(olderThanHours) || olderThanHours < 0) {
  console.error(`--older-than must be a non-negative number of hours (got "${valueOf('older-than', '')}")`);
  process.exit(2);
}

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceRole) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required (packages/db/.env).');
  process.exit(2);
}

const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
if (!isLocal && !allowRemote) {
  console.error(
    `Refusing to run against a non-local Supabase (${url}).\n` +
      'This uses the service-role key, which bypasses RLS and therefore every\n' +
      'tenant boundary. Pass --allow-remote if you really mean it.',
  );
  process.exit(2);
}

const prisma = new PrismaClient();
const storage = createClient(url, serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
}).storage.from(BUCKET);

async function main() {
  console.log(`Target:        ${url}${isLocal ? ' (local)' : '  ** REMOTE **'}`);
  console.log(`Mode:          ${apply ? 'APPLY — objects will be deleted' : 'dry run (pass --apply to delete)'}`);
  console.log(`Grace window:  objects newer than ${olderThanHours}h are left alone\n`);

  const [{ objects, rows }] = await prisma.$queryRaw`
    SELECT
      (SELECT count(*) FROM storage.objects WHERE bucket_id = ${BUCKET}) AS objects,
      (SELECT count(*) FROM public.evidence)                             AS rows
  `;
  console.log(`Bucket holds ${objects} object(s); the evidence table has ${rows} row(s).`);

  // Exact-equality anti-join, not a key-pattern match — see the header.
  const orphans = await prisma.$queryRaw`
    SELECT o.name, o.created_at
    FROM storage.objects o
    WHERE o.bucket_id = ${BUCKET}
      AND o.created_at < now() - make_interval(hours => ${olderThanHours}::int)
      AND NOT EXISTS (
        SELECT 1 FROM public.evidence e WHERE e.storage_path = o.name
      )
    ORDER BY o.created_at
  `;

  // The other direction. Never deleted, only reported.
  const missing = await prisma.$queryRaw`
    SELECT e.id, e.storage_path AS "storagePath"
    FROM public.evidence e
    WHERE NOT EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = ${BUCKET} AND o.name = e.storage_path
    )
  `;

  if (missing.length > 0) {
    console.log(
      `\n!! ${missing.length} evidence row(s) point at an object that does not exist.\n` +
        '   These hand out signed URLs that 404 at download. NOT deleted — a\n' +
        '   missing evidence file is worth investigating, not tidying away:',
    );
    for (const m of missing.slice(0, 10)) console.log(`   ${m.id}  ${m.storagePath}`);
    if (missing.length > 10) console.log(`   … and ${missing.length - 10} more`);
  }

  if (orphans.length === 0) {
    console.log('\nNo orphaned objects. Nothing to do.');
    return;
  }

  console.log(`\n${orphans.length} orphaned object(s):`);
  for (const o of orphans.slice(0, 10)) console.log(`   ${o.name}`);
  if (orphans.length > 10) console.log(`   … and ${orphans.length - 10} more`);

  if (!apply) {
    console.log('\nDry run — nothing was deleted. Re-run with --apply.');
    return;
  }

  let deleted = 0;
  for (let i = 0; i < orphans.length; i += DELETE_BATCH) {
    const batch = orphans.slice(i, i + DELETE_BATCH).map((o) => o.name);
    const { error } = await storage.remove(batch);
    if (error) throw new Error(`storage.remove failed on batch ${i / DELETE_BATCH}: ${error.message}`);
    deleted += batch.length;
    process.stdout.write(`\r   deleted ${deleted}/${orphans.length}`);
  }
  console.log('');

  const [after] = await prisma.$queryRaw`
    SELECT count(*) AS objects FROM storage.objects WHERE bucket_id = ${BUCKET}
  `;
  console.log(`\nDone. Bucket now holds ${after.objects} object(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
