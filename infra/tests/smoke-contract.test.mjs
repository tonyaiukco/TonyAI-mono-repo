import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateSmoke } from '../scripts/smoke-contract.mjs';

const fixture = () => ({
  mode: 'staging', sourceSha: 'a'.repeat(40), projectRef: 'abcdefghijklmnopqrst',
  web: 'https://tonyai-staging-web.real.germanywestcentral.azurecontainerapps.io',
  api: 'https://tonyai-staging-api.real.germanywestcentral.azurecontainerapps.io/api/v1',
  supabase: 'https://abcdefghijklmnopqrst.supabase.co',
  tenants: [0, 1].map(() => {
    const organisationId = randomUUID();
    return { userId: randomUUID(), organisationId, subsidiaryId: randomUUID(),
      email: `lp2-smoke-${randomUUID()}@tonyai.test`, name: `LP2 smoke ${organisationId}` };
  }),
});

test('accepts dedicated disjoint staging tenants; rejects production, redirects and demo identities', () => {
  assert.equal(validateSmoke(fixture()).mode, 'staging');
  for (const [field, value] of [['mode', 'production'], ['web', 'https://evil.test'], ['api', 'https://evil.test'],
    ['supabase', 'https://abcdefghijklmnopqrst.supabase.co@evil.test'], ['projectRef', 'foreign'], ['sourceSha', 'latest']]) {
    assert.throws(() => validateSmoke({ ...fixture(), [field]: value }));
  }
  for (const field of ['userId', 'organisationId', 'subsidiaryId', 'email', 'name']) {
    const target = fixture(); target.tenants[0][field] = 'demo';
    assert.throws(() => validateSmoke(target));
  }
  const duplicate = fixture(); duplicate.tenants[1] = duplicate.tenants[0];
  assert.throws(() => validateSmoke(duplicate));
});

test('local demo mode requires CI and three exact loopback origins', () => {
  const target = { mode: 'ci-local', web: 'http://localhost:3000', api: 'http://localhost:3001/api/v1', supabase: 'http://localhost:54321' };
  const previous = process.env.CI;
  try {
    process.env.CI = 'false'; assert.throws(() => validateSmoke(target));
    process.env.CI = 'true'; assert.equal(validateSmoke(target), target);
    assert.throws(() => validateSmoke({ ...target, supabase: 'https://project.supabase.co' }));
  } finally { if (previous === undefined) delete process.env.CI; else process.env.CI = previous; }
});

test('lint ignores worktree copies while application files remain checked', async () => {
  const { ESLint } = await import('eslint');
  const eslint = new ESLint();
  for (const file of ['.claude/worktrees/demo/apps/web/app/page.tsx', '.codex/worktrees/demo/file.ts', '.worktrees/demo/file.ts', 'nested/worktrees/demo/file.ts']) {
    assert.equal(await eslint.isPathIgnored(file), true, file);
  }
  for (const file of ['apps/web/app/login/page.tsx', 'apps/api/src/auth/auth.controller.ts', 'packages/shared-types/src/index.ts']) {
    assert.equal(await eslint.isPathIgnored(file), false, file);
  }
});

test('fixture executable validates its own actual DB connection before Prisma can write', async () => {
  const { fixtureDatabaseUrl } = await import('../scripts/smoke-fixtures.mjs');
  const target = fixture();
  const url = `postgresql://postgres.${target.projectRef}:synthetic@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt`;
  assert.match(fixtureDatabaseUrl(target, url), /sslcert=/);
  for (const invalid of [url.replace(target.projectRef, 'z'.repeat(20)), url.replace('eu-central-1', 'us-east-1'),
    url.replace('sslaccept=strict', 'sslaccept=accept_invalid_certs'), url + '&host=evil.test', 'postgresql://localhost/production']) {
    assert.throws(() => fixtureDatabaseUrl(target, invalid));
  }
});
