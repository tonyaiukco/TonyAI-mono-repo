/** Exercise real crypto/serialization with a synthetic root filesystem and host guard. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { resolve } from 'node:path';
const source = readFileSync(new URL('../scripts/selfhost_init.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export const', 'const').replace("process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)", 'true');
const template = readFileSync(new URL('./fixtures/selfhost-template.txt', import.meta.url), 'utf8');
const inventory = readFileSync(new URL('../selfhost/credential-template.json', import.meta.url), 'utf8');
const run = (failure) => {
  const writes = []; const output = [];
  const context = {
    ...crypto, resolve, Buffer, process: { argv: ['node', 'init', '/opt/tonyai/supabase'], getuid: () => 0, umask: () => {} },
    console: { log: (text) => output.push(text), error: (text) => output.push(text) },
    lstatSync: () => ({ isDirectory: () => true, uid: 0, mode: failure === 'unsafe-parent' ? 0o777 : 0o700 }),
    existsSync: (path) => failure === 'existing-env' && path.endsWith('.env') || failure === 'existing-data' && path.endsWith('postgres'),
    readdirSync: () => ['PG_VERSION'], mkdirSync: () => {},
    execFileSync: (program) => { if (failure === 'missing-mount' || failure === 'generation-guard' && program === '/usr/bin/python3') throw new Error('sentinel-secret'); },
    readFileSync: (path) => path.endsWith('replacement.json') ? JSON.stringify({ generation: failure === 'wrong-generation' ? 'r01' : 'r02', vm_id: 'synthetic', source_sha256: 'a'.repeat(64), public_hostname: 'tonyai-staging-test.swedencentral.cloudapp.azure.com', operator_email: 'operator@example.com' }) : path.endsWith('credential-template.json') ? inventory : template + (failure === 'template-drift' ? '\nUNKNOWN_SECRET=sentinel-secret\n' : ''),
    writeFileSync: (path, data, options) => writes.push({ path, data, options }),
  };
  vm.runInNewContext(source, context);
  assert.ok(!output.join('').includes('sentinel-secret'));
  if (failure) { assert.equal(writes.length, 0); assert.equal(context.process.exitCode, 1); return; }
  assert.equal(writes.length, 2); assert.ok(writes[0].path.endsWith('initialization-r02.json'));
  for (const write of writes) { assert.equal(write.options.flag, 'wx'); assert.equal(write.options.mode, 0o600); }
  const env = Object.fromEntries(writes[1].data.split('\n').map((line) => /^([A-Z_0-9]+)='(.*)'$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2]]));
  assert.equal(env.REALTIME_DB_ENC_KEY.length, 16); assert.equal(Buffer.from(env.REALTIME_DB_ENC_KEY, 'base64').length, 12);
  assert.equal(env.REALTIME_DB_ENC_KEY_GCM.length, 32); assert.equal(Buffer.from(env.REALTIME_DB_ENC_KEY_GCM, 'base64').length, 24);
  assert.equal(env.OPENAI_API_KEY, ''); assert.equal(env.SUPABASE_SECRET_KEY, ''); assert.equal(env.SMTP_PASS, '');
  const privateKeys = JSON.parse(env.JWT_KEYS); const publicKeys = JSON.parse(env.JWT_JWKS).keys;
  assert.deepEqual(privateKeys[0].key_ops, ['sign', 'verify']); assert.ok(privateKeys[0].d);
  assert.deepEqual(publicKeys[0].key_ops, ['verify']); assert.equal(publicKeys[0].d, undefined);
  for (const role of ['ANON_KEY', 'SERVICE_ROLE_KEY']) {
    const parts = env[role].split('.');
    assert.equal(parts[2], crypto.createHmac('sha256', env.JWT_SECRET).update(parts.slice(0, 2).join('.')).digest('base64url'));
  }
  for (const value of [env.POSTGRES_PASSWORD, env.JWT_SECRET, env.SERVICE_ROLE_KEY, privateKeys[0].d, env.REALTIME_DB_ENC_KEY_GCM]) assert.ok(!output.join('').includes(value));
  assert.equal(new Set([env.POSTGRES_PASSWORD, env.DASHBOARD_PASSWORD, env.S3_PROTOCOL_ACCESS_KEY_SECRET]).size, 3);
};
run(); for (const failure of ['unsafe-parent', 'existing-env', 'existing-data', 'missing-mount', 'generation-guard', 'wrong-generation', 'template-drift']) run(failure);
console.log('PASS: initializer generation/template gates, fresh crypto formats and secret redaction.');
