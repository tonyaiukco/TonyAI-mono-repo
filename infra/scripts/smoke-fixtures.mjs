/** Staging-only fixture provisioning via Prisma; no seed, reset or broad cleanup. */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSmoke } from './smoke-contract.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { PrismaClient } = require('@tonyai/db');

export function fixtureDatabaseUrl(target, url) {
  // Validate the actual connection even when this helper is invoked directly.
  // Reuse the strict project/pooler/TLS allowlist; input/output remain pipes.
  const checked = spawnSync('python3', ['-c',
    'import sys; from pooler import validate_pooler, local_ca_url; u=sys.stdin.read(); validate_pooler(u,sys.argv[1],5432); sys.stdout.write(local_ca_url(u))',
    target.projectRef], { input: url, encoding: 'utf8',
    cwd: fileURLToPath(new URL('.', import.meta.url)) });
  if (checked.status !== 0) throw new Error('Fixture database does not match staging');
  return checked.stdout;
}

export async function provision(target) {
  validateSmoke(target);
  if (target.mode !== 'staging') throw new Error('Staging fixtures only');
  const prisma = new PrismaClient({ datasourceUrl: fixtureDatabaseUrl(target, process.env.DIRECT_URL ?? ''), log: [] });
  try {
    // Single transaction: an interrupted prepare leaves all or none of these rows.
    await prisma.$transaction(async (tx) => {
      for (const tenant of target.tenants) {
        const mutations = [
          ['organisation', tenant.organisationId, () => tx.organisation.create({ data: {
            id: tenant.organisationId, legalName: tenant.name, country: 'DE', geographyCode: 'DE',
          } })],
          ['subsidiary', tenant.subsidiaryId, () => tx.subsidiary.create({ data: {
            id: tenant.subsidiaryId, organisationId: tenant.organisationId,
            legalName: tenant.name, geographyCode: 'DE',
          } })],
          ['profile', tenant.userId, () => tx.profile.create({ data: {
            id: tenant.userId, email: tenant.email, fullName: 'LP2 synthetic smoke',
            organisationId: tenant.organisationId, role: 'super_admin',
          } })],
        ];
        for (const [entity, entityId, mutate] of mutations) {
          await mutate();
          await tx.auditLog.create({ data: {
            action: 'create', entity, entityId, organisationId: tenant.organisationId,
            diff: { purpose: 'LP2-02 synthetic staging smoke; no customer inventory' },
          } });
        }
      }
    });
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1]?.endsWith('/smoke-fixtures.mjs')) {
  provision(JSON.parse(process.env.SMOKE_TARGET_JSON)).catch(() => {
    console.error('FAIL: synthetic fixture transaction refused; details withheld.');
    process.exitCode = 1;
  });
}
