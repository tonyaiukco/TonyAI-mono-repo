/** Local protection budgets, not a throughput or availability qualification. */
export const LIMIT_DEFAULTS = {
  RATE_IP_PER_MINUTE: 120, RATE_READ_PER_MINUTE: 120, RATE_WRITE_PER_MINUTE: 60,
  RATE_EXPORT_PER_MINUTE: 5, RATE_IMPORT_PER_MINUTE: 5, RATE_SUBMIT_PER_MINUTE: 10,
  RATE_MAX_KEYS: 10_000, HTTP_MAX_INFLIGHT: 32, HTTP_IP_MAX_INFLIGHT: 8,
  UPLOAD_CONCURRENCY: 2, UPLOAD_USER_CONCURRENCY: 1, SHUTDOWN_GRACE_MS: 120_000,
  MUTATION_CONCURRENCY: 2, MUTATION_USER_CONCURRENCY: 1,
  HTTP_HEADER_BYTES: 16_384, HTTP_HEADERS_TIMEOUT_MS: 10_000,
  HTTP_BODY_TIMEOUT_MS: 30_000, HTTP_KEEPALIVE_MS: 5_000,
  BODY_MAX_BYTES: 102_400, BODY_MAX_PARAMETERS: 100,
  IMPORT_CONCURRENCY: 1, IMPORT_PARSE_TIMEOUT_MS: 5_000,
  BULK_DEADLINE_MS: 60_000, REPORT_CONCURRENCY: 1, PDF_TIMEOUT_MS: 30_000,
  REPORT_RECORD_LIMIT: 5_000, REPORT_EVIDENCE_LINK_LIMIT: 10_000,
  REPORT_MAX_BYTES: 20_971_520, DB_CONNECTION_LIMIT: 5, DB_POOL_TIMEOUT_SECONDS: 5,
} as const;
export type LimitName = keyof typeof LIMIT_DEFAULTS;
export type RuntimeConfig = Record<LimitName, number> & {
  proxyMode: 'direct' | 'azure' | 'cidr'; trustedProxies: string[];
};

export const readRuntimeConfig = (env: NodeJS.ProcessEnv = process.env): RuntimeConfig => {
  const values = {} as Record<LimitName, number>;
  for (const name of Object.keys(LIMIT_DEFAULTS) as LimitName[]) {
    const raw = env[name];
    const value = raw === undefined ? LIMIT_DEFAULTS[name] : Number(raw);
    // Bound timer values too: Node clamps overflowing delays to one millisecond.
    if ((raw !== undefined && !/^[1-9]\d*$/.test(raw)) || !Number.isSafeInteger(value)
      || value <= 0 || value > 2_147_483_647) throw new Error(`Invalid runtime setting: ${name}`);
    values[name] = value;
  }
  const proxyMode = env.PROXY_MODE ?? 'direct';
  if (!['direct', 'azure', 'cidr'].includes(proxyMode)) throw new Error('Invalid PROXY_MODE');
  const trustedProxies = env.TRUSTED_PROXY_CIDRS?.split(',').map((s) => s.trim()) ?? [];
  if ((proxyMode === 'cidr') !== (trustedProxies.length > 0)
    || trustedProxies.some((s) => !s || s === '0.0.0.0/0' || s === '::/0')) {
    throw new Error('TRUSTED_PROXY_CIDRS must name only explicit trusted networks');
  }
  if (proxyMode === 'azure' && env.AZURE_INGRESS_ONLY !== 'true') {
    throw new Error('Azure proxy mode requires verified ingress-only reachability');
  }
  if (values.UPLOAD_USER_CONCURRENCY > values.UPLOAD_CONCURRENCY
    || values.SHUTDOWN_GRACE_MS < Math.max(values.BULK_DEADLINE_MS, values.PDF_TIMEOUT_MS) + 50_000
    || values.SHUTDOWN_GRACE_MS > 3_600_000
    || values.HTTP_HEADERS_TIMEOUT_MS > values.HTTP_BODY_TIMEOUT_MS
    || values.MUTATION_USER_CONCURRENCY > values.MUTATION_CONCURRENCY
    || values.MUTATION_CONCURRENCY >= values.DB_CONNECTION_LIMIT
    || values.IMPORT_CONCURRENCY + values.REPORT_CONCURRENCY >= values.DB_CONNECTION_LIMIT) {
    throw new Error('Incompatible runtime budgets');
  }
  return { ...values, proxyMode: proxyMode as RuntimeConfig['proxyMode'], trustedProxies };
};

/** Called before Nest constructs Prisma. Never include credentials in errors. */
export const configurePool = (config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env): void => {
  if (!env.DATABASE_URL) return;
  let url: URL;
  try { url = new URL(env.DATABASE_URL); } catch { throw new Error('Invalid runtime database URL'); }
  for (const [key, expected] of [
    ['connection_limit', config.DB_CONNECTION_LIMIT],
    ['pool_timeout', config.DB_POOL_TIMEOUT_SECONDS],
  ] as const) {
    const current = url.searchParams.getAll(key);
    if (current.length > 1 || (current.length === 1 && (!/^[1-9]\d*$/.test(current[0]) || Number(current[0]) > 2_147_483_647))) {
      throw new Error(`Runtime database URL conflicts with ${key}`);
    }
    // Environment is authoritative, including old stored URLs with valid pool settings.
    url.searchParams.set(key, String(expected));
  }
  env.DATABASE_URL = url.toString();
};
