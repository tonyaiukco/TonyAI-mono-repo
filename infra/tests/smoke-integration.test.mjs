import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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

test('lint ignores worktree copies while application files remain checked', async () => {
  const { ESLint } = await import('eslint');
  const eslint = new ESLint();
  for (const file of ['.claude/worktrees/demo/apps/web/app/page.tsx', '.codex/worktrees/demo/file.ts', '.worktrees/demo/file.ts', 'worktrees/demo/file.ts']) {
    assert.equal(await eslint.isPathIgnored(file), true, file);
  }
  for (const file of ['apps/web/app/worktrees/page.tsx', 'apps/api/src/worktrees/test.ts', 'packages/shared-types/src/worktrees/test.ts', 'apps/web/app/login/page.tsx', 'apps/api/src/auth/auth.controller.ts', 'packages/shared-types/src/index.ts']) {
    assert.equal(await eslint.isPathIgnored(file), false, file);
  }
});

test('fixture executable validates its own actual DB connection before Prisma can write', async () => {
  const { fixtureDatabaseUrl } = await import('../scripts/smoke-fixtures.mjs');
  const target = fixture();
  const url = `postgresql://postgres.${target.projectRef}:synthetic@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt`;
  assert.match(fixtureDatabaseUrl(target, url), /sslcert=/);
  for (const invalid of [url.replace('postgres.', 'tonyai_runtime.'), url.replace('5432', '6543'), url.replace(target.projectRef, 'z'.repeat(20)), url.replace('eu-central-1', 'us-east-1'),
    url.replace('sslaccept=strict', 'sslaccept=accept_invalid_certs'), url + '&host=evil.test', 'postgresql://localhost/production']) {
    assert.throws(() => fixtureDatabaseUrl(target, invalid));
  }
});
