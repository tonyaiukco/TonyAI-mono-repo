/** Prove the connection used for owner-run privilege evidence is the runtime login. */
import { pathToFileURL } from 'node:url';

export const verifyRuntimeIdentity = async (query) => {
  const rows = await query('SELECT current_user, session_user');
  if (rows.length !== 1 || rows[0].current_user !== 'tonyai_runtime' || rows[0].session_user !== 'tonyai_runtime') {
    throw new Error('Refusing privilege evidence: current_user and session_user must both be tonyai_runtime.');
  }
  return rows[0];
};

export const run = async (env, makeClient, output = console.log) => {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const client = await makeClient({ datasourceUrl: env.DATABASE_URL, log: [] });
  let identity;
  try {
    identity = await verifyRuntimeIdentity((sql) => client.$queryRawUnsafe(sql));
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
    console.error('FAIL: runtime connection identity was not verified; credentials and driver details withheld.');
    process.exitCode = 1;
  });
}
