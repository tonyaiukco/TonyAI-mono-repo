/** Invoke the selected-source checker inside one read-only transaction. */
export const checkRoles = async (client, checkAll, operation) => {
  const identity = operation === 'owner-check' ? 'postgres' : operation === 'runtime-check' ? 'tonyai_runtime' : null;
  if (!identity) throw new Error('Unknown privilege check.');
  const report = await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const rows = await tx.$queryRawUnsafe('SELECT current_user, session_user');
    if (rows.length !== 1 || rows[0].current_user !== identity || rows[0].session_user !== identity) {
      throw new Error('Privilege-check identity differs.');
    }
    return checkAll((sql) => tx.$queryRawUnsafe(sql));
  }, { timeout: 120_000 });
  const { problems, exposures, platformDefaults, library } = report;
  if (![problems, exposures, platformDefaults, library?.notices, library?.skipped].every(Array.isArray)
      || problems.length || exposures.length || library.notices.length
      || (operation === 'owner-check' && library.skipped.length)) {
    throw new Error('Privilege or factor-library checks refused.');
  }
  return { status: 'PRIVILEGES_CHECKED', identity, platform_default_findings: platformDefaults.length,
    library_skipped: library.skipped.length, findings_require_owner_review: platformDefaults.length > 0 };
};

export const runRoleCheck = async (url, operation) => {
  const { PrismaClient } = await import('/app/packages/db/generated/client/index.js');
  const { checkAll } = await import('/migration/packages/db/scripts/runtime-role.mjs');
  const client = new PrismaClient({ datasourceUrl: url, log: [] });
  try { return await checkRoles(client, checkAll, operation); }
  finally { await client.$disconnect(); }
};
