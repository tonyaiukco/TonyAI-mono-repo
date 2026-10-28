/** Owner-workstation evidence for the hosted loader's session-pooler login. */
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CA_PATH = fileURLToPath(new URL('../certs/prod-ca-2021.crt', import.meta.url));
const ROLE = 'tonyai_factor_loader';

// Deliberately narrower than the CLI: this handoff qualifies only session 5432.
export const loaderUrl = (env) => {
  const value = env.FACTOR_LOADER_DATABASE_URL;
  const project = env.SUPABASE_PROJECT_REF;
  if (!value || !/^[a-z]{20}$/.test(project ?? '')) throw new Error('Loader URL and project reference are required.');
  const url = new URL(value);
  const params = new Map([
    ['sslmode', 'require'], ['sslaccept', 'strict'], ['sslcert', CA_PATH],
    ['connection_limit', '1'], ['connect_timeout', '15'],
  ]);
  if (url.protocol !== 'postgresql:' || url.username !== `${ROLE}.${project}` ||
      !/^[a-f0-9]{64}$/.test(url.password) ||
      !/^aws-\d+-eu-north-1\.pooler\.supabase\.com$/.test(url.hostname) ||
      url.port !== '5432' || url.pathname !== '/postgres' || url.hash ||
      [...url.searchParams].length !== params.size ||
      [...params].some(([key, expected]) => url.searchParams.get(key) !== expected)) {
    throw new Error('Loader endpoint, identity or strict TLS contract refused.');
  }
  return value;
};

export const verifyLoaderIdentity = async (query) => {
  const rows = await query('SELECT current_user, session_user');
  if (rows.length !== 1 || rows[0].current_user !== ROLE || rows[0].session_user !== ROLE) {
    throw new Error('Refusing loader evidence: current_user and session_user must both be tonyai_factor_loader.');
  }
  return rows[0];
};

export const run = async (env, makeClient, output = console.log) => {
  const client = await makeClient({ datasourceUrl: loaderUrl(env), log: [] });
  let identity;
  try {
    identity = await verifyLoaderIdentity((sql) => client.$queryRawUnsafe(sql));
  } finally {
    await client.$disconnect();
  }
  output(`PASS: current_user=${identity.current_user}; session_user=${identity.session_user}`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.env, async (options) => {
    const { PrismaClient } = await import('../../packages/db/generated/client/index.js');
    return new PrismaClient(options);
  }).catch(() => {
    console.error('FAIL: loader connection identity was not verified; credentials and driver details withheld.');
    process.exitCode = 1;
  });
}
