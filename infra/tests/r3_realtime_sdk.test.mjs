/**
 * The pinned realtime-js/Phoenix and ws, not fakes, driving the harness transport. No packet is
 * sent: the session host is not in the pinned table, so the lookup refuses before any connect.
 * CI installs the workspace; a checkout without apps/api's node_modules skips outside CI only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { REPO_ROOT, createSocketsAdapter, pinnedLookup } from '../scripts/r3_realtime_clients.mjs';

const installed = existsSync(join(REPO_ROOT, 'apps/api/node_modules'));

test('the real SDK uses the pinned transport once and never reconnects after a refused lookup', {
  skip: !installed && !process.env.CI ? 'apps/api is not installed in this checkout' : false,
}, async () => {
  const api = createRequire(join(REPO_ROOT, 'apps/api/package.json'));
  const { RealtimeClient } = createRequire(api.resolve('@supabase/supabase-js'))('@supabase/realtime-js');
  const core = createRequire(createRequire(api.resolve('puppeteer')).resolve('puppeteer-core'));
  const WebSocket = core('ws');
  const lookups = [];
  const pinned = pinnedLookup({ 'admin.realtime-gcm.invalid': '172.31.250.10' });
  const lookup = (host, opts, cb) => { lookups.push(host); pinned(host, opts, cb); };
  const adapter = createSocketsAdapter({ libs: { RealtimeClient, WebSocket }, port: 4000, lookup, vsn: '2.0.0',
    limits: { handshakeMs: 1000, frameBytes: 16384, framesPerSession: 128, transcriptBytes: 1 << 22, heartbeatMs: 15000 } });
  const s = await adapter.open({ hostname: 'gcm-fixture-a.realtime-gcm.invalid', token: 'x.y.z', timeoutMs: 2000 });
  assert.equal(s.status, 'closed');
  assert.equal(s.httpStatus, null);
  const j = await s.join({ topic: 'gcm-probe', schema: 'gcm_fixture', table: 'events', timeoutMs: 300 });
  assert.notEqual(j.status, 'subscribed');
  // Phoenix's first reconnect would come after 1 s by default; wait past it.
  await new Promise((r) => { setTimeout(r, 2500); });
  const c = await s.close();
  assert.deepEqual(c.violations, []);
  assert.equal(c.socketConstructions, 1);
  assert.deepEqual(lookups, ['gcm-fixture-a.realtime-gcm.invalid']);
  assert.deepEqual(adapter.finalCheck().violations, []);
});
