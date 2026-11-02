import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { bootstrap, validateTarget } from '../scripts/hosted-lifecycle-bootstrap.mjs';
import { execute, validateOwnerUrl } from '../scripts/hosted-smoke-fixture.mjs';
import { probe, plan, BUCKETS, absent, validateSigned, guardedFetch } from '../scripts/hosted-storage-probe.mjs';

const project = 'abcdefghijklmnopqrst';
const url = `postgresql://postgres.${project}:SYNTHETIC@aws-0-eu-north-1.pooler.supabase.com:5432/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt`;
const ca = 'a'.repeat(64);
const target = () => ({ mode: 'staging', projectRef: project, sourceSha: 'b'.repeat(40),
  web: 'https://tonyaiqt-staging-web.real.swedencentral.azurecontainerapps.io',
  api: 'https://tonyaiqt-staging-api.real.swedencentral.azurecontainerapps.io/api/v1',
  supabase: `https://${project}.supabase.co`, tenants: [0, 1].map(() => {
    const userId = randomUUID(); const organisationId = randomUUID();
    return { userId, organisationId, subsidiaryId: randomUUID(), email: `lp2-smoke-${userId}@tonyai.test`, name: `LP2 smoke ${organisationId}` };
  }) });

for (const defect of ['node', 'prisma', 'ca', 'runtime-role', 'bad-tls', 'foreign-project']) {
  test(`Linux fixture rejects ${defect} before constructing a Prisma client`, async () => {
    let constructed = false;
    class Client { constructor() { constructed = true; } }
    const input = { operation: 'fixtures', target: target(), url, caSha256: ca };
    const deps = { Client, nodeMajor: '22', prismaVersion: '6.19.3', caSha256: ca };
    if (defect === 'node') deps.nodeMajor = '25';
    if (defect === 'prisma') deps.prismaVersion = '6.1.0';
    if (defect === 'ca') input.caSha256 = 'b'.repeat(64);
    if (defect === 'runtime-role') input.url = url.replace('postgres.', 'tonyai_runtime.');
    if (defect === 'bad-tls') input.url = url.replace('strict', 'accept_invalid_certs');
    if (defect === 'foreign-project') input.url = url.replace(project, 'z'.repeat(20));
    await assert.rejects(execute(input, deps)); assert.equal(constructed, false);
  });
}

test('Linux fixture uses one transaction/six matching audits and disconnects even on audit failure', async () => {
  for (const failAudit of [false, true]) {
    const selected = target(); let disconnected = false; const persisted = []; let transactions = 0;
    class Client {
      constructor(options) { assert.equal(options.datasourceUrl, url); assert.deepEqual(options.log, []); }
      async $transaction(work) {
        transactions++; const pending = []; const tx = {};
        for (const model of ['organisation', 'subsidiary', 'profile', 'auditLog']) tx[model] = { create: async ({ data }) => {
          if (model === 'auditLog' && failAudit) throw new Error('audit rejected'); pending.push([model, data]);
        } };
        await work(tx); persisted.push(...pending);
      }
      async $disconnect() { disconnected = true; }
    }
    const input = { operation: 'fixtures', target: selected, url, caSha256: ca };
    const deps = { Client, nodeMajor: '22', prismaVersion: '6.19.3', caSha256: ca };
    if (failAudit) { await assert.rejects(execute(input, deps)); assert.equal(persisted.length, 0); }
    else {
      assert.equal((await execute(input, deps)).status, 'FIXTURES_CREATED'); assert.equal(persisted.length, 12);
      for (let i = 0; i < 12; i += 2) { assert.equal(persisted[i + 1][0], 'auditLog'); assert.equal(persisted[i + 1][1].entityId, persisted[i][1].id); }
    }
    assert.equal(transactions, 1); assert.equal(disconnected, true);
  }
});

test('offline runtime verification never constructs/connects a Prisma client', async () => {
  class Client { constructor() { throw new Error('must not connect'); } }
  const report = await execute({ operation: 'verify', caSha256: ca }, { Client, nodeMajor: '22', prismaVersion: '6.19.3', caSha256: ca });
  assert.equal(report.status, 'RUNTIME_VERIFIED');
  assert.equal(validateOwnerUrl(url, project), url);
});

