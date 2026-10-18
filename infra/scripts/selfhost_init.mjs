/** Fresh-host Supabase secrets. Uses Node crypto; never emits secrets or passes them in argv. */
import { randomBytes, randomUUID, generateKeyPairSync, createHmac, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const createSettings = (hostname, operatorEmail) => {
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
    SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SECRET_KEY: '', ANON_KEY_ASYMMETRIC: '', SERVICE_ROLE_KEY_ASYMMETRIC: '',
    OPENAI_API_KEY: '', GOOGLE_PROJECT_ID: '', GOOGLE_PROJECT_NUMBER: '',
    POSTGRES_HOST: 'db', POSTGRES_DB: 'postgres', POSTGRES_PORT: '5432',
    POOLER_PROXY_PORT_TRANSACTION: '6543', POOLER_DEFAULT_POOL_SIZE: '20', POOLER_MAX_CLIENT_CONN: '100', POOLER_DB_POOL_SIZE: '5',
    MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify', MAILER_URLPATHS_INVITE: '/auth/v1/verify',
    MAILER_URLPATHS_RECOVERY: '/auth/v1/verify', MAILER_URLPATHS_EMAIL_CHANGE: '/auth/v1/verify',
    MINIO_ROOT_USER: 'tonyai-storage', PGRST_DB_SCHEMAS: 'public,graphql_public', PGRST_DB_MAX_ROWS: '1000',
    PGRST_DB_EXTRA_SEARCH_PATH: 'public', DOCKER_SOCKET_LOCATION: '/var/run/docker.sock',
    API_GW_HTTP_PORT: '8000', KONG_HTTP_PORT: '8000', KONG_HTTPS_PORT: '8443', IMGPROXY_AUTO_WEBP: 'true',
    PROXY_DOMAIN: hostname, CERTBOT_EMAIL: operatorEmail,
    COMPOSE_FILE: 'docker-compose.yml:compose.qa.yml:compose.https.yml:compose.r02.yml:compose.images.json',
    POSTGRES_PASSWORD: hex(32), JWT_SECRET: jwtSecret,
    ANON_KEY: token('anon'), SERVICE_ROLE_KEY: token('service_role'),
    JWT_KEYS: JSON.stringify([privateJwk, legacy]), JWT_JWKS: JSON.stringify({ keys: [publicJwk, legacy] }),
    SECRET_KEY_BASE: base64(48), REALTIME_DB_ENC_KEY: base64(12), VAULT_ENC_KEY: base64(24),
    // Realtime v2.134.10 consumes 32 raw bytes, not decoded base64: 192 bits of entropy.
    REALTIME_DB_ENC_KEY_GCM: base64(24),
    PG_META_CRYPTO_KEY: base64(24), LOGFLARE_PUBLIC_ACCESS_TOKEN: base64(24), LOGFLARE_PRIVATE_ACCESS_TOKEN: base64(24),
    S3_PROTOCOL_ACCESS_KEY_ID: hex(16), S3_PROTOCOL_ACCESS_KEY_SECRET: hex(32), MINIO_ROOT_PASSWORD: hex(32),
    DASHBOARD_USERNAME: 'tonyaiops', DASHBOARD_PASSWORD: hex(32),
    PUBLIC_HOSTNAME: hostname, ACME_EMAIL: operatorEmail, SUPABASE_PUBLIC_URL: origin, API_EXTERNAL_URL: `${origin}/auth/v1`,
    SITE_URL: origin, ADDITIONAL_REDIRECT_URLS: '', DISABLE_SIGNUP: 'true',
    ENABLE_EMAIL_SIGNUP: 'true', ENABLE_EMAIL_AUTOCONFIRM: 'false', ENABLE_ANONYMOUS_USERS: 'false',
    ENABLE_PHONE_SIGNUP: 'false', ENABLE_PHONE_AUTOCONFIRM: 'false', JWT_EXPIRY: '3600',
    FUNCTIONS_VERIFY_JWT: 'true', SMTP_HOST: '', SMTP_PORT: '587', SMTP_USER: '', SMTP_PASS: '',
    SMTP_ADMIN_EMAIL: operatorEmail, SMTP_SENDER_NAME: 'TonyAI',
    STUDIO_DEFAULT_ORGANIZATION: 'TonyAI QA', STUDIO_DEFAULT_PROJECT: 'QA',
    POOLER_TENANT_ID: 'tonyai-staging', GLOBAL_S3_BUCKET: 'tonyai-qa', STORAGE_TENANT_ID: 'tonyai-staging', REGION: 'swedencentral',
  };
  return settings;
};

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
  // The helper returns status only and checks every disk/source before any write.
  execFileSync('/usr/bin/python3', ['-I', '-B', '/usr/local/lib/tonyai/replacement_host.py', 'fresh'], { stdio: 'pipe' });
  const contract = JSON.parse(readFileSync('/etc/tonyai/replacement.json', 'utf8'));
  if (contract.generation !== 'r02') throw new Error('Replacement generation required.');
  const hostname = contract.public_hostname;
  if (!/^[a-z0-9.-]+\.swedencentral\.(sysgen\.)?cloudapp\.azure\.com$/.test(hostname)
      || !/^[^\s'<>@]+@[^\s'<>@]+\.[^\s'<>@]+$/.test(contract.operator_email)) throw new Error('Invalid reviewed host contract.');
  const target = resolve(directory, '.env');
  const postgres = '/srv/tonyai/database/postgres';
  if (existsSync(target) || (existsSync(postgres) && readdirSync(postgres).length)) {
    throw new Error('Existing secrets or database require explicit rotation, never initialization.');
  }
  const template = readFileSync(resolve(directory, '.env.example'), 'utf8');
  const inventory = JSON.parse(readFileSync(resolve(directory, 'credential-template.json'), 'utf8'));
  if (createHash('sha256').update(template).digest('hex') !== inventory.template_sha256
      || inventory.template_sha256 !== 'd27fb4516702358ac5965fb06d207736abeb3c26c7d949f19b90e88b25e694ef') throw new Error('Unreviewed template.');
  const fields = template.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
    const match = /^([A-Z_0-9]+)=/.exec(line);
    if (!match) throw new Error('Malformed assignment.');
    return match[1];
  });
  if (new Set(fields).size !== fields.length || fields.sort().join() !== Object.keys(inventory.fields).sort().join()) throw new Error('Unclassified template fields.');
  process.umask(0o077);
  writeFileSync('/etc/tonyai/initialization-r02.json', JSON.stringify({ generation: 'r02', vm_id: contract.vm_id, source_sha256: contract.source_sha256, state: 'started' }), { flag: 'wx', mode: 0o600 });
  for (const path of [postgres, '/srv/tonyai/objects/storage', '/srv/tonyai/database/caddy-data', '/srv/tonyai/database/caddy-config']) {
    mkdirSync(path, { recursive: true, mode: 0o750 });
  }
  const settings = createSettings(hostname, contract.operator_email);
  if (fields.some((key) => !Object.hasOwn(settings, key))) throw new Error('Unconfigured template field.');
  const lines = Object.entries(settings).map(([key, value]) => {
    if (/[\r\n']/.test(value)) throw new Error('Unsafe environment serialization.');
    return `${key}='${value}'`;
  });
  writeFileSync(target, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('PASS: fresh QA credentials generated in the root-only runtime environment file.');
};

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch { console.error('FAIL: secret initialization refused or interrupted; inspect privately before retrying.'); process.exitCode = 1; }
}
