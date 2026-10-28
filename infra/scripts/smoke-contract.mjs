/** Public synthetic fixture contract. Credentials are accepted separately in memory. */
export function validateSmoke(target) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (target.mode === 'ci-local') {
    if (process.env.CI !== 'true' || target.web !== 'http://localhost:3000'
        || target.api !== 'http://localhost:3001/api/v1'
        || !['http://localhost:54321', 'http://127.0.0.1:54321'].includes(target.supabase)) {
      throw new Error('Only the isolated CI runner may use demo fixtures');
    }
    return target;
  }
  const sweden = target.mode === 'qa-sweden';
  const hosted = target.mode === 'staging' && /^[a-z]{20}$/.test(target.projectRef)
      && /^https:\/\/[a-z0-9]{3,12}-staging-web\.[a-z0-9-]+\.swedencentral\.azurecontainerapps\.io$/.test(target.web)
      && target.supabase === `https://${target.projectRef}.supabase.co`;
  const qa = sweden && !Object.hasOwn(target, 'projectRef')
      && /^https:\/\/tonyai-staging-web\.[a-z0-9-]+\.swedencentral\.azurecontainerapps\.io$/.test(target.web)
      && /^https:\/\/tonyai-staging-cb7efc2f-r02\.[a-z0-9-]+\.swedencentral\.cloudapp\.azure\.com$/.test(target.supabase)
      && /^[a-z][a-z0-9-]{0,29}$/.test(target.releaseId)
      && /^sha256:[a-f0-9]{64}$/.test(target.apiDigest) && /^sha256:[a-f0-9]{64}$/.test(target.webDigest)
      && /^[a-f0-9]{64}$/.test(target.dbCaSha256);
  if ((!hosted && !qa)
      || target.api !== target.web.replace('-staging-web.', '-staging-api.') + '/api/v1'
      || !/^[a-f0-9]{40}$/.test(target.sourceSha)
      || !Array.isArray(target.tenants) || target.tenants.length !== 2) {
    throw new Error('Invalid staging smoke target');
  }
  const ids = [];
  for (const tenant of target.tenants) {
    if (!uuid.test(tenant.userId) || !uuid.test(tenant.organisationId) || !uuid.test(tenant.subsidiaryId)
        || tenant.email !== `lp2-smoke-${tenant.userId}@tonyai.test`
        || !/^lp2-smoke-[a-z0-9-]+@tonyai\.test$/.test(tenant.email)
        || tenant.name !== `LP2 smoke ${tenant.organisationId}`) throw new Error('Invalid synthetic tenant');
    ids.push(tenant.userId, tenant.organisationId, tenant.subsidiaryId);
  }
  if (new Set(ids).size !== ids.length) throw new Error('Smoke fixtures must be disjoint');
  return target;
}
