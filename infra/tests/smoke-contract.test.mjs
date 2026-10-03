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
  for (const count of [0, 1, 3]) {
    const target = fixture(); target.tenants = Array.from({ length: count }, () => fixture().tenants[0]);
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
    for (const field of ['web', 'api', 'supabase']) {
      assert.throws(() => validateSmoke({ ...target, [field]: 'https://project.invalid' }));
    }
  } finally { if (previous === undefined) delete process.env.CI; else process.env.CI = previous; }
});
