import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@tonyai/db';
import {
  RUNTIME_ROLE,
  isLoopbackUrl,
  provisionLocalRuntimeLogin,
  urlUser,
} from '../../../../packages/db/scripts/runtime-role.mjs';
import { BUCKETS } from '../../src/storage/buckets';
import { StorageService } from '../../src/storage/storage.service';
import { TENANT_EMAIL_PATTERN, TENANT_ORG_PREFIX, tenantIntents } from './db';

/**
 * Runs once before any integration spec. It refuses — loudly, never by
 * skipping — when the database is not one these tests may write to, is not
 * reachable, or is missing a migration. A silent skip would let an `it.fails`
 * expected failure "pass" for the wrong reason.
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MIGRATIONS_DIR = resolve(__dirname, '../../../../packages/db/prisma/migrations');

export default async function setup(): Promise<void> {
  // Both derived in vitest.int.config.ts from DATABASE_URL / DIRECT_URL.
  const url = process.env.INT_OWNER_DATABASE_URL;
  const runtimeUrl = process.env.INT_RUNTIME_DATABASE_URL;
  if (!url || !runtimeUrl) {
    throw new Error(
      'DATABASE_URL is not set. Start the local stack (`pnpm setup`) so apps/api/.env exists, or export it.',
    );
  }
  if (urlUser(url) === RUNTIME_ROLE) {
    throw new Error(
      `DATABASE_URL logs in as ${RUNTIME_ROLE}; set DIRECT_URL to the owner connection — the fixtures create ` +
        'organisations and profiles, which the runtime role may not.',
    );
  }

  // The fixtures create and delete tenants. Never point them at a shared or
  // customer database by accident (B2: no local test tooling against production).
  // `isLoopbackUrl`, not the hostname alone: Prisma honours a `?host=`
  // parameter over the URL's host (LP1-03 `security-rls`).
  const host = new URL(url).hostname;
  if (!(isLoopbackUrl(url) && isLoopbackUrl(runtimeUrl)) && process.env.INT_TEST_ALLOW_NONLOCAL_DB !== '1') {
    throw new Error(
      `Refusing to run integration tests against non-local host "${host}". ` +
        'Set INT_TEST_ALLOW_NONLOCAL_DB=1 only for a disposable database.',
    );
  }

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    await prisma.$disconnect();
    throw new Error(
      `Cannot reach PostgreSQL at ${host}. Is the local Supabase stack running (\`supabase start\`)?\n${String(err)}`,
      { cause: err },
    );
  }

  try {
    const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const appliedNames = new Set(applied.map((row) => row.migration_name));
    const pending = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !appliedNames.has(entry.name))
      .map((entry) => entry.name);
    if (pending.length > 0) {
      throw new Error(
        `The database is missing ${pending.length} migration(s): ${pending.join(', ')}. Run \`pnpm db:deploy\`.`,
      );
    }

    // The runtime role's login (the migration creates it without one), with
    // the password vitest.int.config.ts generated for this run. When
    // DATABASE_URL already names the role, its own password stands.
    if (process.env.INT_PROVISION_RUNTIME_LOGIN === '1') {
      await provisionLocalRuntimeLogin(prisma, url, decodeURIComponent(new URL(runtimeUrl).password));
    }
    const runtime = new PrismaClient({ datasourceUrl: runtimeUrl });
    try {
      const [{ user }] = await runtime.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
      if (user !== RUNTIME_ROLE) throw new Error(`the runtime connection logs in as ${user}, not ${RUNTIME_ROLE}`);
    } catch (err) {
      throw new Error(`Cannot connect as ${RUNTIME_ROLE}: ${String(err)}`, { cause: err });
    } finally {
      await runtime.$disconnect();
    }

    // A run killed mid-test skips its cleanup(); sweep synthetic tenants left
    // behind. Only rows carrying the fixtures' own markers are touched.
    const orphanOrgs = await prisma.organisation.findMany({
      where: { legalName: { startsWith: TENANT_ORG_PREFIX } },
      select: { id: true },
    });
    const orphanProfiles = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM profiles WHERE email LIKE ${TENANT_EMAIL_PATTERN}`;
    const orgIds = orphanOrgs.map((o) => o.id);
    const profileIds = orphanProfiles.map((p) => p.id);
    if (orgIds.length > 0 || profileIds.length > 0) {
      const subsidiaryIds = (
        await prisma.subsidiary.findMany({ where: { organisationId: { in: orgIds } }, select: { id: true } })
      ).map((s) => s.id);
      await sweepTenantObjects(prisma, subsidiaryIds, orgIds);
      await prisma.storageIntent.deleteMany({ where: tenantIntents(subsidiaryIds, orgIds) });
      await prisma.auditLog.deleteMany({
        where: { OR: [{ organisationId: { in: orgIds } }, { userId: { in: profileIds } }] },
      });
      await prisma.profile.deleteMany({ where: { id: { in: profileIds } } });
      await prisma.organisation.deleteMany({ where: { id: { in: orgIds } } });
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Objects a killed Storage test left under synthetic tenants' prefixes
 * (evidence by subsidiary, import sources by organisation). Only against a
 * local Storage, and only when one is configured — the stub-based specs need
 * none.
 */
async function sweepTenantObjects(
  prisma: PrismaClient,
  subsidiaryIds: string[],
  organisationIds: string[],
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  if (!url || !process.env.SUPABASE_SERVICE_ROLE_KEY || !LOCAL_HOSTS.has(new URL(url).hostname)) return;
  const storage = new StorageService();
  for (const bucket of BUCKETS) {
    const prefixes = (bucket === 'evidence' ? subsidiaryIds : organisationIds).map((id) => `${id}/`);
    if (prefixes.length === 0) continue;
    const rows = await prisma.$queryRaw<{ name: string }[]>`
      SELECT name FROM storage.objects
      WHERE bucket_id = ${bucket} AND split_part(name, '/', 1) || '/' = ANY(${prefixes}::text[])`;
    const paths = rows.map((r) => r.name);
    for (let i = 0; i < paths.length; i += 100) await storage.remove(bucket, paths.slice(i, i + 100));
  }
}
