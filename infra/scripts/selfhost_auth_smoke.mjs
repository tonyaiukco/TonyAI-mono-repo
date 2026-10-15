/** Root-only QA acceptance. Admin credentials stay on loopback, including during edge tests. */
import { readFileSync } from 'node:fs';
import { createPublicKey, verify, randomUUID, randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { assertTokenResponse, assertEdgeDenial, SmokeExpectationError } from './selfhost_smoke_expectations.mjs';

let stage = 'configuration';
const main = async () => {
  if (process.getuid() !== 0 || process.argv.slice(2).some((arg) => arg !== '--edge') || process.argv.length > 3) throw new Error('Invalid smoke invocation.');
  const edge = process.argv.includes('--edge');
  const env = Object.fromEntries(readFileSync('/opt/tonyai/supabase/.env', 'utf8').split('\n')
    .map((line) => /^([A-Z_0-9]+)='(.*)'$/.exec(line)).filter(Boolean).map((match) => [match[1], match[2]]));
  const contract = JSON.parse(readFileSync('/etc/tonyai/host.json', 'utf8'));
  const origin = env.SUPABASE_PUBLIC_URL;
  if (origin !== 'https://' + contract.public_hostname || env.API_EXTERNAL_URL !== origin + '/auth/v1') throw new Error('Origin differs from reviewed deployment.');
  const request = async (path, method = 'GET', body, service = false, extra = {}) => {
    const key = service ? env.SERVICE_ROLE_KEY : env.ANON_KEY;
    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra };
    const options = { method, headers, signal: AbortSignal.timeout(15000) };
    const payload = body ? JSON.stringify(body) : undefined;
    // Test the real TLS/SNI edge while the NSG is closed. No disabled certificate checks.
    if (edge && !service) return new Promise((resolve, reject) => {
      const req = httpsRequest(new URL(origin), { ...options, path, agent: false,
        lookup: (_name, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) }, (res) => {
        let data = ''; res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => { let value = data; try { value = JSON.parse(data); } catch { /* Denied routes need no JSON. */ }
          resolve({ status: res.statusCode, body: value, rawBody: data, headers: res.headers }); });
      });
      req.on('error', reject); req.end(payload);
    });
    const response = await fetch('http://127.0.0.1:8000' + path, { ...options, redirect: 'error', body: payload });
    const text = await response.text();
    let value = text; try { value = JSON.parse(text); } catch { /* Preserve literal edge denials. */ }
    return { status: response.status, body: value, rawBody: text, headers: Object.fromEntries(response.headers) };
  };
  stage = 'public JWKS';
  const jwks = await request('/auth/v1/.well-known/jwks.json');
  if (jwks.status !== 200 || !jwks.body.keys?.length || jwks.body.keys.some((key) => !['EC', 'RSA'].includes(key.kty)
    || ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'].some((field) => field in key))) throw new Error('Unsafe public JWKS.');
  const verifyToken = (token) => {
    const [header, payload, signature] = token.split('.');
    const meta = JSON.parse(Buffer.from(header, 'base64url'));
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    const jwk = jwks.body.keys.find((key) => key.kid === meta.kid);
    if (meta.alg !== 'ES256' || !jwk || !verify('SHA256', Buffer.from(`${header}.${payload}`),
      { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
      || claims.iss !== env.API_EXTERNAL_URL || claims.aud !== 'authenticated'
      || !claims.amr?.some((item) => item.method === 'password')) throw new Error('Token signature or password-AMR contract failed.');
    return claims;
  };
  stage = 'anonymous administration denial';
  if (![401, 403].includes((await request('/auth/v1/admin/users')).status)) throw new Error('Anon accessed administration.');
  const id = randomUUID();
  const email = `qa-auth-${id}@tonyai.invalid`;
  const password = randomBytes(24).toString('hex') + 'Aa1!';
  let attempted = false;
  let createReturned = false;
  let failedStage;
  let failedExpectation;
  try {
    stage = 'disabled signup';
    const signup = await request('/auth/v1/signup', 'POST', { email, password });
    if (!(edge ? [404] : [400, 403, 422]).includes(signup.status)) throw new Error('Signup was not disabled.');
    stage = 'application-assigned UUID';
    attempted = true;
    const created = await request('/auth/v1/admin/users', 'POST', { id, email, password, email_confirm: true }, true);
    createReturned = true;
    if (![200, 201].includes(created.status) || created.body.id !== id) throw new Error('User creation failed.');
    stage = 'ES256 password login';
    const login = await request('/auth/v1/token?grant_type=password', 'POST', { email, password });
    if (login.status !== 200 || verifyToken(login.body.access_token).sub !== id) throw new Error('Password login failed.');
    stage = 'refresh and password AMR';
    const refreshed = await request('/auth/v1/token?grant_type=refresh_token', 'POST', { refresh_token: login.body.refresh_token });
    if (refreshed.status !== 200 || verifyToken(refreshed.body.access_token).sub !== id) throw new Error('Refresh failed.');
    stage = 'valid token controls';
    for (const [service, path] of [['storage', '/storage/v1/bucket'], ['rest', '/rest/v1/tonyai_smoke_missing'], ['auth', '/auth/v1/user']]) {
      assertTokenResponse(service, true, await request(path, 'GET', undefined, false, { Authorization: 'Bearer ' + login.body.access_token }));
    }
    stage = 'forged token rejection';
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = encode({ sub: id, role: 'service_role', aud: 'authenticated', iss: env.API_EXTERNAL_URL, exp: Math.floor(Date.now() / 1000) + 300 });
    const data = encode({ alg: 'ES256', kid: jwks.body.keys[0].kid }) + '.' + payload;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const forged = data + '.' + sign('SHA256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    for (const token of [encode({ alg: 'none' }) + '.' + payload + '.', forged]) {
      for (const [service, path] of [['auth', '/auth/v1/user'], ['auth', '/auth/v1/admin/users'],
        ['rest', '/rest/v1/tonyai_smoke_missing'], ['storage', '/storage/v1/bucket']]) {
        assertTokenResponse(service, false, await request(path, 'GET', undefined, false, { Authorization: 'Bearer ' + token }));
      }
    }
    if (edge) {
      stage = 'edge route restrictions';
      for (const path of ['/Auth/v1/user', '/REST/v1/', '/project/default', '/pg', '/mcp', '/functions/v1/',
        '/auth/v1/signup', '/auth/v1/recover', '/auth/v1/otp', '/auth/v1/magiclink', '/auth/v1/resend', '/auth/v1/authorize', '/auth/v1/sso',
        '/graphql/v1', '/realtime/v1/', '/storage/v1/upload/resumable', '/auth/v1/admin/audit',
        '/auth/v1/admin/users/' + id + '/factors', '/rest/v1/..;/..;/auth/v1/recover',
        '/rest/v1/..;/..;/project/default', '/storage/v1/object/..;/..;/storage/v1/s3', '/rest/v1/.;/x',
        '/storage/v1/s3', '/storage/v1/render', '/storage/v1/render/image/authenticated/smoke/missing',
        '/auth//v1/user', '/auth/v1/./user', '/auth/v1/%2e/user',
        '/auth/v1/%2e%2e/v1/user', '/auth%2f/v1/user', '/auth/v1/%2e%2e/v1/recover']) {
        const response = await request(path);
        assertEdgeDenial({ ...response, body: response.rawBody });
      }
      stage = 'IP rate limit and header spoofing';
      const before = Date.now();
      const attempts = await Promise.all(Array.from({ length: 40 }, (_, n) => request('/auth/v1/verify', 'POST',
        { type: 'recovery', email: 'missing-' + email, token: '0000000000' }, false,
        { 'X-Forwarded-For': `198.51.100.${n + 1}`, 'Sb-Forwarded-For': `203.0.113.${n + 1}` })));
      if (Date.now() - before >= 10000 || !attempts.some((r) => r.status === 429)) throw new Error('Rate limiter absent or timing inconclusive.');
      for (let n = 0; n < 3; n++) {
        if ((await request('/auth/v1/verify', 'POST', { type: 'recovery', email: 'missing-' + email, token: '0000000000' }, false,
          { 'X-Forwarded-For': `192.0.2.${n + 1}`, 'Sb-Forwarded-For': `192.0.2.${n + 10}` })).status !== 429) throw new Error('Spoofed IP bypassed limiter.');
      }
    }
  } catch (error) { failedStage = stage; if (error instanceof SmokeExpectationError) failedExpectation = error; }
  if (attempted) {
    stage = 'synthetic user reconciliation and cleanup';
    const existing = await request('/auth/v1/admin/users/' + id, 'GET', undefined, true);
    if (existing.status === 404 && !createReturned) throw new Error('Creation outcome uncertain; explicit reconciliation required.');
    if (existing.status !== 404) {
      if (existing.status !== 200 || existing.body.email !== email || existing.body.id !== id) throw new Error('Cleanup identity mismatch.');
      if ((await request('/auth/v1/admin/users/' + id, 'DELETE', undefined, true)).status !== 200) throw new Error('Cleanup failed.');
    }
  }
  if (failedStage) { stage = failedStage; throw failedExpectation ?? new Error('Acceptance failed.'); }
  console.log('PASS: JWKS, signup/admin denial, ES256 login/refresh, forged-token rejection and synthetic cleanup' + (edge ? ', TLS edge routes and spoof-resistant IP rate limit.' : '.'));
};
main().catch((error) => { console.error('FAIL: Auth acceptance at ' + stage + (error instanceof SmokeExpectationError ? ': ' + error.message : '; sensitive diagnostics withheld.')); process.exitCode = 1; });
