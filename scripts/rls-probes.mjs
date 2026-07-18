#!/usr/bin/env node
/**
 * Live RLS containment probes (Phase-1 hardening, WP4).
 *
 * Talks directly to Supabase PostgREST (bypassing the NestJS guard) to prove the
 * database-layer defence holds on its own: a data_entry user, using a real
 * Supabase JWT, must see ONLY its own tenant's rows, and an anonymous caller
 * must see none — for every tenant-scoped table.
 *
 * For each table we assert three things, which together also rule out a false
 * pass from a missing GRANT (which would return an error/empty for everyone and
 * look like "containment"):
 *   1. anon count  == 0                 (no policy → nothing leaks unauthenticated)
 *   2. entry count  > 0                 (own rows ARE visible → the SELECT grant exists)
 *   3. entry count == own-tenant count  (EXACTLY its accessible tenants' rows and no
 *                                        others — catches a partial cross-tenant leak,
 *                                        which a mere "strict subset" check would miss)
 *
 * Standalone: `node scripts/rls-probes.mjs` (reads local env; needs Supabase up).
 * Reused as the `rls-for-table` skill's "Verify" evidence. Not wired into CI
 * (Phase 2 — needs Supabase in Actions).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// --- env ---------------------------------------------------------------------
function readVar(file, key) {
  try {
    const m = readFileSync(resolve(ROOT, file), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
  } catch {
    return undefined;
  }
}
const URL_ = process.env.E2E_SUPABASE_URL || readVar('apps/web/.env.local', 'NEXT_PUBLIC_SUPABASE_URL');
const ANON = process.env.E2E_SUPABASE_ANON_KEY || readVar('apps/web/.env.local', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
const SERVICE = process.env.E2E_SUPABASE_SERVICE_KEY || readVar('apps/api/.env', 'SUPABASE_SERVICE_ROLE_KEY');
if (!URL_ || !ANON || !SERVICE) {
  console.error('Missing Supabase env (URL / anon / service_role). Is the local stack configured?');
  process.exit(2);
}

const ENTRY_EMAIL = 'entry@tonyai.local';
const PASSWORD = 'TonyAI!2026';
const TENANT_TABLES = [
  'activity_records',
  'locations',
  'evidence',
  'period_locks',
  'targets',
  'subsidiary_denominators',
];

// The two subsidiaries entry@tonyai.local has access to (Energy + Logistics).
const ENERGY = '22222222-2222-2222-2222-222222220001';
const LOGISTICS = '22222222-2222-2222-2222-222222220004';
const ACC = `(${ENERGY},${LOGISTICS})`;

// Service-role query that counts ONLY the rows belonging to entry's accessible
// tenants — the exact set entry must see. evidence has no subsidiary_id, so it is
// scoped through an inner-joined parent record.
const ACCESSIBLE_QUERY = {
  activity_records: `select=id&subsidiary_id=in.${ACC}`,
  locations: `select=id&subsidiary_id=in.${ACC}`,
  evidence: `select=id,activity_records!inner(subsidiary_id)&activity_records.subsidiary_id=in.${ACC}`,
  period_locks: `select=id&subsidiary_id=in.${ACC}`,
  targets: `select=id&subsidiary_id=in.${ACC}`,
  subsidiary_denominators: `select=id&subsidiary_id=in.${ACC}`,
};

// --- PostgREST helpers -------------------------------------------------------
async function count(table, { token, key = ANON, query = 'select=id' } = {}) {
  const headers = { apikey: key, Prefer: 'count=exact', Range: '0-0' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${URL_}/rest/v1/${table}?${query}`, { headers });
  // 200/206 with a content-range like "0-0/42" or "*/0"; anything else is a finding.
  if (![200, 206].includes(res.status)) {
    return { error: `${res.status} ${await res.text()}` };
  }
  const cr = res.headers.get('content-range') || '*/0';
  return { total: Number(cr.split('/')[1] || '0') };
}

async function getEntryToken() {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ENTRY_EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`entry token grant failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

function svc(method, path, body) {
  return fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// period_locks is empty in the seed → seed a temporary pair (one accessible to
// entry, one not) so the entry>0 and entry<service assertions have data.
async function seedPeriodLocks() {
  const r = await fetch(`${URL_}/rest/v1/profiles?role=eq.super_admin&select=id&limit=1`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  const adminId = (await r.json())[0]?.id;
  if (!adminId) throw new Error('could not resolve a super_admin profile id for the period_locks seed');
  // `id` has no DB default (Prisma generates the uuid client-side), so supply one.
  const base = { reporting_year: 2024, reporting_period: 'quarterly', period_value: 'ZZ', locked_by: adminId };
  const res = await svc('POST', 'period_locks', [
    { id: randomUUID(), ...base, subsidiary_id: '22222222-2222-2222-2222-222222220001' }, // Energy (entry-accessible)
    { id: randomUUID(), ...base, subsidiary_id: '22222222-2222-2222-2222-222222220003' }, // Mfg (NOT accessible)
  ]);
  if (!res.ok) throw new Error(`period_locks seed failed: ${res.status} ${await res.text()}`);
}
async function cleanupPeriodLocks() {
  await svc('DELETE', 'period_locks?period_value=eq.ZZ');
}

// --- run ---------------------------------------------------------------------
const failures = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

async function main() {
  console.log(`RLS containment probes → ${URL_}\n`);
  const token = await getEntryToken();
  await cleanupPeriodLocks(); // in case a previous run aborted
  await seedPeriodLocks();

  try {
    for (const table of TENANT_TABLES) {
      console.log(`▸ ${table}`);
      const anon = await count(table);
      const entry = await count(table, { token });
      // service_role must be presented as the Bearer JWT too — PostgREST derives
      // the DB role from Authorization, not from apikey (which only opens the gate).
      // Count exactly the rows of entry's accessible tenants.
      const accessible = await count(table, { token: SERVICE, key: SERVICE, query: ACCESSIBLE_QUERY[table] });

      if (anon.error) check(`${table}: anon read`, false, `unexpected status ${anon.error}`);
      else check(`${table}: anon sees nothing`, anon.total === 0, `count=${anon.total}`);

      if (entry.error) check(`${table}: entry read`, false, `unexpected status ${entry.error} (missing GRANT?)`);
      else check(`${table}: entry sees own rows`, entry.total > 0, `count=${entry.total}`);

      if (!entry.error && !accessible.error) {
        check(
          `${table}: entry sees exactly its own tenants (no cross-tenant leak)`,
          entry.total === accessible.total,
          `entry=${entry.total} == accessible=${accessible.total}`,
        );
      }
    }
  } finally {
    await cleanupPeriodLocks();
  }

  console.log('');
  if (failures.length) {
    console.error(`FAILED — ${failures.length} check(s): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('All RLS containment probes passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
