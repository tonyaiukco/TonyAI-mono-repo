/** Prove the connection used for owner-run privilege evidence is the runtime login. */
import { pathToFileURL } from 'node:url';

export const verifyRuntimeIdentity = async (query) => {
  const rows = await query('SELECT current_user, session_user');
  if (rows.length !== 1 || rows[0].current_user !== 'tonyai_runtime' || rows[0].session_user !== 'tonyai_runtime') {
    throw new Error('Refusing privilege evidence: current_user and session_user must both be tonyai_runtime.');
  }
  return rows[0];
};

const main = async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const { PrismaClient } = await import('../../packages/db/generated/client/index.js');
  const client = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [] });
  try {
    const identity = await verifyRuntimeIdentity((sql) => client.$queryRawUnsafe(sql));
    console.log(`PASS: current_user=${identity.current_user}; session_user=${identity.session_user}`);
  } finally {
    await client.$disconnect();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => {
    console.error('FAIL: runtime connection identity was not verified; credentials and driver details withheld.');
    process.exitCode = 1;
  });
}
