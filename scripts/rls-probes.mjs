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
// This harness writes demo fixtures and performs cleanup. Never target cloud.
try {
  const target = new URL(URL_);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      || !['http:', 'https:'].includes(target.protocol)
      || target.username || target.password || target.search || target.hash
      || target.pathname !== '/') throw new Error('Non-local target');
} catch {
  console.error('RLS demo probes require a loopback Supabase origin; cloud targets are refused.');
  process.exit(2);
}
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
  // `profiles` joined for the same reason `subsidiaries` did. It has always
  // held personal data, but until WP22 the only API surface exposing another
  // person's identity was `/audit`, which is super_admin-only. Record actor
  // names now flow to every tenant reader, so the containment of the table
  // behind them has to be asserted rather than assumed from the ENABLE bit.
  'profiles',
  'activity_records',
  'locations',
  'evidence',
  // WP8 PR7: a file backs records through this link table. Both carry the
  // subsidiary themselves now, so both scope on `subsidiary_id` directly.
  'activity_record_evidence',
  'period_locks',
  'targets',
  'subsidiary_denominators',
  // A batch's subject is the SOURCE FILE, which holds every row — so a
  // data_entry reader sees only a batch they uploaded, and only while they can
  // reach every subsidiary it names. Seeded below; see `seedImportBatches`.
  'import_batches',
];

// The two subsidiaries entry@tonyai.local has access to (Energy + Logistics).
const ENERGY = '22222222-2222-2222-2222-222222220001';
const LOGISTICS = '22222222-2222-2222-2222-222222220004';
const ACC = `(${ENERGY},${LOGISTICS})`;

// Service-role query that counts ONLY the rows belonging to entry's accessible
// tenants — the exact set entry must see.
const ACCESSIBLE_QUERY = {
  // `subsidiaries` IS the tenant, so it scopes on `id`, not `subsidiary_id`.
  subsidiaries: `select=id&id=in.${ACC}`,
  activity_records: `select=id&subsidiary_id=in.${ACC}`,
  locations: `select=id&subsidiary_id=in.${ACC}`,
  evidence: `select=id&subsidiary_id=in.${ACC}`,
  activity_record_evidence: `select=evidence_id&subsidiary_id=in.${ACC}`,
  period_locks: `select=id&subsidiary_id=in.${ACC}`,
  targets: `select=id&subsidiary_id=in.${ACC}`,
  subsidiary_denominators: `select=id&subsidiary_id=in.${ACC}`,
  // Filled in below: `profiles_select_own` is `id = auth.uid()`, so the
  // accessible set is the caller's own row and nothing else. That id is not a
  // seed constant — the auth user is created at seed time — so it comes from
  // the token.
  //
  // What this proves is the DB layer, which is NOT the layer WP22 changed: the
  // API reads `profiles` as the runtime role (BYPASSRLS), so RLS is defence-in-depth here. The
  // containment argument for the API path is that actor ids come from records
  // already filtered by `accessibleSubsidiaryIds`.
  //
  // `undefined`, not `null`: `count()` defaults its query on `undefined` only,
  // so if this assignment is ever re-sequenced below the loop the probe fails
  // loudly instead of quietly fetching `?null` and passing by luck.
  profiles: undefined,
  // Filled in below from the token, like `profiles`: entry's OWN batches whose
  // named subsidiaries are all among entry's two (`cd` = contained by). A null
  // `subsidiary_ids` never matches `cd`, which is the policy's fail-closed rule.
  import_batches: undefined,
};

// The column a plain count selects. Every table has `id` except the link
// table, whose key is the (record, file) pair.
const COUNT_SELECT = { activity_record_evidence: 'select=evidence_id' };

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

/** The `sub` claim — the caller's own profile id. `profiles` is keyed on
 *  `auth.uid()`, so its expected row set is "exactly this one". */
function subjectOf(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).sub;
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