const missing = () => ({ data: null, error: { name: 'StorageApiError', status: 404, statusCode: '404' } });
const settings = (name) => ({ data: { id: name, public: false, file_size_limit: BUCKETS[name].limit, allowed_mime_types: BUCKETS[name].mimes }, error: null });
const input = () => ({ origin: `https://${project}.supabase.co`, projectRef: project, nonce: randomUUID(), releaseId: 'r004', sourceSha: 'b'.repeat(40) });
function mockStorage(selected, defect) {
  const stored = new Map(); const deleted = []; let code = null; let expired = false; let stopped = false; const records = []; let uploads = 0;
  const service = { getBucket: async (name) => defect === 'public-bucket' ? { data: { ...settings(name).data, public: true } } : settings(name),
    from: (bucket) => ({
      upload: async (path, bytes, options) => {
        uploads++; assert.equal(options.upsert, false);
        assert.ok(records.at(-1).entries.find((x) => x.bucket === bucket && x.path === path && x.attempted));
        if (defect === 'lost-ack') { stored.set(bucket + '/' + path, bytes); throw new Error('network lost response'); }
        if (path.includes('too-large') || path.includes('wrong-mime')) {
          if (defect === 'unexpected-negative-commit') { stored.set(bucket + '/' + path, bytes); return { data: {}, error: null }; }
          code = defect === 'wrong-refusal' ? 'AccessDenied' : path.includes('too-large') ? 'EntityTooLarge' : 'InvalidMimeType';
          return { data: null, error: { name: 'StorageApiError', statusCode: '400' } };
        }
        stored.set(bucket + '/' + path, bytes); return { data: {}, error: null };
      },
      download: async (path) => { if (stored.has(bucket + '/' + path)) { code = null; return { data: new Blob([stored.get(bucket + '/' + path)]), error: null }; } code = defect === 'wrong-404' ? 'NoSuchBucket' : 'NoSuchKey'; return missing(); },
      createSignedUrl: async (path, seconds) => { assert.equal(seconds, 60); expired = false;
        return { data: { signedUrl: `${defect === 'foreign-signed' ? 'https://evil.invalid' : selected.origin}/storage/v1/object/sign/${bucket}/${path}?token=SYNTHETIC` } }; },
      remove: async (paths) => { assert.equal(paths.length, 1); deleted.push([bucket, paths[0]]);
        if (defect !== 'cleanup-left-object') stored.delete(bucket + '/' + paths[0]); return { data: [], error: null }; },
    }) };
  return { service, anonymous: { from: () => ({ download: async () => { code = 'AccessDenied'; return missing(); } }) }, user: { from: () => ({ download: async () => { code = 'AccessDenied'; return missing(); } }) },
    lastCode: () => code, interrupted: () => stopped,
    readSigned: async (url) => {
      if (url.includes('/object/public/')) return { status: defect === 'public-bytes' ? 200 : 404, bytes: Buffer.alloc(0) };
      const key = new URL(url).pathname.split('/object/sign/')[1]; return { status: expired ? 403 : 200, bytes: stored.get(key) ?? Buffer.alloc(0) };
    }, sleep: async (ms) => { assert.equal(ms, 65000); if (defect === 'interrupted-wait') { stopped = true; throw new Error('synthetic interrupt'); } expired = true; },
    record: (value) => { records.push(structuredClone(value)); },
    observed: () => ({ stored, deleted, records, uploads }) };
}

test('Storage probe executes all 12 unique boundaries with three signed expiry controls and exact absence', async () => {
  const selected = input(); const adapters = mockStorage(selected); const report = await probe(selected, adapters);
  assert.equal(report.upload_attempts, 12); assert.equal(report.absent_objects, 12); assert.equal(report.private_signed_expiry_checks, 3);
  const seen = adapters.observed(); assert.equal(seen.stored.size, 0); assert.equal(seen.deleted.length, 12);
  assert.equal(seen.records[0].entries.length, 12); assert.equal(seen.records[0].entries.filter((x) => x.attempted).length, 0);
  assert.equal(seen.records.at(-1).complete, true);
  assert.equal(new Set(seen.deleted.map(([bucket, path]) => bucket + '/' + path)).size, 12);
});
for (const defect of ['public-bucket', 'lost-ack', 'wrong-refusal', 'unexpected-negative-commit', 'cleanup-left-object', 'foreign-signed', 'public-bytes', 'wrong-404', 'interrupted-wait']) {
  test(`Storage probe fails closed for ${defect} and cleans only attempted exact paths`, async () => {
    const selected = input(); const adapters = mockStorage(selected, defect);
    await assert.rejects(probe(selected, adapters)); const seen = adapters.observed();
    assert.equal(seen.records.at(-1).complete, false);
    if (defect === 'public-bucket') assert.equal(seen.uploads, 0);
    else assert.ok(seen.deleted.length > 0);
    for (const [bucket, path] of seen.deleted) assert.ok(seen.records.some((r) => r.entries.some((e) => e.bucket === bucket && e.path === path && e.attempted)));
  });
}

test('generic HTTP errors never count as authenticated object absence', () => {
  assert.equal(absent(missing(), 'NoSuchKey'), true);
  assert.equal(absent(missing(), 'NoSuchBucket'), false);
  assert.equal(absent(missing(), 'AccessDenied'), false);
  for (const result of [{ data: null, error: { statusCode: '404' } }, { data: null, error: { name: 'StorageApiError', statusCode: '400' } }, { data: {}, error: null }]) assert.equal(absent(result, 'NoSuchKey'), false);
});

