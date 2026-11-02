/** Staging-only fixture provisioning via Prisma; no seed, reset or broad cleanup. */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSmoke } from './smoke-contract.mjs';
import { provisionRows } from './smoke-fixture-transaction.mjs';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { PrismaClient } = require('@tonyai/db');

export function fixtureDatabaseUrl(target, url) {
  validateSmoke(target);
  if (target.mode === 'qa-sweden') {
    const checked = spawnSync('python3', ['-c',
      'import json,sys; from qa_smoke_database import local_url; v=json.load(sys.stdin); sys.stdout.write(local_url(v["url"],v["ca"],v["hash"]))'], {
      input: JSON.stringify({ url, ca: process.env.SMOKE_DB_CA_FILE, hash: target.dbCaSha256 }), encoding: 'utf8',
      cwd: fileURLToPath(new URL('.', import.meta.url)), timeout: 30_000,
    });
    if (checked.status !== 0) throw new Error('Fixture database does not match Sweden QA');
    return checked.stdout;
  }
  // Validate the actual connection even when this helper is invoked directly.
  // Reuse the strict project/pooler/TLS allowlist; input/output remain pipes.
  const checked = spawnSync('python3', ['-c',
    'import sys; from pooler import validate_pooler, local_ca_url; u=sys.stdin.read(); validate_pooler(u,sys.argv[1],5432); sys.stdout.write(local_ca_url(u))',
    target.projectRef], { input: url, encoding: 'utf8',
    cwd: fileURLToPath(new URL('.', import.meta.url)) });
  if (checked.status !== 0) throw new Error('Fixture database does not match staging');
  return checked.stdout;
}

export async function provision(target, Client = PrismaClient) {
  validateSmoke(target);
  if (!['staging', 'qa-sweden'].includes(target.mode)) throw new Error('Staging fixtures only');
  const prisma = new Client({ datasourceUrl: fixtureDatabaseUrl(target, process.env.DIRECT_URL ?? ''), log: [] });
  try {
    await provisionRows(target, prisma);
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1]?.endsWith('/smoke-fixtures.mjs')) {
  provision(JSON.parse(process.env.SMOKE_TARGET_JSON)).catch(() => {
    console.error('FAIL: synthetic fixture transaction refused; details withheld.');
    process.exitCode = 1;
  });
}
