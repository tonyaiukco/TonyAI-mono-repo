// db-candidate02: manifest validator tests. Injected byte readers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalManifest, manifestSha256, parseCanonicalManifest, compareManifest, observeManifest, ManifestRefusal, MANIFEST_LIMITS } from '../scripts/r3_db_candidate/manifest.mjs';

const h = text => createHash('sha256').update(text).digest('hex');
const base = () => ({ 'driver.mjs': h('d'), 'fixture-sql.mjs': h('f'), 'prisma-adapter.mjs': h('p') });
const refusal = (expectedCode, problems) => error => error instanceof ManifestRefusal && error.code === expectedCode &&
  (problems === undefined || JSON.stringify(error.problems) === JSON.stringify(problems));

test('exact manifest matches and has a canonical hash', () => {
  const result = compareManifest(base(), { 'prisma-adapter.mjs': h('p'), 'driver.mjs': h('d'), 'fixture-sql.mjs': h('f') });
  assert.equal(result.status, 'MANIFEST_MATCH'); assert.equal(result.files, 3);
  assert.equal(result.manifest_sha256, h(canonicalManifest(base())));
  assert.equal(manifestSha256(base()), result.manifest_sha256);
  assert.deepEqual(parseCanonicalManifest(canonicalManifest(base())), base());
});
test('missing, extra and mismatching entries are all reported and refused', () => {
  const observed = { ...base(), 'evil.mjs': h('e'), 'driver.mjs': h('changed') }; delete observed['fixture-sql.mjs'];
  assert.throws(() => compareManifest(base(), observed), refusal('MANIFEST_MISMATCH', ['EXTRA:evil.mjs', 'MISMATCH:driver.mjs', 'MISSING:fixture-sql.mjs']));
  assert.throws(() => compareManifest(base(), { ...base(), 'x.mjs': h('x') }), refusal('MANIFEST_MISMATCH', ['EXTRA:x.mjs']));
});
test('digest format is exact lowercase sha256', () => {
  for (const value of [h('d').toUpperCase(), h('d').slice(1), h('d') + '0', 'sha256:' + h('d'), 1, null, ' ' + h('d')]) {
    assert.throws(() => compareManifest(base(), { ...base(), 'driver.mjs': value }), refusal('MANIFEST_DIGEST'));
  }
});
test('file names are flat and conservative', () => {
  for (const name of ['../driver.mjs', '/abs.mjs', 'dir/x.mjs', '.hidden', '..', 'a..b', 'a\\b', 'a' + String.fromCharCode(0) + 'b',
    'caf' + String.fromCharCode(0xe9), 'a b', '', 'x'.repeat(129), '__proto__']) {
    assert.throws(() => compareManifest(base(), { ...base(), [name]: h('x') }), refusal('MANIFEST_NAME'));
  }
  assert.throws(() => parseCanonicalManifest('{"__proto__":"' + h('x') + '"}\n'), refusal('MANIFEST_NAME'));
});
test('exotic manifest objects are refused', () => {
  const getter = Object.defineProperty({}, 'driver.mjs', { enumerable: true, get: () => h('d') });
  const hidden = Object.defineProperty({ ...base() }, 'z.mjs', { enumerable: false, value: h('z') });
  const symbol = { ...base(), [Symbol('x')]: h('x') };
  const proto = Object.assign(Object.create({ inherited: h('i') }), base());
  for (const value of [getter, hidden, symbol, proto, [h('d')], null, 'driver.mjs', new Map(Object.entries(base()))]) {
    assert.throws(() => compareManifest(base(), value), ManifestRefusal);
  }
  assert.throws(() => compareManifest({}, {}), refusal('MANIFEST_SIZE'));
  const big = Object.fromEntries(Array.from({ length: MANIFEST_LIMITS.files + 1 }, (_, i) => ['f' + i, h(String(i))]));
  assert.throws(() => compareManifest(big, big), refusal('MANIFEST_SIZE'));
});
test('only the canonical manifest text is accepted', () => {
  const text = canonicalManifest(base());
  const duplicate = text.replace('{', '{"driver.mjs":"' + h('evil') + '",');
  for (const value of [text.slice(0, -1), text + '\n', ' ' + text, JSON.stringify(base(), null, 2) + '\n',
    JSON.stringify({ 'prisma-adapter.mjs': h('p'), 'driver.mjs': h('d'), 'fixture-sql.mjs': h('f') }) + '\n', duplicate]) {
    assert.throws(() => parseCanonicalManifest(value), refusal('MANIFEST_NONCANONICAL'));
  }
  for (const value of ['{', 'null', '[]', 42, Buffer.from(text), String.fromCharCode(0xfeff) + text]) assert.throws(() => parseCanonicalManifest(value), ManifestRefusal);
});
test('observation hashes injected bytes and refuses bad readers', () => {
  const files = { 'driver.mjs': Buffer.from('d'), 'fixture-sql.mjs': new Uint8Array(Buffer.from('f')), 'prisma-adapter.mjs': Buffer.from('p') };
  const read = name => files[name];
  assert.deepEqual(observeManifest(Object.keys(files), read), base());
  assert.equal(compareManifest(base(), observeManifest(Object.keys(files), read)).status, 'MANIFEST_MATCH');
  assert.throws(() => observeManifest(['driver.mjs'], () => 'd'), refusal('OBSERVE_BYTES'));
  assert.throws(() => observeManifest(['driver.mjs'], () => { throw new Error('private path'); }), refusal('OBSERVE_READ', ['driver.mjs']));
  assert.throws(() => observeManifest(['driver.mjs'], () => ({ byteLength: 0 })), refusal('OBSERVE_BYTES'));
  assert.throws(() => observeManifest(['driver.mjs'], () => new Uint8Array(MANIFEST_LIMITS.fileBytes + 1)), refusal('OBSERVE_SIZE'));
  assert.throws(() => observeManifest(['driver.mjs', 'driver.mjs'], read), refusal('OBSERVE_DUPLICATE'));
  assert.throws(() => observeManifest(['../driver.mjs'], read), refusal('MANIFEST_NAME'));
  assert.throws(() => observeManifest('driver.mjs', read), refusal('OBSERVE_INPUT'));
  assert.throws(() => observeManifest([], read), refusal('MANIFEST_SIZE'));
});
