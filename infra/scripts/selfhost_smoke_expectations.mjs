/** Pure expectations for the pinned Auth, PostgREST, Storage and Caddy responses. */
export class SmokeExpectationError extends Error {}

export const assertTokenResponse = (service, positive, { status, body }) => {
  const expected = {
    storage: { negative: 400, positive: 200 },
    rest: { negative: 401, positive: 404 },
    auth: { negative: 403, positive: 200 },
  }[service];
  if (!expected || typeof positive !== 'boolean') throw new SmokeExpectationError('Invalid smoke expectation.');
  if (!positive && status >= 200 && status < 300) {
    throw new SmokeExpectationError(`${service}: forged token accepted.`);
  }
  if (status !== expected[positive ? 'positive' : 'negative']) {
    throw new SmokeExpectationError(`${service}: unexpected status code for ${positive ? 'valid' : 'forged'} token.`);
  }
  const correctBody = positive
    ? service !== 'rest' || body?.code === 'PGRST205'
    : service === 'storage' ? body?.statusCode === '403' && body?.error === 'Unauthorized'
      : service === 'rest' ? body?.code === 'PGRST301' : body?.error_code === 'bad_jwt';
  if (!correctBody) throw new SmokeExpectationError(`${service}: unexpected response code for ${positive ? 'valid' : 'forged'} token.`);
};

export const assertEdgeDenial = ({ status, body, headers = {} }) => {
  if (status !== 404 || body !== 'Not found' || 'www-authenticate' in headers || 'x-envoy-upstream-service-time' in headers) {
    throw new SmokeExpectationError('edge: expected Caddy denial, received an unexpected response.');
  }
};