test('guarded transport refuses foreign origins, paths and deletion targets before fetch', async () => {
  const selected = input(); const entries = plan(selected.nonce); let calls = 0;
  const guarded = guardedFetch(selected.origin, entries, async () => { calls++; return new Response('{}'); });
  await assert.rejects(guarded.fetch('https://evil.invalid/storage/v1/bucket/evidence'));
  await assert.rejects(guarded.fetch(selected.origin + '/storage/v1/object/evidence/foreign'));
  await assert.rejects(guarded.fetch(selected.origin + '/storage/v1/object/evidence', { method: 'DELETE', body: JSON.stringify({ prefixes: ['foreign'] }) }));
  await assert.rejects(guarded.fetch(selected.origin + '/storage/v1/object/evidence', { method: 'DELETE', body: JSON.stringify({ prefixes: [entries[0].path] }) }));
  assert.equal(calls, 0);
});

test('guarded transport retains only provider code before SDK discards it', async () => {
  const selected = input(); const entries = plan(selected.nonce);
  const guarded = guardedFetch(selected.origin, entries, async () => new Response(JSON.stringify({ code: 'EntityTooLarge', message: 'PRIVATE raw payload' }), { status: 400 }));
  entries[0].attempted = true;
  await guarded.fetch(selected.origin + '/storage/v1/object/evidence/' + entries[0].path, { method: 'POST' });
  assert.equal(guarded.code(), 'EntityTooLarge');
  assert.throws(() => validateSigned('https://evil.invalid/?token=SENSITIVE', selected.origin, entries[0]));
});


test('real storage SDK modern and legacy JSON404 errors require the exact captured NoSuchKey code', async () => {
  const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
  const { createClient } = require('@supabase/supabase-js');
  for (const body of [{ code: 'NoSuchKey' }, { statusCode: '404', code: 'NoSuchKey' }, { code: 'NoSuchBucket' }, { code: 'AccessDenied' }, { code: 'NoRoute' }]) {
    const selected = input(); const entries = plan(selected.nonce);
    const guarded = guardedFetch(selected.origin, entries, async () => new Response(JSON.stringify({ ...body, message: 'Synthetic denial' }), { status: 404 }));
    const client = createClient(selected.origin, 'sb_secret_SYNTHETIC', { auth: { autoRefreshToken: false, persistSession: false }, global: { fetch: guarded.fetch } });
    const result = await client.storage.from('evidence').download(entries[0].path);
    assert.equal(result.error.name, 'StorageApiError'); assert.equal(result.error.status, 404);
    assert.equal(absent(result, guarded.code()), body.code === 'NoSuchKey');
  }
});


test('response body stalls remain abortable after headers and never reach SDK consumers', async () => {
  for (const manual of [true, false]) {
    const selected = input(); const entries = plan(selected.nonce); let cancelled = false; let signal;
    const guarded = guardedFetch(selected.origin, entries, async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
    }, 20);
    const pending = guarded.fetch(selected.origin + '/storage/v1/object/evidence/' + entries[0].path);
    await new Promise((resolve) => setImmediate(resolve));
    if (manual) guarded.abort();
    await assert.rejects(pending);
    assert.equal(signal.aborted, true); assert.equal(cancelled, true);
  }
});


test('no-mail bootstrap is one atomic two-row/two-audit fixture, never an invitation', async () => {
  for (const rejectAudit of [false, true]) {
    const userId = randomUUID(); const organisationId = randomUUID();
    const target = { mode: 'hosted-l10-lifecycle', projectRef: project, sourceSha: 'b'.repeat(40), userId, organisationId,
      email: `lp2-l10-${userId}@tonyai.test`, name: `L10 synthetic acceptance ${organisationId}` };
    assert.equal(validateTarget(target), target);
    let disconnected = false; const committed = [];
    class Client {
      constructor(options) { assert.equal(options.datasourceUrl, url); }
      async $transaction(work) {
        const pending = [];
        const delegate = (entity) => ({ create: async ({ data }) => {
          if (entity === 'auditLog' && rejectAudit) throw new Error('synthetic audit failure'); pending.push([entity, data]);
        } });
        await work({ organisation: delegate('organisation'), profile: delegate('profile'), auditLog: delegate('auditLog') });
        committed.push(...pending);
      }
      async $disconnect() { disconnected = true; }
    }
    if (rejectAudit) { await assert.rejects(bootstrap({ operation: 'bootstrap', target, url }, Client)); assert.equal(committed.length, 0); }
    else { assert.equal((await bootstrap({ operation: 'bootstrap', target, url }, Client)).status, 'BOOTSTRAP_CREATED'); assert.deepEqual(committed.map(([kind]) => kind), ['organisation', 'auditLog', 'profile', 'auditLog']); }
    assert.equal(disconnected, true);
    assert.throws(() => validateTarget({ ...target, email: 'protected@example.invalid' }));
  }
});
