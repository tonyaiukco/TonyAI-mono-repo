import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSmoke } from '../scripts/smoke-contract.mjs';
import { fixtureDatabaseUrl } from '../scripts/smoke-fixtures.mjs';
import { routeSweden } from '../scripts/smoke-browser-route.mjs';

const target = () => ({ mode: 'qa-sweden', sourceSha: 'e'.repeat(40), releaseId: 'qa001',
  apiDigest: `sha256:${'a'.repeat(64)}`, webDigest: `sha256:${'b'.repeat(64)}`, dbCaSha256: 'c'.repeat(64),
  web: 'https://tonyai-staging-web.test.swedencentral.azurecontainerapps.io',
  api: 'https://tonyai-staging-api.test.swedencentral.azurecontainerapps.io/api/v1',
  supabase: 'https://tonyai-staging-cb7efc2f-r02.test.swedencentral.cloudapp.azure.com',
  tenants: [0, 1].map(() => { const userId = randomUUID(); const organisationId = randomUUID();
    return { userId, organisationId, subsidiaryId: randomUUID(), email: `lp2-smoke-${userId}@tonyai.test`,
      name: `LP2 smoke ${organisationId}` }; }),
});

test('Sweden browser never follows redirects or sends credentials outside exact origins', async () => {
  for (const status of [200, 301, 302, 303, 307, 308, 'foreign', 'failure']) {
    const events = [];
    const route = {
      request: () => ({ url: () => status === 'foreign' ? 'https://evil.invalid' : `${target().supabase}/auth/v1/token` }),
      fetch: async (options) => {
        assert.equal(options.maxRedirects, 0); assert.equal(options.timeout, 60_000);
        events.push('fetch');
        if (status === 'failure') throw new Error('sensitive diagnostics');
        return { status: () => status };
      },
      abort: async () => events.push('abort'),
      fulfill: async () => events.push('fulfill'),
      continue: async () => assert.fail('Unrestricted browser transport is forbidden'),
    };
    await routeSweden(route, new Set([target().supabase]));
    assert.deepEqual(events, status === 'foreign' ? ['abort'] : ['fetch', status === 200 ? 'fulfill' : 'abort']);
  }
});

test('Sweden has a distinct exact region/app/selfhost contract', () => {
  assert.equal(validateSmoke(target()).mode, 'qa-sweden');
  for (const [field, value] of [['mode', 'staging'], ['mode', 'ci-local'], ['projectRef', 'abcdefghijklmnopqrst'],
    ['sourceSha', 'main'], ['releaseId', 'latest/release'], ['apiDigest', 'latest'], ['webDigest', 'sha256:bad'],
    ['dbCaSha256', 'bad'], ['web', target().web.replace('tonyai', 'other')],
    ['web', target().web.replace('swedencentral', 'germanywestcentral')],
    ['api', target().api.replace('-api.', '-web.')], ['supabase', 'https://abcdefghijklmnopqrst.supabase.co'],
    ['supabase', target().supabase.replace('-r02.', '-r01.')]]) {
    assert.throws(() => validateSmoke({ ...target(), [field]: value }), field);
  }
  for (const field of ['web', 'api', 'supabase']) {
    for (const suffix of ['@evil.invalid', ':443', '/extra', '?redirect=evil', '#fragment']) {
      assert.throws(() => validateSmoke({ ...target(), [field]: target()[field] + suffix }));
    }
  }
  const wrong = target(); wrong.tenants[0].email = wrong.tenants[1].email;
  assert.throws(() => validateSmoke(wrong));
});

test('fixture child validates Sweden owner role, strict TLS and exact public CA before Prisma', () => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-smoke-test-'));
  const previous = process.env.SMOKE_DB_CA_FILE;
  try {
    const ca = join(directory, 'public.crt'); writeFileSync(ca, 'synthetic public CA');
    process.env.SMOKE_DB_CA_FILE = ca;
    const selected = target(); selected.dbCaSha256 = createHash('sha256').update('synthetic public CA').digest('hex');
    const url = 'postgresql://postgres:synthetic@db.qa.tonyai.internal:5432/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/qa-db-ca.crt';
    assert.equal(new URL(fixtureDatabaseUrl(selected, url)).searchParams.get('sslcert'), ca);
    for (const bad of [url.replace('postgres:', 'tonyai_runtime:'), url.replace('5432', '6543'),
      url.replace('db.qa.tonyai.internal', 'evil.invalid'), url.replace('strict', 'accept_invalid_certs'),
      url.replace('require', 'disable'), url.replace('qa-db-ca', 'other'), url + '&host=evil.invalid']) {
      assert.throws(() => fixtureDatabaseUrl(selected, bad));
    }
    writeFileSync(ca, 'changed CA'); assert.throws(() => fixtureDatabaseUrl(selected, url));
  } finally {
    if (previous === undefined) delete process.env.SMOKE_DB_CA_FILE; else process.env.SMOKE_DB_CA_FILE = previous;
    rmSync(directory, { recursive: true });
  }
});
