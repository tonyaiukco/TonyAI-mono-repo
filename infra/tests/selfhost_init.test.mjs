/** Run the real initializer with filesystem/mount boundaries replaced, never touching a host. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { resolve } from 'node:path';
const source = readFileSync(new URL('../scripts/selfhost_init.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const run = (failure) => {
  const writes = []; const output = []; const mounts = [];
  const context = {
    ...crypto, resolve, Buffer, process: { argv: ['node', 'init', '/opt/tonyai/supabase'], getuid: () => 0, umask: () => {} },
    console: { log: (text) => output.push(text), error: (text) => output.push(text) },
    lstatSync: () => ({ isDirectory: () => true, uid: 0, mode: failure === 'unsafe-parent' ? 0o777 : 0o700 }),
    existsSync: (path) => failure === 'existing-env' && path.endsWith('.env') || failure === 'existing-data' && path.endsWith('postgres'),
    readdirSync: () => ['PG_VERSION'], mkdirSync: () => {},
    execFileSync: (program, args) => { mounts.push([program, args]); if (failure === 'missing-mount') throw new Error('Missing mount.'); },
    readFileSync: (path) => path.endsWith('host.json') ? JSON.stringify({ public_hostname: 'tonyai-staging-test.swedencentral.cloudapp.azure.com', operator_email: 'operator@example.com' }) : 'POSTGRES_PASSWORD=demo\n',
    writeFileSync: (path, data, options) => writes.push({ path, data, options }),
  };
  vm.runInNewContext(source, context);
  if (failure) { assert.equal(writes.length, 0); assert.equal(context.process.exitCode, 1); }
  else {
    assert.equal(writes.length, 1); assert.equal(writes[0].options.flag, 'wx'); assert.equal(writes[0].options.mode, 0o600);
    assert.equal(mounts.length, 2);
    const env = Object.fromEntries(writes[0].data.split('\n').map((line) => /^([A-Z_0-9]+)='(.*)'$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2]]));
    assert.notEqual(env.POSTGRES_PASSWORD, 'demo');
    const privateKeys = JSON.parse(env.JWT_KEYS); const publicKeys = JSON.parse(env.JWT_JWKS).keys;
    assert.deepEqual(privateKeys[0].key_ops, ['sign', 'verify']); assert.ok(privateKeys[0].d);
    assert.deepEqual(publicKeys[0].key_ops, ['verify']); assert.equal(publicKeys[0].d, undefined);
    for (const value of [env.POSTGRES_PASSWORD, env.JWT_SECRET, env.SERVICE_ROLE_KEY, privateKeys[0].d]) assert.ok(!output.join('').includes(value));
  }
};
run(); for (const failure of ['unsafe-parent', 'existing-env', 'existing-data', 'missing-mount']) run(failure);
console.log('PASS: initializer refuses missing mounts/unsafe parents/existing data and never prints generated secrets.');
