import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { provision } from '../scripts/smoke-fixtures.mjs';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Prisma } = require('@tonyai/db');
const { GEOGRAPHY_CODES } = require('@tonyai/shared-types');
const target = () => ({
  mode: 'staging', sourceSha: 'a'.repeat(40), projectRef: 'abcdefghijklmnopqrst',
  web: 'https://tonyaiqt-staging-web.real.swedencentral.azurecontainerapps.io',
  api: 'https://tonyaiqt-staging-api.real.swedencentral.azurecontainerapps.io/api/v1',
  supabase: 'https://abcdefghijklmnopqrst.supabase.co',
  tenants: [0, 1].map(() => {
    const userId = randomUUID(); const organisationId = randomUUID();
    return { userId, organisationId, subsidiaryId: randomUUID(),
      email: `lp2-smoke-${userId}@tonyai.test`, name: `LP2 smoke ${organisationId}` };
  }),
});
const ownerUrl = 'postgresql://postgres.abcdefghijklmnopqrst:synthetic@aws-0-eu-north-1.pooler.supabase.com:5432/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt';

test('hosted fixtures use current Prisma fields, canonical geography and one audited transaction', async () => {
  const previous = process.env.DIRECT_URL;
  process.env.DIRECT_URL = ownerUrl;
  try {
    for (const failAudit of [false, true]) {
      const selected = target(); const events = []; let transactions = 0; let disconnected = false;
      class Client {
        async $transaction(work) {
          transactions++;
          const tx = {};
          for (const [delegate, model] of [['organisation', 'Organisation'], ['subsidiary', 'Subsidiary'], ['profile', 'Profile'], ['auditLog', 'AuditLog']]) {
            tx[delegate] = { create: async ({ data }) => {
              const fields = Prisma.dmmf.datamodel.models.find((item) => item.name === model).fields;
              for (const key of Object.keys(data)) assert.ok(fields.some((field) => field.name === key), `${model}.${key}`);
              for (const field of fields.filter((field) => field.kind !== 'object' && field.isRequired && !field.hasDefaultValue && !field.isUpdatedAt && !field.isList)) {
                assert.ok(Object.hasOwn(data, field.name), `${model}.${field.name} required`);
              }
              if (delegate === 'auditLog' && failAudit) throw new Error('audit rejected');
              events.push([delegate, data]);
            } };
          }
          await work(tx);
        }
        async $disconnect() { disconnected = true; }
      }
      if (failAudit) await assert.rejects(provision(selected, Client), /audit rejected/);
      else {
        await provision(selected, Client);
        assert.equal(events.length, 12);
        for (let index = 0; index < events.length; index += 2) {
          const [entity, data] = events[index]; const [audit, row] = events[index + 1];
          assert.equal(audit, 'auditLog'); assert.equal(row.entity, entity);
          assert.equal(row.entityId, data.id); assert.equal(row.action, 'create');
          if (entity !== 'profile') assert.ok(GEOGRAPHY_CODES.includes(data.geographyCode));
          else { assert.equal(data.role, 'super_admin'); assert.equal(data.email, `lp2-smoke-${data.id}@tonyai.test`); }
        }
        assert.deepEqual(events.filter(([entity]) => entity === 'profile').map(([, row]) => row.organisationId), selected.tenants.map((tenant) => tenant.organisationId));
      }
      assert.equal(transactions, 1); assert.equal(disconnected, true);
    }
    let constructed = false;
    class Forbidden { constructor() { constructed = true; } }
    for (const url of [ownerUrl.replace('postgres.', 'tonyai_runtime.'), ownerUrl.replace('5432', '6543'), ownerUrl.replace('strict', 'accept_invalid_certs')]) {
      process.env.DIRECT_URL = url;
      await assert.rejects(provision(target(), Forbidden));
    }
    await assert.rejects(provision({ ...target(), mode: 'production' }, Forbidden));
    assert.equal(constructed, false);
  } finally {
    if (previous === undefined) delete process.env.DIRECT_URL; else process.env.DIRECT_URL = previous;
  }
});
