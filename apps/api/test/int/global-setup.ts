import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@tonyai/db';

/**
 * Runs once before any integration spec. It refuses — loudly, never by
 * skipping — when the database is not one these tests may write to, is not
 * reachable, or is missing a migration. A silent skip would let an `it.fails`
 * expected failure "pass" for the wrong reason.
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MIGRATIONS_DIR = resolve(__dirname, '../../../../packages/db/prisma/migrations');

export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Start the local stack (`pnpm setup`) so the repo-root .env exists, or export it.',
    );
  }

  // The fixtures create and delete tenants. Never point them at a shared or
  // customer database by accident (B2: no local test tooling against production).
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && process.env.INT_TEST_ALLOW_NONLOCAL_DB !== '1') {
    throw new Error(
      `Refusing to run integration tests against non-local host "${host}". ` +
        'Set INT_TEST_ALLOW_NONLOCAL_DB=1 only for a disposable database.',
    );
  }

  const prisma = new PrismaClient();
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
  } finally {
    await prisma.$disconnect();
  }
}