// import_batches is empty in the seed. Four rows in the seeded organisation,
// found again by a sentinel file name: entry's own batch over entry's two
// subsidiaries (the only one entry may read), a colleague's batch over the same
// subsidiary, entry's own batch that ALSO names a subsidiary entry cannot reach,
// and entry's own batch with no `subsidiary_ids` at all (fail-closed).
const IMPORT_PROBE_FILE = 'rls-probe-import.csv';
const MANUFACTURING = '22222222-2222-2222-2222-222222220003';
async function seedImportBatches(entryId) {
  const r = await fetch(`${URL_}/rest/v1/profiles?role=eq.super_admin&select=id,organisation_id&limit=1`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  const admin = (await r.json())[0];
  if (!admin?.id) throw new Error('could not resolve a super_admin profile for the import_batches seed');
  const now = new Date().toISOString();
  const base = {
    organisation_id: admin.organisation_id,
    file_name: IMPORT_PROBE_FILE,
    file_format: 'csv',
    size_bytes: 1,
    sha256: '0'.repeat(64),
    status: 'completed',
    total_rows: 1,
    updated_at: now,
  };
  const res = await svc('POST', 'import_batches', [
    { id: randomUUID(), ...base, uploaded_by: entryId, subsidiary_ids: [ENERGY, LOGISTICS] },
    { id: randomUUID(), ...base, uploaded_by: admin.id, subsidiary_ids: [ENERGY] },
    { id: randomUUID(), ...base, uploaded_by: entryId, subsidiary_ids: [ENERGY, MANUFACTURING] },
    { id: randomUUID(), ...base, uploaded_by: entryId, subsidiary_ids: null },
  ]);
  if (!res.ok) throw new Error(`import_batches seed failed: ${res.status} ${await res.text()}`);
}
async function cleanupImportBatches() {
  await svc('DELETE', `import_batches?file_name=eq.${IMPORT_PROBE_FILE}`);
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

// --- LP1-03: two organisations, all four roles, malformed grants ------------
// A fixture of its own, independent of the seed: organisations X and Y, X with
// two subsidiaries and Y with one, a record in each, and one user per role in
// each organisation (temporary auth users, so every role signs in for real).
// X's data_entry user is granted X1 only. Fixed ids and a fixed email prefix,
// so a run killed half-way is cleaned up by the next one.
const LP103 = {
  orgX: '99999999-1003-4000-8000-00000000000a',
  orgY: '99999999-1003-4000-8000-00000000000b',
  subX1: '99999999-1003-4000-8000-0000000000a1',
  subX2: '99999999-1003-4000-8000-0000000000a2',
  subY1: '99999999-1003-4000-8000-0000000000b1',
  recX1: '99999999-1003-4000-8000-000000000a11',
  recX2: '99999999-1003-4000-8000-000000000a21',
  recY1: '99999999-1003-4000-8000-000000000b11',
  emailPrefix: 'lp103-probe-',
};
const LP103_ROLES = ['super_admin', 'consultant', 'data_entry', 'executive_viewer'];

function authAdmin(method, path, body) {
  return fetch(`${URL_}/auth/v1/admin/${path}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function lp103AuthUsers() {
  const res = await authAdmin('GET', 'users?page=1&per_page=1000');
  if (!res.ok) throw new Error(`listing auth users failed: ${res.status} ${await res.text()}`);
  return (await res.json()).users.filter((u) => u.email?.startsWith(LP103.emailPrefix));
}

async function cleanupTwoOrganisations() {
  const users = await lp103AuthUsers();
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await svc('DELETE', `user_subsidiary_access?user_id=in.(${ids.join(',')})`);
    await svc('DELETE', `activity_records?subsidiary_id=in.(${LP103.subX1},${LP103.subX2},${LP103.subY1})`);
    await svc('DELETE', `profiles?id=in.(${ids.join(',')})`);
  }
  await svc('DELETE', `activity_records?subsidiary_id=in.(${LP103.subX1},${LP103.subX2},${LP103.subY1})`);
  await svc('DELETE', `organisations?id=in.(${LP103.orgX},${LP103.orgY})`);
  for (const id of ids) await authAdmin('DELETE', `users/${id}`);
}

async function seedTwoOrganisations() {
  const ok = async (res, what) => {
    if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  };
  await ok(
    await svc('POST', 'organisations', [
      { id: LP103.orgX, legal_name: 'RLS probe org X', country: 'GB', geography_code: 'UK', updated_at: new Date().toISOString() },
      { id: LP103.orgY, legal_name: 'RLS probe org Y', country: 'GB', geography_code: 'UK', updated_at: new Date().toISOString() },
    ]),
    'organisations',
  );
  await ok(
    await svc('POST', 'subsidiaries', [
      [LP103.subX1, LP103.orgX],
      [LP103.subX2, LP103.orgX],
      [LP103.subY1, LP103.orgY],
    ].map(([id, org]) => ({ id, organisation_id: org, legal_name: `RLS probe ${id.slice(-2)}`, geography_code: 'UK', updated_at: new Date().toISOString() }))),
    'subsidiaries',
  );
  const users = {};
  for (const [org, tag] of [[LP103.orgX, 'x'], [LP103.orgY, 'y']]) {
    for (const role of LP103_ROLES) {
      const email = `${LP103.emailPrefix}${role.replace('_', '-')}-${tag}@tonyai.test`;
      const res = await authAdmin('POST', 'users', { email, password: PASSWORD, email_confirm: true });
      await ok(res, `auth user ${email}`);
      const { id } = await res.json();
      await ok(
        await svc('POST', 'profiles', { id, email, full_name: `Probe ${role} ${tag}`, role, organisation_id: org, updated_at: new Date().toISOString() }),
        `profile ${email}`,
      );
      users[`${role}:${tag}`] = { id, email };
    }
  }
  await ok(
    await svc('POST', 'user_subsidiary_access', {
      user_id: users['data_entry:x'].id,
      subsidiary_id: LP103.subX1,
      organisation_id: LP103.orgX,
    }),
    'grant X1 to X data_entry',
  );
  const record = (id, sub) => ({
    id, subsidiary_id: sub, reporting_year: 2019, reporting_period: 'monthly', period_value: 'January',
    category: 'Electricity', scope: 2, activity_value: 1, activity_unit: 'kWh',
    calculation: { tCo2e: 0, factorId: 'rls-probe-placeholder' }, created_by: users['super_admin:x'].id,
    updated_at: new Date().toISOString(),
  });
  await ok(
    await svc('POST', 'activity_records', [record(LP103.recX1, LP103.subX1), record(LP103.recX2, LP103.subX2), record(LP103.recY1, LP103.subY1)]),
    'activity_records',
  );
  return users;
}

async function probeTwoOrganisations() {
  console.log('▸ LP1-03 — two organisations, all four roles, malformed grants');
  await cleanupTwoOrganisations();
  try {
    const users = await seedTwoOrganisations();
    const tokens = {};
    for (const [key, { email }] of Object.entries(users)) tokens[key] = await getToken(email);

    // What each role may read, per organisation: the organisation-wide roles
    // their whole organisation, data_entry only what it is granted.
    const subs = `${LP103.subX1},${LP103.subX2},${LP103.subY1}`;
    const expected = {
      'super_admin:x': [LP103.subX1, LP103.subX2],
      'consultant:x': [LP103.subX1, LP103.subX2],
      'executive_viewer:x': [LP103.subX1, LP103.subX2],
      'data_entry:x': [LP103.subX1],
      'super_admin:y': [LP103.subY1],
      'consultant:y': [LP103.subY1],
      'executive_viewer:y': [LP103.subY1],
      'data_entry:y': [],
    };
    for (const [key, visible] of Object.entries(expected)) {
      const subsRes = await fetch(`${URL_}/rest/v1/subsidiaries?select=id&id=in.(${subs})`, {
        headers: { apikey: ANON, Authorization: `Bearer ${tokens[key]}` },
      });
      const seen = (await subsRes.json()).map((r) => r.id).sort();
      const recRes = await fetch(`${URL_}/rest/v1/activity_records?select=subsidiary_id&subsidiary_id=in.(${subs})`, {
        headers: { apikey: ANON, Authorization: `Bearer ${tokens[key]}` },
      });
      const recs = (await recRes.json()).map((r) => r.subsidiary_id).sort();
      const want = [...visible].sort();
      check(
        `two organisations: ${key.replace(':', ' of ')} reads exactly its own organisation's subsidiaries and records`,
        JSON.stringify(seen) === JSON.stringify(want) && JSON.stringify(recs) === JSON.stringify(want),
        `subsidiaries=${seen.length}, records=${recs.length}, expected=${want.length}`,
      );
    }

    // Malformed grants, written with the service role — the most privileged
    // PostgREST client, which RLS does not restrict. The composite foreign keys
    // refuse every one (409, foreign-key violation).
    const entryX = users['data_entry:x'].id;
    const malformed = [
      ['a grant of Y1 to X\'s data_entry user, labelled X', { user_id: entryX, subsidiary_id: LP103.subY1, organisation_id: LP103.orgX }],
      ['a grant of Y1 to X\'s data_entry user, labelled Y', { user_id: entryX, subsidiary_id: LP103.subY1, organisation_id: LP103.orgY }],
      ['a grant of a subsidiary that does not exist', { user_id: entryX, subsidiary_id: randomUUID(), organisation_id: LP103.orgX }],
      ['a grant to a profile that does not exist', { user_id: randomUUID(), subsidiary_id: LP103.subX2, organisation_id: LP103.orgX }],
    ];
    for (const [label, row] of malformed) {
      const res = await svc('POST', 'user_subsidiary_access', row);
      check(`malformed grant refused by the database: ${label}`, res.status === 409, `status=${res.status}`);
    }
    const moved = await svc('PATCH', `profiles?id=eq.${entryX}`, { organisation_id: LP103.orgY });
    check("a granted profile cannot be moved to another organisation (service role)", moved.status === 409, `status=${moved.status}`);

    // Client roles write nothing here: no INSERT/UPDATE/DELETE policy exists on
    // grants or profiles, so these are refused or match no row.
    const asEntry = { apikey: ANON, Authorization: `Bearer ${tokens['data_entry:x']}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    const selfGrant = await fetch(`${URL_}/rest/v1/user_subsidiary_access`, {
      method: 'POST',
      headers: asEntry,
      body: JSON.stringify({ user_id: entryX, subsidiary_id: LP103.subX2, organisation_id: LP103.orgX }),
    });
    const promote = await fetch(`${URL_}/rest/v1/profiles?id=eq.${entryX}`, {
      method: 'PATCH',
      headers: asEntry,
      body: JSON.stringify({ role: 'super_admin' }),
    });
    const asAdmin = { ...asEntry, Authorization: `Bearer ${tokens['super_admin:x']}` };
    const revoke = await fetch(`${URL_}/rest/v1/user_subsidiary_access?user_id=eq.${entryX}`, { method: 'DELETE', headers: asAdmin });
    const after = await fetch(`${URL_}/rest/v1/user_subsidiary_access?select=subsidiary_id&user_id=eq.${entryX}`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    const grantsAfter = (await after.json()).map((r) => r.subsidiary_id);
    const profileAfter = await (await fetch(`${URL_}/rest/v1/profiles?select=role,organisation_id&id=eq.${entryX}`, {
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    })).json();
    const promotedRows = promote.ok ? await promote.json() : [];
    const revokedRows = revoke.ok ? await revoke.json() : [];
    check(
      'a data_entry user cannot grant itself a subsidiary through PostgREST',
      !selfGrant.ok && JSON.stringify(grantsAfter) === JSON.stringify([LP103.subX1]),
      `insert=${selfGrant.status}, grants now=${grantsAfter.length}`,
    );
    check(
      'a data_entry user cannot promote itself through PostgREST',
      promotedRows.length === 0 && profileAfter[0]?.role === 'data_entry' && profileAfter[0]?.organisation_id === LP103.orgX,
      `patch=${promote.status}, rows=${promotedRows.length}, role now=${profileAfter[0]?.role}`,
    );
    check(
      "a super_admin cannot change grants through PostgREST — only through the API's audited boundary",
      revokedRows.length === 0 && grantsAfter.length === 1,
      `delete=${revoke.status}, rows=${revokedRows.length}`,
    );
  } catch (e) {
    check('LP1-03 two-organisation probe could run', false, e.message);
  } finally {
    await cleanupTwoOrganisations();
  }
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
  await cleanupImportBatches(); // in case a previous run aborted

  await cleanupForeignSubsidiary(); // in case a previous run aborted
  try {
    // Seeds go INSIDE the try. Outside it, a failure between the organisation
    // insert and the subsidiary insert left an orphan organisation behind (and
    // `seedPeriodLocks` had the same shape) — recovered by the next run's
    // pre-cleanup, but visible in the UAT database in between, and the stray
    // period locks show up as closed periods on real subsidiaries.
    await seedPeriodLocks();
    await seedForeignSubsidiary();
    await seedImportBatches(subjectOf(token));
    ACCESSIBLE_QUERY.profiles = `select=id&id=eq.${subjectOf(token)}`;
    ACCESSIBLE_QUERY.import_batches =
      `select=id&uploaded_by=eq.${subjectOf(token)}&subsidiary_ids=cd.{${ENERGY},${LOGISTICS}}`;
    for (const table of TENANT_TABLES) {
      console.log(`▸ ${table}`);
      const anon = await count(table, { query: COUNT_SELECT[table] });
      const entry = await count(table, { token, query: COUNT_SELECT[table] });
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
    // import_batches, named row by row — the loop above proves "exactly the
    // accessible set", this proves WHICH rows that set excludes and why.
    const probeBatches = `select=id,uploaded_by,subsidiary_ids&file_name=eq.${IMPORT_PROBE_FILE}`;
    const entryBatches = await count('import_batches', { token, query: probeBatches });
    check(
      "import_batches: entry reads only its own batch over its own subsidiaries — not a colleague's, not one naming a subsidiary it cannot reach, not one with no subsidiaries",
      entryBatches.total === 1,
      `entry sees ${entryBatches.total} of 4 seeded`,
    );
    const consultantBatches = await count('import_batches', {
      token: await getToken(CONSULTANT_EMAIL),
      query: probeBatches,
    });
    check(
      'import_batches: a consultant reads every batch of its organisation',
      consultantBatches.total === 4,
      `consultant sees ${consultantBatches.total} of 4`,
    );

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
    await cleanupImportBatches();
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

  // --- storage_intents (LP1-02): operational state, no client access -------
  // Not tenant data, so not in TENANT_TABLES: RLS on with NO policy and no
  // grant to anon/authenticated. Every client role must read nothing and
  // write nothing — a client able to write a `delete` intent could have the
  // API's sweeper remove another tenant's evidence. One row is seeded through
  // the service role first, so "nothing" is not vacuous.
  console.log('▸ storage_intents (no client access)');
  const PROBE_INTENT = '99999999-0000-0000-0000-00000000f001';
  await svc('DELETE', `storage_intents?id=eq.${PROBE_INTENT}`);
  const seeded = await svc('POST', 'storage_intents', [
    { id: PROBE_INTENT, kind: 'delete', bucket: 'evidence', object_path: 'rls-probe/none.pdf', reason: 'rls-probe' },
  ]);
  if (!seeded.ok) throw new Error(`storage_intents seed failed: ${seeded.status} ${await seeded.text()}`);
  try {
    const refused = (r) => (r.error ? /42501|permission denied/i.test(r.error) : r.total === 0);
    const intentsSvc = await count('storage_intents', { key: SERVICE, token: SERVICE });
    const intentsAnon = await count('storage_intents');
    const intentsEntry = await count('storage_intents', { token });
    const intentsAdmin = await count('storage_intents', { token: await getToken(ADMIN_EMAIL) });
    check(
      'storage_intents: no client role reads a row (anon, data_entry, super_admin)',
      intentsSvc.total > 0 && refused(intentsAnon) && refused(intentsEntry) && refused(intentsAdmin),
      `service=${intentsSvc.total}, anon=${intentsAnon.error ?? intentsAnon.total}, entry=${intentsEntry.error ?? intentsEntry.total}, admin=${intentsAdmin.error ?? intentsAdmin.total}`,
    );
    const forged = await fetch(`${URL_}/rest/v1/storage_intents`, {
      method: 'POST',
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${await getToken(ADMIN_EMAIL)}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        id: '99999999-0000-0000-0000-00000000f002',
        kind: 'delete',
        bucket: 'evidence',
        object_path: 'rls-probe/forged.pdf',
        reason: 'rls-probe',
      }),
    });
    const forgedRows = await count('storage_intents', {
      key: SERVICE,
      token: SERVICE,
      query: 'select=id&id=eq.99999999-0000-0000-0000-00000000f002',
    });
    check(
      'storage_intents: a client cannot write an intent (a forged delete would reach the sweeper)',
      !forged.ok && forgedRows.total === 0,
      `status=${forged.status}, rows=${forgedRows.total}`,
    );
    // Redirecting an existing intent at another object is the same attack by
    // UPDATE; deleting one would hide a pending removal. Both against the REAL
    // seeded row, read back with the service role — "0 rows returned" is not
    // "0 rows changed".
    const adminToken = await getToken(ADMIN_EMAIL);
    const clientWrite = (method, body) =>
      fetch(`${URL_}/rest/v1/storage_intents?id=eq.${PROBE_INTENT}`, {
        method,
        headers: {
          apikey: ANON,
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const patched = await clientWrite('PATCH', { object_path: 'rls-probe/redirected.pdf' });
    const deleted = await clientWrite('DELETE');
    const [stillThere] = await (
      await fetch(`${URL_}/rest/v1/storage_intents?select=object_path&id=eq.${PROBE_INTENT}`, {
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      })
    ).json();
    check(
      'storage_intents: a client cannot redirect or delete an intent (PATCH, DELETE)',
      !patched.ok && !deleted.ok && stillThere?.object_path === 'rls-probe/none.pdf',
      `patch=${patched.status}, delete=${deleted.status}, row=${stillThere?.object_path ?? 'gone'}`,
    );
  } finally {
    await svc('DELETE', `storage_intents?id=in.(${PROBE_INTENT},99999999-0000-0000-0000-00000000f002)`);
  }

  // --- The factor library (LP3-03): reference data, append-only ------------
  // Every authenticated user reads the library (no tenant predicate, by
  // design); anon reads none of it; no client role writes it — and, because
  // the append-only triggers fire for every role, neither can the service role
  // rewrite or delete a loaded row. The runtime role's SELECT-only grant is
  // part of the runtime-role check below; the integration suite runs its
  // refused INSERT for real.
  console.log('▸ factor library (read-only reference data, append-only)');
  {
    const FACTOR_TABLES = ['factor_releases', 'emission_factors', 'unit_conversions'];
    const refused = (r) => (r.error ? /401|42501|permission denied/i.test(r.error) : r.total === 0);
    const adminToken = await getToken(ADMIN_EMAIL);
    const svcRead = async (path) =>
      (await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json();

    const anonCounts = await Promise.all(FACTOR_TABLES.map((t) => count(t)));
    check(
      'factor library: anon reads none of the three tables',
      anonCounts.every(refused),
      FACTOR_TABLES.map((t, i) => `${t}=${anonCounts[i].error ?? anonCounts[i].total}`).join(', '),
    );

    const entryCounts = await Promise.all(FACTOR_TABLES.map((t) => count(t, { token })));
    check(
      'factor library: an authenticated user reads every table (reference data, no tenant predicate)',
      entryCounts.every((r) => !r.error && r.total > 0),
      FACTOR_TABLES.map((t, i) => `${t}=${entryCounts[i].error ?? entryCounts[i].total}`).join(', '),
    );

    // Readable by every tenant, so the columns naming people and firms behind
    // a release are withheld from the client role (column-level grant).
    const withheld = await Promise.all(
      ['reviewed_by', 'withdrawn_by', 'notes'].map((c) => count('factor_releases', { token, query: `select=${c}` })),
    );
    check(
      'factor_releases: reviewed_by, withdrawn_by and notes are withheld from authenticated',
      withheld.every((r) => r.error && /42501|permission denied/i.test(r.error)),
      withheld.map((r) => r.error ?? `readable (${r.total})`).join(' | '),
    );

    // The library's record (factor_release_events): no client reads it, and
    // not even the service role writes it — its triggers alone do.
    const recordReads = await Promise.all([count('factor_release_events'), count('factor_release_events', { token })]);
    const forgedEvent = await fetch(`${URL_}/rest/v1/factor_release_events`, {
      method: 'POST',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        id: '99999999-0000-0000-0000-00000000fe01', release_id: '99999999-0000-0000-0000-00000000fe02',
        publisher: 'x', edition: 'x', release_status: 'x', event: 'loaded', db_role: 'x',
      }),
    });
    check(
      "factor_release_events: no client reads the library's record, and the service role cannot forge an entry (42501)",
      recordReads.every((r) => r.error && /42501|permission denied/i.test(r.error)) &&
        !forgedEvent.ok && /42501/.test(await forgedEvent.text()),
      `anon=${recordReads[0].error ?? recordReads[0].total}, entry=${recordReads[1].error ?? recordReads[1].total}, service insert=${forgedEvent.status}`,
    );

    const [release] = await svcRead('factor_releases?select=id,title,status&status=eq.placeholder&limit=1');
    const [factor] = await svcRead(`emission_factors?select=id,factor_value&release_id=eq.${release?.id}&limit=1`);
    const [conversion] = await svcRead('unit_conversions?select=id,multiplier&limit=1');
    if (!release || !factor || !conversion) {
      check('factor library: the seed loaded a release, a factor and a conversion to probe', false, 'missing');
    } else {
      const rows = {
        factor_releases: { id: release.id, patch: { title: 'rls-probe' }, column: 'title', value: release.title },
        emission_factors: { id: factor.id, patch: { factor_value: 0 }, column: 'factor_value', value: factor.factor_value },
        unit_conversions: { id: conversion.id, patch: { multiplier: 1 }, column: 'multiplier', value: conversion.multiplier },
      };
      const write = (key, auth, method, table, query, body) =>
        fetch(`${URL_}/rest/v1/${table}${query}`, {
          method,
          headers: {
            apikey: key,
            Authorization: `Bearer ${auth}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      const unchanged = async (table) => {
        const { id, column, value } = rows[table];
        const [row] = await svcRead(`${table}?select=${column}&id=eq.${id}`);
        return row !== undefined && row[column] === value;
      };

      for (const table of FACTOR_TABLES) {
        const { id, patch } = rows[table];
        // Refused by PRIVILEGE (42501) — the body is deliberately incomplete, so
        // a NOT NULL refusal must not be mistaken for the grant holding.
        const denied = async (res) => !res.ok && /42501/.test(await res.text());
        const inserted = await write(ANON, adminToken, 'POST', table, '', { ...patch, id: '99999999-0000-0000-0000-00000000fa01' });
        const patched = await write(ANON, adminToken, 'PATCH', table, `?id=eq.${id}`, patch);
        const deleted = await write(ANON, adminToken, 'DELETE', table, `?id=eq.${id}`);
        const [ghost] = await svcRead(`${table}?select=id&id=eq.99999999-0000-0000-0000-00000000fa01`);
        const refusedAll = (await denied(inserted)) && (await denied(patched)) && (await denied(deleted));
        check(
          `${table}: an authenticated client cannot insert, update or delete (42501)`,
          refusedAll && ghost === undefined && (await unchanged(table)),
          `insert=${inserted.status}, update=${patched.status}, delete=${deleted.status}`,
        );

        // The service role holds every privilege and bypasses RLS: only the
        // append-only triggers stand between it and a loaded row.
        const svcPatched = await write(SERVICE, SERVICE, 'PATCH', table, `?id=eq.${id}`, patch);
        const svcPatchBody = svcPatched.ok ? '' : await svcPatched.text();
        const svcDeleted = await write(SERVICE, SERVICE, 'DELETE', table, `?id=eq.${id}`);
        const svcDeleteBody = svcDeleted.ok ? '' : await svcDeleted.text();
        check(
          `${table}: append-only for the service role too (update and delete refused by trigger, TA010)`,
          !svcPatched.ok && /TA010/.test(svcPatchBody) && !svcDeleted.ok && /TA010/.test(svcDeleteBody) && (await unchanged(table)),
          `update=${svcPatched.status}, delete=${svcDeleted.status}`,
        );
      }
    }
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

  // The same probe for the VOID transition (WP18 PR 2a). Worth its own case
  // rather than trusting the one above: `voided` is the only status that
  // REMOVES a figure from the reported inventory, so a client role able to set
  // it could silently delete a subsidiary's emissions without deleting a row —
  // and it is the newest value in the enum, i.e. the one a future write policy
  // is most likely to forget.
  const voidPatch = await fetch(
    `${URL_}/rest/v1/activity_records?id=eq.${sampleRow.id}`,
    {
      method: 'PATCH',
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${consultantToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        status: 'voided',
        void_reason: 'written straight through PostgREST',
      }),
    },
  );
  const voidPatched = voidPatch.ok ? await voidPatch.json() : null;
  const afterVoid = await fetch(
    `${URL_}/rest/v1/activity_records?select=status,void_reason&id=eq.${sampleRow.id}`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
  );
  const [afterVoidRow] = await afterVoid.json();
  check(
    'activity_records: consultant cannot VOID a figure through RLS',
    // `voidPatch.status === 200` is pinned, not just `!ok`. A rejected BODY
    // (stale PostgREST schema cache -> 400 PGRST204) would also leave the row
    // unchanged, and the probe would pass while proving nothing about RLS. 200
    // with zero rows is the only result that means "PostgREST understood the
    // write and the POLICY refused it".
    voidPatch.status === 200 &&
      Array.isArray(voidPatched) &&
      voidPatched.length === 0 &&
      afterVoidRow.status === sampleRow.status &&
      afterVoidRow.void_reason === null,
    `status=${voidPatch.status}, row status ${sampleRow.status} -> ${afterVoidRow.status}, ` +
      `void_reason=${afterVoidRow.void_reason}`,
  );

  // --- LP1-03: two organisations, every role, malformed grants -------------
  await probeTwoOrganisations();

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

  // --- The runtime role (LP1-03) ---------------------------------------------
  // The API connects as `tonyai_runtime`, which bypasses RLS by design, so its
  // privileges are part of the trust boundary: the same catalogue check the
  // integration suite and an operator's `runtime-role.mjs check` run.
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const { PrismaClient } = req('../packages/db/generated/client');
    const { checkRuntimeRole, checkTenantInvariants, checkTableLevelGrants, checkFunctionExecutors, checkIntegrityTriggers, factorLibraryReport, platformDefaultPrivileges, runtimeRoleExposures } =
      await import('../packages/db/scripts/runtime-role.mjs');
    const prisma = new PrismaClient();
    const query = (sql) => prisma.$queryRawUnsafe(sql);
    try {
      const problems = await checkRuntimeRole(query);
      check(
        'the runtime role holds exactly its intended privileges (no DDL, append-only audit_log, no _prisma_migrations, BYPASSRLS, owns nothing)',
        problems.length === 0,
        problems.length ? problems.join('; ') : 'as intended',
      );
      const broken = await checkTenantInvariants(query);
      check('no grant crosses an organisation and no slot mixes typed and untyped records in the data (a restore skips the keys and the slot rule)', broken.length === 0, broken.join('; ') || 'none');
      const tableVerbs = await checkTableLevelGrants(query);
      check(
        'no role but a table\'s owner holds TRIGGER, TRUNCATE, REFERENCES or MAINTAIN on a public table, now or by default (a trigger fires as the owner inside a cascade)',
        tableVerbs.length === 0,
        tableVerbs.join('; ') || 'none',
      );
      const executors = await checkFunctionExecutors(query);
      check(
        'no role but the owner may EXECUTE (so attach, or call through /rpc) a function in public, now or by default — an event writer runs as the owner',
        executors.length === 0,
        executors.join('; ') || 'none',
      );
      const triggers = await checkIntegrityTriggers(query);
      check(
        'the integrity triggers (K5 snapshot, slot kind, append-only factor library) and CHECKs are present and ENABLE ALWAYS',
        triggers.length === 0,
        triggers.join('; ') || 'all in force',
      );
      // The library's record is the owner's to read (the runtime role holds no
      // grant on it): reconcile it through DIRECT_URL where there is one.
      const owner = process.env.DIRECT_URL ? new PrismaClient({ datasourceUrl: process.env.DIRECT_URL }) : prisma;
      let library;
      try {
        library = await factorLibraryReport((sql) => owner.$queryRawUnsafe(sql));
      } finally {
        if (owner !== prisma) await owner.$disconnect();
      }
      check(
        'no unspecified activity type under an authoritative release; every library row recorded in factor_release_events',
        library.problems.length === 0 && library.skipped.length === 0,
        [...library.problems, ...library.skipped].join('; ') || 'none',
      );
      // Not a failure locally — the seed's placeholder library is expected here.
      for (const n of library.notices) console.log(`  ⚠️  the factor library holds a ${n}`);
      // Not a failure: what every role inherits from PUBLIC through the platform.
      for (const e of await runtimeRoleExposures(query)) console.log(`  ⚠️  the runtime role can also reach ${e}`);
      // Not a failure: another creator's defaults in public (Supabase's
      // supabase_admin, the platform's; pg_database_owner where it owns the schema).
      for (const d of await platformDefaultPrivileges(query)) console.log(`  ⚠️  ${d} (another creator's default)`);
    } finally {
      await prisma.$disconnect();
    }
  } catch (e) {
    check('runtime role check could run', false, e.message);
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
