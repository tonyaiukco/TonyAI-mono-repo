import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTokenResponse, assertEdgeDenial } from '../scripts/selfhost_smoke_expectations.mjs';

const accepted = [
  ['storage', false, 400, { statusCode: '403', error: 'Unauthorized' }],
  ['storage', true, 200, []],
  ['rest', false, 401, { code: 'PGRST301' }],
  ['rest', true, 404, { code: 'PGRST205' }],
  ['auth', false, 403, { error_code: 'bad_jwt' }],
  ['auth', true, 200, { id: 'synthetic-user' }],
];
for (const [service, positive, status, body] of accepted) {
  test(`${service}: exact ${positive ? 'positive' : 'negative'} response`, () => {
    assert.doesNotThrow(() => assertTokenResponse(service, positive, { status, body }));
  });
}
for (const [service, positive, status, body, reason] of [
  ['storage', false, 200, [], /forged token accepted/],
  ['storage', false, 400, { statusCode: '404', error: 'Unauthorized' }, /unexpected response code/],
  ['storage', false, 400, { statusCode: 403, error: 'Unauthorized' }, /unexpected response code/],
  ['storage', false, 400, { statusCode: '403', error: 'Other' }, /unexpected response code/],
  ['rest', false, 403, {}, /unexpected status code/],
  ['rest', false, 401, { code: 'OTHER' }, /unexpected response code/],
  ['rest', true, 404, { code: 'OTHER' }, /unexpected response code/],
  ['auth', false, 403, { error_code: 'not_admin' }, /unexpected response code/],
  ['auth', false, 401, { error_code: 'bad_jwt' }, /unexpected status code/],
  ...['auth', 'rest', 'storage'].map((service) => [service, true, 401, {}, /unexpected status code/]),
]) {
  test(`${service}: reject ${positive ? 'positive' : 'negative'} mismatch ${status} ${JSON.stringify(body)}`, () => {
    assert.throws(() => assertTokenResponse(service, positive, { status, body }), reason);
  });
}
test('edge: only the literal Caddy denial passes', () => {
  assert.doesNotThrow(() => assertEdgeDenial({ status: 404, body: 'Not found', headers: {} }));
  for (const response of [
    { status: 404, body: { code: 'PGRST205' } },
    { status: 404, body: 'Not found\n' },
    { status: 404, body: '"Not found"' },
    { status: 200, body: 'Not found' },
    { status: 404, body: 'Not found', headers: { 'www-authenticate': '' } },
    { status: 404, body: 'Not found', headers: { 'x-envoy-upstream-service-time': '0' } },
  ]) assert.throws(() => assertEdgeDenial(response), /expected Caddy denial/);
});
