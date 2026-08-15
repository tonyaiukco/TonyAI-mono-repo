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
const ADMIN_EMAIL = 'admin@tonyai.local';
const CONSULTANT_EMAIL = 'review@tonyai.local';
const PASSWORD = 'TonyAI!2026';
const TENANT_TABLES = [
  // `subsidiaries` was missing here until WP16 PR 2a, which is when it started
  // carrying contact PII (a named person's work email and phone). The blanket
  // "every table has RLS enabled" check at the end of this script covers only
  // the ENABLE bit, not what the policy actually returns — so the one table
  // holding personal data was the one whose containment was never asserted.
  'subsidiaries',
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
  // `subsidiaries` IS the tenant, so it scopes on `id`, not `subsidiary_id`.
  subsidiaries: `select=id&id=in.${ACC}`,
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

async function getToken(email) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`${email} token grant failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}
const getEntryToken = () => getToken(ENTRY_EMAIL);

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

// The seed writes no audit rows, so a fresh `db:reset` would leave the audit
// probes with nothing to measure. Seed two: one in the admin's organisation and
// one filed under a FOREIGN organisation — the latter is what proves the RLS
// tightening (a super_admin of org A must not read org B's rows), which a
// single-organisation seed otherwise cannot demonstrate.
const AUDIT_PROBE_ENTITY = 'rls_probe';
const FOREIGN_ORG = '99999999-9999-9999-9999-999999999999';
async function seedAuditRows() {
  const r = await fetch(`${URL_}/rest/v1/profiles?role=eq.super_admin&select=id,organisation_id&limit=1`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  const admin = (await r.json())[0];
  if (!admin) throw new Error('could not resolve a super_admin profile for the audit_log seed');
  const base = { action: 'create', entity: AUDIT_PROBE_ENTITY, user_id: admin.id, role: 'super_admin' };
  const res = await svc('POST', 'audit_log', [
    { id: randomUUID(), ...base, organisation_id: admin.organisation_id },
    { id: randomUUID(), ...base, organisation_id: FOREIGN_ORG },
  ]);
  if (!res.ok) throw new Error(`audit_log seed failed: ${res.status} ${await res.text()}`);
  return admin;
}
async function cleanupAuditRows() {
  await svc('DELETE', `audit_log?entity=eq.${AUDIT_PROBE_ENTITY}`);
}

// A subsidiary filed under a FOREIGN organisation. The seed has exactly one
// organisation, so without this the cross-ORG half of the subsidiaries policy
// is untestable — `data_entry` seeing 2 of 5 proves intra-org scoping only,
// and a policy that leaked every organisation's rows to a super_admin would
// still pass it. Carries contact values, so a leak would be visible as PII
// rather than as a bare count.
const FOREIGN_SUB_ID = '99999999-0000-0000-0000-000000000001';
async function seedForeignSubsidiary() {
  const now = new Date().toISOString();
  const org = await svc('POST', 'organisations', [
    {
      id: FOREIGN_ORG,
      legal_name: 'RLS probe — foreign organisation',
      country: 'GB',
      geography_code: 'UK',
      updated_at: now,
    },
  ]);
  if (!org.ok) throw new Error(`foreign organisation seed failed: ${org.status} ${await org.text()}`);
  const res = await svc('POST', 'subsidiaries', [
    {
      id: FOREIGN_SUB_ID,
      organisation_id: FOREIGN_ORG,
      legal_name: 'RLS probe — foreign subsidiary',
      geography_code: 'UK',
      contact_email: 'rls-probe@example.com',
      contact_phone: '+44 7700 900999',
      // `@updatedAt` is applied by Prisma, not by a DB default, so a direct
      // PostgREST insert has to supply it.
      updated_at: now,
    },
  ]);
  if (!res.ok) throw new Error(`foreign subsidiary seed failed: ${res.status} ${await res.text()}`);
}
async function cleanupForeignSubsidiary() {
  await svc('DELETE', `subsidiaries?id=eq.${FOREIGN_SUB_ID}`);
  await svc('DELETE', `organisations?id=eq.${FOREIGN_ORG}`);
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

  await cleanupForeignSubsidiary(); // in case a previous run aborted
  await seedForeignSubsidiary();
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
    // The contact columns specifically, not just `id`: they are the reason
    // `subsidiaries` joined this list, and a column-level grant slip would be
    // invisible to a `select=id` probe.
    const anonContacts = await count('subsidiaries', { query: 'select=id,contact_email,contact_phone' });
    const entryContacts = await count('subsidiaries', {
      token,
      query: 'select=id,contact_email,contact_phone',
    });
    check(
      'subsidiaries: contact PII is contained exactly like the row itself',
      anonContacts.total === 0 && entryContacts.total === 2,
      `anon=${anonContacts.total}, entry=${entryContacts.total}`,
    );

    // Cross-ORGANISATION containment. `data_entry` seeing 2 of 5 proves only
    // intra-org scoping; a policy handing every organisation's rows to a
    // super_admin would pass that and fail this.
    const adminTokenForSubs = await getToken(ADMIN_EMAIL);
    const adminSees = await count('subsidiaries', {
      token: adminTokenForSubs,
      query: `select=id&id=eq.${FOREIGN_SUB_ID}`,
    });
    const foreignExists = await count('subsidiaries', {
      token: SERVICE,
      key: SERVICE,
      query: `select=id&id=eq.${FOREIGN_SUB_ID}`,
    });
    check(
      'subsidiaries: a super_admin cannot read another organisation',
      foreignExists.total === 1 && adminSees.total === 0,
      `foreign rows exist=${foreignExists.total}, visible to admin=${adminSees.total}`,
    );
  } finally {
    await cleanupPeriodLocks();
    await cleanupForeignSubsidiary();
  }

  // audit_log does NOT follow the tenant-table shape: its policy is role-gated
  // (super_admin only) AND organisation-scoped, so a data_entry user must see
  // nothing at all while an admin sees only their own organisation's rows.
  console.log('▸ audit_log (role-gated + organisation-scoped)');
  await cleanupAuditRows(); // in case a previous run aborted
  await seedAuditRows();
  try {
    const adminToken = await getToken(ADMIN_EMAIL);
    const anon = await count('audit_log');
    const entry = await count('audit_log', { token });
    const admin = await count('audit_log', { token: adminToken });
    const foreign = await count('audit_log', {
      token: SERVICE,
      key: SERVICE,
      query: `select=id&organisation_id=eq.${FOREIGN_ORG}`,
    });
    const adminSeesForeign = await count('audit_log', {
      token: adminToken,
      query: `select=id&organisation_id=eq.${FOREIGN_ORG}`,
    });

    if (anon.error) check('audit_log: anon read', false, `unexpected status ${anon.error}`);
    else check('audit_log: anon sees nothing', anon.total === 0, `count=${anon.total}`);

    if (entry.error) check('audit_log: entry read', false, `unexpected status ${entry.error}`);
    else
      check('audit_log: data_entry sees nothing (role-gated)', entry.total === 0, `count=${entry.total}`);

    if (admin.error) check('audit_log: admin read', false, `unexpected status ${admin.error} (missing GRANT?)`);
    else check('audit_log: super_admin sees own-organisation rows', admin.total > 0, `count=${admin.total}`);

    // The tightening this probe exists for: before it, a super_admin of one
    // organisation could read another organisation's audit rows.
    if (!foreign.error && !adminSeesForeign.error) {
      check(
        'audit_log: super_admin cannot read another organisation (the WP7 fix)',
        foreign.total > 0 && adminSeesForeign.total === 0,
        `foreign rows exist=${foreign.total}, visible to admin=${adminSeesForeign.total}`,
      );
    }
  } finally {
    await cleanupAuditRows();
  }

  // --- The consultant seat (WP7 PR 3) -------------------------------------
  // Added with the reviewer UI. The NestJS guard grants a consultant org-wide
  // READ and no writes; that is the primary layer, and this asserts the second
  // one independently agrees — otherwise the whole review-only decision would
  // rest on the guard alone for a seat no probe had ever touched.
  const consultantToken = await getToken(CONSULTANT_EMAIL);
  const svcRecords = await count('activity_records', { key: SERVICE, token: SERVICE });
  const consultantRecords = await count('activity_records', {
    token: consultantToken,
  });
  check(
    'activity_records: consultant reads the organisation (SELECT grant + policy)',
    consultantRecords.total === svcRecords.total && consultantRecords.total > 0,
    `consultant=${consultantRecords.total}, service=${svcRecords.total}`,
  );

  // Review-only means review-only at the database too: RLS has no write policy
  // for this role, so an UPDATE straight through PostgREST must affect nothing.
  // A REAL, consultant-visible row: patching a nonexistent id returns `[]`
  // whether or not a write policy exists, so that form of the probe could never
  // fail — it proved nothing.
  const sample = await fetch(
    `${URL_}/rest/v1/activity_records?select=id,status&limit=1`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
  );
  const [sampleRow] = await sample.json();
  const patch = await fetch(
    `${URL_}/rest/v1/activity_records?id=eq.${sampleRow.id}`,
    {
      method: 'PATCH',
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${consultantToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ status: 'approved' }),
    },
  );
  const patched = patch.ok ? await patch.json() : null;
  // Read the row back with the service role: "0 rows returned" and "0 rows
  // changed" are not the same claim, and only the second one is the control.
  const after = await fetch(
    `${URL_}/rest/v1/activity_records?select=status&id=eq.${sampleRow.id}`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
  );
  const [afterRow] = await after.json();
  check(
    'activity_records: consultant cannot write through RLS (real row unchanged)',
    (!patch.ok || (Array.isArray(patched) && patched.length === 0)) &&
      afterRow.status === sampleRow.status,
    `status=${patch.status}, rows=${Array.isArray(patched) ? patched.length : 'n/a'}, ` +
      `row status ${sampleRow.status} -> ${afterRow.status}`,
  );

  // --- Every table must carry RLS ------------------------------------------
  // The grants migration hands client roles SELECT/INSERT/UPDATE/DELETE on all
  // tables, so a table shipped with RLS off is not "invisible until wired up" —
  // it is open. `pg_class` is not reachable through PostgREST, so this asks the
  // database directly, the same way the seed does.
  try {
    // The root package does not depend on @tonyai/db, so resolve the generated
    // client by path — the same client the seed uses.
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { PrismaClient } = req('../packages/db/generated/client');
    const prisma = new PrismaClient();
    const rows = await prisma.$queryRawUnsafe(
      `select c.relname as name from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and not c.relrowsecurity and c.relname <> '_prisma_migrations'`,
    );
    await prisma.$disconnect();
    const open = rows.map((r) => r.name);
    check(
      'every table in public has RLS enabled (a grant without RLS is open, not invisible)',
      open.length === 0,
      open.length ? `RLS missing on: ${open.join(', ')}` : 'all tables protected',
    );
  } catch (e) {
    check('RLS coverage check could run', false, e.message);
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
