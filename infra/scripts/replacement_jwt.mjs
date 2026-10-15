/** Private pipe signer for fresh challenge tokens; never pass JWKs in arguments. */
import { readFileSync } from 'node:fs';
import { createPrivateKey, createHmac, sign } from 'node:crypto';
try {
  const { key, claims, algorithm } = JSON.parse(readFileSync(0, 'utf8'));
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  if (!['ES256', 'HS256'].includes(algorithm) || !['anon', 'service_role'].includes(claims.role)) throw new Error();
  const header = { alg: algorithm, typ: 'JWT', ...(algorithm === 'ES256' ? { kid: key.kid } : {}) };
  const unsigned = `${encode(header)}.${encode(claims)}`;
  const signature = algorithm === 'ES256'
    ? sign('sha256', Buffer.from(unsigned), { key: createPrivateKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' })
    : createHmac('sha256', key).update(unsigned).digest();
  process.stdout.write(`${unsigned}.${signature.toString('base64url')}`);
} catch { process.stderr.write('FAIL: private challenge signing refused.\n'); process.exitCode = 1; }
