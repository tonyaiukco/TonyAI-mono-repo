/** Fresh-host Supabase secrets. Uses Node crypto; never emits secrets or passes them in argv. */
import { randomBytes, randomUUID, generateKeyPairSync, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const main = () => {
  const [directory] = process.argv.slice(2);
  if (process.getuid() !== 0 || process.argv.length !== 3 || directory !== '/opt/tonyai/supabase') {
    throw new Error('Use the fixed runtime directory as root.');
  }
  for (const path of ['/opt', '/opt/tonyai', directory]) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Unsafe runtime parent.');
  }
  for (const disk of ['database', 'objects']) execFileSync('mountpoint', ['-q', '/srv/tonyai/' + disk]);
  const contract = JSON.parse(readFileSync('/etc/tonyai/host.json', 'utf8'));
  const hostname = contract.public_hostname;
  if (!/^[a-z0-9.-]+\.swedencentral\.(sysgen\.)?cloudapp\.azure\.com$/.test(hostname)
      || !/^[^\s'<>@]+@[^\s'<>@]+\.[^\s'<>@]+$/.test(contract.operator_email)) throw new Error('Invalid reviewed host contract.');
  const target = resolve(directory, '.env');
  const postgres = '/srv/tonyai/database/postgres';
  if (existsSync(target) || (existsSync(postgres) && readdirSync(postgres).length)) {
    throw new Error('Existing secrets or database require explicit rotation, never initialization.');
  }
  process.umask(0o077);
  for (const path of [postgres, '/srv/tonyai/objects/storage', '/srv/tonyai/database/caddy-data', '/srv/tonyai/database/caddy-config']) {
    mkdirSync(path, { recursive: true, mode: 0o750 });
  }
  const hex = (bytes) => randomBytes(bytes).toString('hex');
  const base64 = (bytes) => randomBytes(bytes).toString('base64');
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwtSecret = base64(48);
  const issued = Math.floor(Date.now() / 1000);
  const token = (role) => {
    const data = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, iss: 'supabase', iat: issued, exp: issued + 5 * 365 * 86400 })}`;
    return `${data}.${createHmac('sha256', jwtSecret).update(data).digest('base64url')}`;
  };
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: 'ES256', key_ops: ['sign', 'verify'] };
  const publicJwk = { ...privateJwk, key_ops: ['verify'] };
  delete publicJwk.d;
  // Internal verification set includes the legacy key; it must never be served as public JWKS.
  const legacy = { kty: 'oct', k: Buffer.from(jwtSecret).toString('base64url'), alg: 'HS256' };
  const origin = `https://${hostname}`;
  const settings = {
    COMPOSE_FILE: 'docker-compose.yml:compose.qa.yml:compose.https.yml:compose.images.json',
    POSTGRES_PASSWORD: hex(32), JWT_SECRET: jwtSecret,
    ANON_KEY: token('anon'), SERVICE_ROLE_KEY: token('service_role'),
    JWT_KEYS: JSON.stringify([privateJwk, legacy]), JWT_JWKS: JSON.stringify({ keys: [publicJwk, legacy] }),
    SECRET_KEY_BASE: base64(48), REALTIME_DB_ENC_KEY: hex(8), VAULT_ENC_KEY: hex(16),
    PG_META_CRYPTO_KEY: base64(24), LOGFLARE_PUBLIC_ACCESS_TOKEN: base64(24), LOGFLARE_PRIVATE_ACCESS_TOKEN: base64(24),
    S3_PROTOCOL_ACCESS_KEY_ID: hex(16), S3_PROTOCOL_ACCESS_KEY_SECRET: hex(32), MINIO_ROOT_PASSWORD: hex(32),
    DASHBOARD_USERNAME: 'tonyaiops', DASHBOARD_PASSWORD: hex(32),
    PUBLIC_HOSTNAME: hostname, ACME_EMAIL: contract.operator_email, SUPABASE_PUBLIC_URL: origin, API_EXTERNAL_URL: `${origin}/auth/v1`,
    SITE_URL: origin, ADDITIONAL_REDIRECT_URLS: '', DISABLE_SIGNUP: 'true',
    ENABLE_EMAIL_SIGNUP: 'true', ENABLE_EMAIL_AUTOCONFIRM: 'false', ENABLE_ANONYMOUS_USERS: 'false',
    ENABLE_PHONE_SIGNUP: 'false', ENABLE_PHONE_AUTOCONFIRM: 'false', JWT_EXPIRY: '3600',
    FUNCTIONS_VERIFY_JWT: 'true', SMTP_HOST: '', SMTP_PORT: '587', SMTP_USER: '', SMTP_PASS: '',
    SMTP_ADMIN_EMAIL: contract.operator_email, SMTP_SENDER_NAME: 'TonyAI',
    STUDIO_DEFAULT_ORGANIZATION: 'TonyAI QA', STUDIO_DEFAULT_PROJECT: 'QA',
    POOLER_TENANT_ID: 'tonyai-staging', GLOBAL_S3_BUCKET: 'tonyai-qa', STORAGE_TENANT_ID: 'tonyai-staging', REGION: 'swedencentral',
  };
  const assigned = new Set();
  const lines = readFileSync(resolve(directory, '.env.example'), 'utf8').split('\n').map((line) => {
    const match = /^([A-Z_0-9]+)=/.exec(line);
    if (!match || !Object.hasOwn(settings, match[1])) return line;
    assigned.add(match[1]);
    return `${match[1]}='${settings[match[1]]}'`;
  });
  for (const [key, value] of Object.entries(settings)) {
    if (!assigned.has(key)) lines.push(`${key}='${value}'`);
  }
  writeFileSync(target, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('PASS: fresh QA credentials generated in the root-only runtime environment file.');
};

try { main(); } catch { console.error('FAIL: secret initialization refused or interrupted; inspect privately before retrying.'); process.exitCode = 1; }
