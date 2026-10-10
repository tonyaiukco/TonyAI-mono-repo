import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_ROLE,
  isLoopbackUrl,
  randomRuntimePassword,
  runtimeUrlFrom,
  scramVerifier,
  urlUser,
  INTEGRITY_CHECKS,
  INTEGRITY_HELPERS,
  INTEGRITY_TRIGGERS,
  RECORD_FOREIGN_KEYS,
  checkIntegrityTriggers,
  expectedTriggerFunctionBodies,
  factorLibraryReport,
  checkTenantInvariants,
  checkTableLevelGrants,
  checkFunctionExecutors,
  platformDefaultPrivileges,
  CLIENT_CALLABLE_FUNCTIONS,
} from './runtime-role.mjs';

// The database half — that PostgreSQL accepts the verifier and the privileges
// are as listed — is proven by apps/api/test/int/runtime-role.int.spec.ts.

describe('isLoopbackUrl — the gate in front of setting a password', () => {
  it.each([
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'postgresql://postgres:postgres@localhost:54322/postgres',
    'postgres://postgres:postgres@[::1]:54322/postgres',
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres?connection_limit=1&schema=public',
  ])('accepts %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    // Prisma honours ?host= over the URL's host (`security-rls`, reproduced).
    'postgresql://postgres:postgres@localhost:54322/postgres?host=staging.example.com',
    'postgresql://postgres:postgres@localhost:54322/postgres?HOST=staging.example.com',
    'postgresql://postgres:postgres@localhost:54322/postgres?hostaddr=10.0.0.5',
    'postgresql://postgres:postgres@localhost:54322/postgres?options=-c%20foo',
    'postgresql://postgres:postgres@localhost.attacker.example:54322/postgres',
    'postgresql://postgres:postgres@127.0.0.1.attacker.example:54322/postgres',
    'postgresql://postgres:postgres@db.abc.supabase.co:5432/postgres',
    'https://127.0.0.1:54322/postgres',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});

describe('scramVerifier — the password never reaches the server', () => {
  it('has PostgreSQL’s stored shape and is derived as RFC 5802 says', () => {
    const salt = Buffer.from('0123456789abcdef');
    const verifier = scramVerifier('pencil', salt, 4096);
    const salted = pbkdf2Sync('pencil', salt, 4096, 32, 'sha256');
    const storedKey = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest();
    const serverKey = createHmac('sha256', salted).update('Server Key').digest();
    expect(verifier).toBe(
      `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`,
    );
    expect(verifier).not.toContain('pencil');
  });

  it('salts each verifier afresh', () => {
    expect(scramVerifier('pencil')).not.toBe(scramVerifier('pencil'));
  });

  it("refuses a password it could not prepare as PostgreSQL would (non-ASCII, quotes' neighbours are fine)", () => {
    expect(() => scramVerifier('pässword')).toThrow(/printable ASCII/);
    expect(() => scramVerifier('with space')).toThrow(/printable ASCII/);
    expect(() => scramVerifier('')).toThrow(/printable ASCII/);
  });
});

describe('runtime URLs and passwords', () => {
  it('derives the runtime login for the same database', () => {
    const url = runtimeUrlFrom('postgresql://postgres:postgres@127.0.0.1:54322/postgres', 'abc');
    expect(urlUser(url)).toBe(RUNTIME_ROLE);
    expect(new URL(url).password).toBe('abc');
    expect(new URL(url).host).toBe('127.0.0.1:54322');
  });

  it('never derives one without a password — there is no published default', () => {
    expect(() => runtimeUrlFrom('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toThrow(/password/);
  });

  it('generates URL-safe, high-entropy passwords', () => {
    const a = randomRuntimePassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(randomRuntimePassword()).not.toBe(a);
  });
});

describe('checkIntegrityTriggers (LP3-03)', () => {
  const md5 = (t) => createHash('md5').update(t, 'utf8').digest('hex');
  const bodies = new Map(INTEGRITY_TRIGGERS.map((t) => [t.fn, `\nBEGIN /* ${t.fn} */ END\n`]));
  const allTriggers = INTEGRITY_TRIGGERS.map((t) => ({
    table: t.table, trigger: t.trigger, enabled: 'A', type: t.type, unconditional: true, allColumns: true,
    fnSchema: 'public', fn: t.fn, bodyMd5: md5(bodies.get(t.fn)), definer: Boolean(t.definer), config: ['search_path=""'], language: 'plpgsql',
  }));
  const allChecks = INTEGRITY_CHECKS.map(([table, name, definitionMd5]) => ({
    table, name, validated: true, definitionMd5, definition: 'CHECK (...)',
  }));
  for (const h of INTEGRITY_HELPERS) bodies.set(h.fn, `\n  SELECT /* ${h.fn} */ 1\n`);
  const allHelpers = INTEGRITY_HELPERS.map((h) => ({
    fn: h.fn, bodyMd5: md5(bodies.get(h.fn)), definer: false, config: ['search_path=""'], language: h.language,
  }));
  const parentOf = (name) => (name.includes('import_batch') ? 'import_batches' : name.includes('location') ? 'locations' : 'subsidiaries');
  const allKeys = RECORD_FOREIGN_KEYS.map(([name, definitionMd5]) => {
    const action = name.includes('import_batch') ? 'a' : 'r';
    return { name, onDelete: action, onUpdate: action, validated: true, definitionMd5, definition: 'FOREIGN KEY (...)', parent: parentOf(name) };
  });
  // The four system triggers PostgreSQL makes for each key, ENABLE (origin).
  const actionFn = { a: 'noaction', r: 'restrict', c: 'cascade', n: 'setnull', d: 'setdefault' };
  const triggersOf = (keys) =>
    keys.flatMap((k) => [
      { key: k.name, table: 'activity_records', fn: 'RI_FKey_check_ins', enabled: 'O' },
      { key: k.name, table: 'activity_records', fn: 'RI_FKey_check_upd', enabled: 'O' },
      { key: k.name, table: k.parent, fn: `RI_FKey_${actionFn[k.onDelete]}_del`, enabled: 'O' },
      { key: k.name, table: k.parent, fn: `RI_FKey_${actionFn[k.onUpdate]}_upd`, enabled: 'O' },
    ]);
  const fake = (triggers, constraints, rules = [], helpers = allHelpers, keys = allKeys, keyTriggers = triggersOf(keys)) => async (sql) =>
    sql.includes('pg_rewrite') ? rules
      : sql.includes('proname IN') ? helpers
        : sql.includes('tgconstraint') ? keyTriggers
          : sql.includes('pg_trigger') ? triggers
            : sql.includes("contype = 'f'") ? keys
              : constraints;
  const check = (triggers, constraints = allChecks, rules = [], bodyMap = bodies, helpers = allHelpers, keys = allKeys, keyTriggers) =>
    checkIntegrityTriggers(fake(triggers, constraints, rules, helpers, keys, keyTriggers), bodyMap);
  const tweak = (name, change) => allTriggers.map((t) => (t.trigger === name ? { ...t, ...change } : t));

  it('passes when every trigger is ENABLE ALWAYS, on its events, running its own unaltered function', async () => {
    expect(await check(allTriggers)).toEqual([]);
  });

  it('covers K5, the slot rule, all four events on all three factor tables, and the library\'s record', () => {
    // + the record: one release trigger, insert/delete on factors and
    // conversions, and the record's own three append-only guards.
    // K5, its delete guard and the slot rule; four guards on each factor
    // table; the record's writers; the record's four guards; LP4-01's
    // lifecycle writer, organisation guard and subsidiary guard.
    expect(INTEGRITY_TRIGGERS).toHaveLength(3 + 3 * 4 + 1 + 2 * 2 + 4 + 3);
    expect(INTEGRITY_TRIGGERS.filter((t) => t.definer).map((t) => t.trigger).sort()).toEqual([
      'emission_factors_record_delete', 'emission_factors_record_insert', 'factor_releases_record_event',
      'unit_conversions_record_delete', 'unit_conversions_record_insert',
    ]);
    expect(INTEGRITY_TRIGGERS.map((t) => t.trigger)).toContain('activity_records_snapshot_immutable');
    expect(INTEGRITY_TRIGGERS.find((t) => t.trigger === 'unit_conversions_before_truncate')).toMatchObject({
      fn: 'factor_tables_before_truncate',
      type: 2 | 32,
    });
  });

  it('finds every trigger function in the migrations, as the database must hold it', () => {
    const real = expectedTriggerFunctionBodies();
    expect([...real.keys()].sort()).toEqual(
      [...new Set([...INTEGRITY_TRIGGERS.map((t) => t.fn), ...INTEGRITY_HELPERS.map((h) => h.fn)])].sort(),
    );
    expect(real.get('activity_records_snapshot_immutable')).toContain("ERRCODE = 'TA001'");
  });

  it('reports a missing trigger, one merely ENABLEd (skipped in replica mode), and a disabled one', async () => {
    const triggers = allTriggers
      .filter((t) => t.trigger !== 'activity_records_slot_kind')
      .map((t) =>
        t.trigger === 'activity_records_snapshot_immutable'
          ? { ...t, enabled: 'O' }
          : t.trigger === 'emission_factors_before_update'
            ? { ...t, enabled: 'D' }
            : t,
      );
    expect(await check(triggers)).toEqual([
      "trigger activity_records_snapshot_immutable on activity_records is not ENABLE ALWAYS (tgenabled = 'O')",
      'trigger activity_records_slot_kind on activity_records is missing',
      "trigger emission_factors_before_update on emission_factors is not ENABLE ALWAYS (tgenabled = 'D')",
    ]);
  });

  it('reports a trigger re-created on fewer events, pointed elsewhere, or running an emptied function', async () => {
    expect(await check(tweak('activity_records_slot_kind', { type: 2 | 1 | 4 }))).toEqual([
      'trigger activity_records_slot_kind on activity_records fires on the wrong events (tgtype 7, expected 23)',
    ]);
    expect(await check(tweak('emission_factors_before_delete', { fn: 'factor_rows_before_insert' }))).toEqual([
      'trigger emission_factors_before_delete on emission_factors runs public.factor_rows_before_insert, not public.factor_rows_before_delete',
    ]);
    expect(await check(tweak('activity_records_snapshot_immutable', { bodyMd5: md5('\nBEGIN RETURN NEW; END\n') }))).toEqual([
      'function public.activity_records_snapshot_immutable() differs from its migration\'s definition',
    ]);
  });

  it('reports a trigger narrowed by WHEN or UPDATE OF — K5 off without disabling it', async () => {
    expect(await check(tweak('activity_records_snapshot_immutable', { unconditional: false }))).toEqual([
      'trigger activity_records_snapshot_immutable on activity_records is narrowed (a WHEN condition or an UPDATE OF column list)',
    ]);
    expect(await check(tweak('activity_records_snapshot_immutable', { allColumns: false }))).toHaveLength(1);
  });

  it('reports a function made SECURITY DEFINER, given another search_path or language, or moved to another schema', async () => {
    for (const change of [{ definer: true }, { config: ['search_path=evil, pg_catalog'] }, { config: [] }, { language: 'sql' }]) {
      const problems = await check(tweak('emission_factors_before_update', change));
      expect(problems.length, JSON.stringify(change)).toBeGreaterThan(0);
      expect(problems.every((p) => p.startsWith('function public.factor_rows_before_update()'))).toBe(true);
    }
    expect(await check(tweak('emission_factors_before_update', { fnSchema: 'evil' }))).toEqual([
      'trigger emission_factors_before_update on emission_factors runs evil.factor_rows_before_update, not public.factor_rows_before_update',
    ]);
  });

  it('reports a record trigger turned SECURITY INVOKER — it would need an INSERT grant anyone could use', async () => {
    expect(await check(tweak('factor_releases_record_event', { definer: false }))).toHaveLength(1);
  });

  it('reports a trigger whose function no migration defines, instead of failing', async () => {
    const partial = new Map([...bodies].filter(([fn]) => fn !== 'activity_records_slot_kind'));
    expect(await check(allTriggers, allChecks, [], partial)).toEqual(['no migration defines public.activity_records_slot_kind()']);
  });

  it('reports anything else hooked into a guarded table — a later trigger, a rule', async () => {
    const extra = { ...allTriggers[0], trigger: 'zz_undo', fn: 'zz_undo' };
    expect(await check([...allTriggers, extra])).toEqual(['unexpected trigger zz_undo on activity_records']);
    expect(await check(allTriggers, allChecks, [{ table: 'emission_factors', rule: 'keep_old' }])).toEqual([
      'unexpected rule keep_old on emission_factors',
    ]);
    // A trigger on another table is not this check's business.
    expect(await check([...allTriggers, { ...extra, table: 'organisations' }])).toEqual([]);
  });

  it('watches for rules and stray triggers on every guarded table, not just one', async () => {
    // `organisations` carries a registered trigger but is not guarded: LP1-03's
    // access-removal trigger lives there too (Open questions, "LP3-03 PR B" (20)).
    const guarded = [...new Set(INTEGRITY_TRIGGERS.map((t) => t.table))].filter((t) => t !== 'organisations').sort();
    expect(guarded).toEqual(['activity_records', 'emission_factors', 'factor_release_events', 'factor_releases', 'subsidiaries', 'unit_conversions']);
    for (const table of guarded) {
      expect(await check(allTriggers, allChecks, [{ table, rule: 'r' }])).toEqual([`unexpected rule r on ${table}`]);
      const stray = { ...allTriggers.find((t) => t.table === table), trigger: 'zz_undo', fn: 'zz_undo' };
      expect(await check([...allTriggers, stray])).toEqual([`unexpected trigger zz_undo on ${table}`]);
    }
    expect(await check(allTriggers, allChecks, [{ table: 'organisations', rule: 'r' }])).toEqual([]);
  });

  it('reports a CHECK whose definition changed under its own name (CHECK (true))', async () => {
    const checks = allChecks.map((c) => (c.name === 'factor_releases_publisher_check' ? { ...c, definitionMd5: md5('CHECK (true)') } : c));
    expect(await check(allTriggers, checks)).toEqual([
      `CHECK factor_releases_publisher_check on factor_releases differs from its migration's definition (md5 ${md5('CHECK (true)')}: CHECK (...))`,
    ]);
  });

  it('reports a replaced helper — what a trigger records changes as surely as with the trigger', async () => {
    const tampered = allHelpers.map((h) => ({ ...h, bodyMd5: md5("SELECT 'service_role'") }));
    expect(await check(allTriggers, allChecks, [], bodies, tampered)).toEqual([
      "function public.factor_release_events_actor_role() differs from its migration's definition",
    ]);
    expect(await check(allTriggers, allChecks, [], bodies, allHelpers.map((h) => ({ ...h, definer: true })))).toHaveLength(1);
    // Same body, other language or search_path: still a different function.
    for (const changed of [{ language: 'plpgsql' }, { config: [] }, { config: ['search_path=public'] }]) {
      expect(await check(allTriggers, allChecks, [], bodies, allHelpers.map((h) => ({ ...h, ...changed }))), JSON.stringify(changed)).toEqual([
        "function public.factor_release_events_actor_role() differs from its migration's definition",
      ]);
    }
    expect(await check(allTriggers, allChecks, [], bodies, [])).toEqual(['function public.factor_release_events_actor_role() is missing']);
  });

  it('refuses to read a migration that redefines a guarded function in a form it cannot parse — loudly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lp303-'));
    mkdirSync(join(dir, '20990101000000_redefine'));
    writeFileSync(
      join(dir, '20990101000000_redefine', 'migration.sql'),
      'CREATE OR REPLACE FUNCTION public.activity_records_slot_kind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;',
    );
    expect(() => expectedTriggerFunctionBodies(dir)).toThrow(/cannot read/);
    rmSync(dir, { recursive: true });
  });

  it('holds the organisation guard (LP4-01) like every other: ENABLE ALWAYS, before delete, row by row, an invoker', async () => {
    expect(INTEGRITY_TRIGGERS.find((t) => t.table === 'organisations')).toEqual({
      table: 'organisations', trigger: 'organisations_delete_owner_only', fn: 'organisations_delete_owner_only', type: 1 | 2 | 8,
    });
    expect(INTEGRITY_TRIGGERS.find((t) => t.table === 'subsidiaries')).toEqual({
      table: 'subsidiaries', trigger: 'subsidiaries_stay_in_organisation', fn: 'subsidiaries_stay_in_organisation', type: 1 | 2 | 16,
    });
    expect(INTEGRITY_TRIGGERS.find((t) => t.trigger === 'activity_records_lifecycle_writer')).toEqual({
      table: 'activity_records', trigger: 'activity_records_lifecycle_writer', fn: 'activity_records_lifecycle_writer', type: 1 | 2 | 4 | 16,
    });
    expect(await check(tweak('organisations_delete_owner_only', { enabled: 'O' }))).toEqual([
      "trigger organisations_delete_owner_only on organisations is not ENABLE ALWAYS (tgenabled = 'O')",
    ]);
    expect(await check(allTriggers.filter((t) => t.trigger !== 'organisations_delete_owner_only'))).toEqual([
      'trigger organisations_delete_owner_only on organisations is missing',
    ]);
    expect(await check(tweak('organisations_delete_owner_only', { bodyMd5: md5('BEGIN RETURN OLD; END') }))).toEqual([
      "function public.organisations_delete_owner_only() differs from its migration's definition",
    ]);
    const real = expectedTriggerFunctionBodies();
    expect(real.get('organisations_delete_owner_only')).toMatch(/IF session_user <> \(SELECT pg_catalog\.pg_get_userbyid/);
    // Moving a subsidiary: its id or organisation, by anyone but the owner's session.
    expect(real.get('subsidiaries_stay_in_organisation')).toMatch(
      /IF \(NEW\."id" IS DISTINCT FROM OLD\."id" OR NEW\."organisation_id" IS DISTINCT FROM OLD\."organisation_id"\)\s+AND session_user <> \(SELECT/,
    );
    // A record is born a draft (the owner and replica mode aside), and only
    // the API's login or the owner's moves its status.
    const writer = real.get('activity_records_lifecycle_writer');
    expect(writer).toMatch(/IF NEW\."status" <> 'draft'\s+AND pg_catalog\.current_setting\('session_replication_role'\) <> 'replica'\s+AND session_user <> \(SELECT/);
    expect(writer).toMatch(new RegExp(`ELSIF NEW\\."status" IS DISTINCT FROM OLD\\."status"\\s+AND session_user <> '${RUNTIME_ROLE}'\\s+AND session_user <> \\(SELECT`));
    expect(writer).not.toMatch(/current_user/);
  });

  it('reports a record key that answers its parent\'s delete or key change with an action, that changed, or that is gone (LP4-01)', async () => {
    expect(RECORD_FOREIGN_KEYS.map(([name]) => name).sort()).toEqual([
      'activity_records_import_batch_id_fkey', 'activity_records_location_id_subsidiary_id_fkey', 'activity_records_subsidiary_id_fkey',
    ]);
    for (const [, definitionMd5] of RECORD_FOREIGN_KEYS) expect(definitionMd5).toMatch(/^[0-9a-f]{32}$/);
    const keys = (name, change) => allKeys.map((k) => (k.name === name ? { ...k, ...change } : k));
    const sub = 'activity_records_subsidiary_id_fkey';
    const action = (event, word) =>
      `foreign key ${sub} on activity_records answers its parent's ${event} with ${word} — ` +
      'a referential action writes the records as the owner, whom the delete guard lets through; only RESTRICT or NO ACTION';
    for (const [code, word] of [['c', 'CASCADE'], ['n', 'SET NULL'], ['d', 'SET DEFAULT']]) {
      expect(await check(allTriggers, allChecks, [], bodies, allHelpers, keys(sub, { onDelete: code }))).toEqual([action('delete', word)]);
      expect(await check(allTriggers, allChecks, [], bodies, allHelpers, keys(sub, { onUpdate: code }))).toEqual([action('key change', word)]);
    }
    const site = 'activity_records_location_id_subsidiary_id_fkey';
    expect(await check(allTriggers, allChecks, [], bodies, allHelpers, allKeys.filter((k) => k.name !== site))).toEqual([
      `foreign key ${site} on activity_records is missing`,
    ]);
    expect(await check(allTriggers, allChecks, [], bodies, allHelpers, keys(site, { validated: false }))).toEqual([
      `foreign key ${site} on activity_records is NOT VALID`,
    ]);
    // Re-created under its own name on other columns, still RESTRICT: only the definition tells.
    const other = 'FOREIGN KEY (location_id) REFERENCES locations(id) ON UPDATE RESTRICT ON DELETE RESTRICT';
    expect(await check(allTriggers, allChecks, [], bodies, allHelpers, keys(site, { definitionMd5: md5(other), definition: other }))).toEqual([
      `foreign key ${site} on activity_records differs from its migration's definition (md5 ${md5(other)}: ${other})`,
    ]);
    // A further key is held to the same rule; one that refuses both ways passes.
    const extra = { name: 'activity_records_zz_fkey', onDelete: 'c', onUpdate: 'a', validated: true, parent: 'zz' };
    expect(await check(allTriggers, allChecks, [], bodies, allHelpers, [...allKeys, extra])).toHaveLength(1);
    expect(await check(allTriggers, allChecks, [], bodies, allHelpers, [...allKeys, { ...extra, onDelete: 'r' }])).toEqual([]);
  });

  it("reports a record key whose system triggers are gone, disabled or replica-only — its definition unchanged (Codex's review of #159)", async () => {
    const at = (key, fn, change) => triggersOf(allKeys).map((t) => (t.key === key && t.fn === fn ? { ...t, ...change } : t));
    const keyCheck = (keyTriggers) => check(allTriggers, allChecks, [], bodies, allHelpers, allKeys, keyTriggers);
    expect(await keyCheck(triggersOf(allKeys))).toEqual([]);
    const site = 'activity_records_location_id_subsidiary_id_fkey';
    // Each of the four, on each key, disabled: reported, naming the write it no longer checks.
    for (const [key, parent, del, upd] of [
      [site, 'locations', 'RI_FKey_restrict_del', 'RI_FKey_restrict_upd'],
      ['activity_records_subsidiary_id_fkey', 'subsidiaries', 'RI_FKey_restrict_del', 'RI_FKey_restrict_upd'],
      ['activity_records_import_batch_id_fkey', 'import_batches', 'RI_FKey_noaction_del', 'RI_FKey_noaction_upd'],
    ]) {
      for (const [fn, table, write] of [
        ['RI_FKey_check_ins', 'activity_records', 'an insert into activity_records'],
        ['RI_FKey_check_upd', 'activity_records', 'an update of activity_records'],
        [del, parent, `a delete from ${parent}`],
        [upd, parent, `a key change in ${parent}`],
      ]) {
        expect(await keyCheck(at(key, fn, { enabled: 'D' })), `${key} ${fn}`).toEqual([
          `foreign key ${key} on activity_records is not enforced on ${write}: its ${fn} trigger on ${table} is disabled — ` +
            'the key holds nothing for new writes while its definition reads as before',
        ]);
      }
    }
    // Replica-only fires in a restore's session alone; ALWAYS still fires in an ordinary one.
    expect(await keyCheck(at(site, 'RI_FKey_restrict_upd', { enabled: 'R' }))).toEqual([
      `foreign key ${site} on activity_records is not enforced on a key change in locations: its RI_FKey_restrict_upd trigger on locations is ` +
        'replica-only (it fires in replica mode alone) — the key holds nothing for new writes while its definition reads as before',
    ]);
    expect(await keyCheck(at(site, 'RI_FKey_check_ins', { enabled: 'A' }))).toEqual([]);
    // Gone, or carrying another action's function: the expected one is missing.
    expect(await keyCheck(triggersOf(allKeys).filter((t) => !(t.key === site && t.fn === 'RI_FKey_check_upd')))).toEqual([
      `foreign key ${site} on activity_records has no RI_FKey_check_upd trigger on activity_records: an update of activity_records is not checked against it`,
    ]);
    expect(await keyCheck(at(site, 'RI_FKey_restrict_del', { fn: 'RI_FKey_noaction_del' }))).toEqual([
      `foreign key ${site} on activity_records has no RI_FKey_restrict_del trigger on locations: a delete from locations is not checked against it`,
    ]);
    // A trigger of another key, or on another table, does not stand in for the key's own.
    expect(await keyCheck(at(site, 'RI_FKey_check_ins', { table: 'locations' }))).toHaveLength(1);
    expect(await keyCheck(at(site, 'RI_FKey_check_ins', { key: 'activity_records_subsidiary_id_fkey' }))).toHaveLength(1);
  });

  it('reports a dropped or NOT VALID check', async () => {
    const checks = allChecks
      .filter((c) => c.name !== 'factor_releases_publisher_check')
      .map((c) => (c.name === 'emission_factors_gas_check' ? { ...c, validated: false } : c));
    expect(await check(allTriggers, checks)).toEqual([
      'CHECK emission_factors_gas_check on emission_factors is NOT VALID',
      'CHECK factor_releases_publisher_check on factor_releases is missing',
    ]);
  });
});

describe('checkFunctionExecutors — only the owner may EXECUTE a function in public, now or by default', () => {
  const fake =
    (executors, defaults, owners = [], actsAs = [], creators = []) =>
    async (sql) =>
      sql.includes('AS "via"')
        ? creators
        : sql.includes('AS "client"')
          ? actsAs
          : sql.includes('pg_default_acl')
            ? defaults
            : sql.includes('AS "owner"')
              ? owners
              : executors;

  it('passes on none, and names each executor otherwise — how it is abused, with its arguments', async () => {
    expect(await checkFunctionExecutors(fake([], []))).toEqual([]);
    expect(
      await checkFunctionExecutors(
        fake(
          [
            { fn: 'factor_releases_record_event', args: '', trigger: true, grantee: 'anon' },
            { fn: 'factor_release_events_actor_role', args: '', trigger: false, grantee: 'PUBLIC' },
            { fn: 'some_rpc', args: 'p_id uuid', trigger: false, grantee: 'authenticated' },
          ],
          [],
        ),
      ),
    ).toEqual([
      'anon may EXECUTE public.factor_releases_record_event() — attach it to a table of its own; only its owner may',
      'PUBLIC may EXECUTE public.factor_release_events_actor_role() — call it, through /rpc too; only its owner may',
      'authenticated may EXECUTE public.some_rpc(p_id uuid) — call it, through /rpc too; only its owner may',
    ]);
  });

  it("names the owner's default — global or per-schema — and leaves another creator's to the notices", async () => {
    const defaults = [
      { grantee: 'PUBLIC', creator: 'postgres', privilege: 'EXECUTE', ours: true },
      { grantee: 'anon', creator: 'postgres', privilege: 'EXECUTE', ours: true },
      { grantee: 'anon', creator: 'supabase_admin', privilege: 'EXECUTE', ours: false },
    ];
    expect(await checkFunctionExecutors(fake([], defaults))).toEqual([
      'PUBLIC may EXECUTE every new public function postgres creates — only its owner may',
      'anon may EXECUTE every new public function postgres creates — only its owner may',
    ]);
    expect(await platformDefaultPrivileges(async (sql) => (sql.includes("acldefault('f'") ? defaults : []))).toEqual([
      'anon is granted EXECUTE on every new public function supabase_admin creates',
    ]);
  });

  it('asks about every function in public, with the default ACL when none is set — not a list of names', async () => {
    const seen = [];
    await checkFunctionExecutors(async (sql) => (seen.push(sql), []));
    const [functions] = seen;
    expect(functions).toContain("COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))");
    expect(functions).toContain("a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner");
    expect(functions).toContain("WHERE n.nspname = 'public'\n");
    expect(functions).not.toContain('p.proname IN');
    expect(seen.some((sql) => sql.includes("pg_catalog.acldefault('f', c.role)") && sql.includes("IN ('EXECUTE')"))).toBe(true);
  });

  it('names a function in public another role owns', async () => {
    expect(await checkFunctionExecutors(fake([], [], [{ fn: 'some_rpc', args: 'p_id uuid', owner: 'service_role' }]))).toEqual([
      "public.some_rpc(p_id uuid) is owned by service_role — who may run, attach, alter and drop it; only the owner of the schema's tables may own one",
    ]);
    const seen = [];
    await checkFunctionExecutors(async (sql) => (seen.push(sql), []));
    expect(seen.some((sql) => sql.includes("p.proowner <> (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.activity_records'::regclass)"))).toBe(true);
  });

  it('names a client that can act as an owner in public, or create there — by any membership path', async () => {
    expect(
      await checkFunctionExecutors(
        fake(
          [],
          [],
          [],
          [
            { client: 'authenticated', owner: 'postgres', itself: false, runtime: false },
            { client: 'authenticator', owner: 'tonyai_runtime', itself: false, runtime: true },
            { client: 'service_role', owner: 'service_role', itself: true, runtime: false },
          ],
          [
            { client: 'anon', via: 'anon' },
            { client: 'authenticator', via: 'oq14_creator' },
          ],
        ),
      ),
    ).toEqual([
      'authenticated can act as postgres (a member — inherited, by SET ROLE or by ADMIN), an owner in public or of the database — it may alter, disable or drop what that role owns; no client may be',
      "authenticator can act as tonyai_runtime (a member — inherited, by SET ROLE or by ADMIN), the API's role — BYPASSRLS and its every grant; no client may be",
      'service_role owns the database, the schema public or something in it — it may alter, disable or drop it; no client may own one',
      'anon may create in public — a function it creates there is its own to run, attach and grant; no client may',
      'authenticator may create in public as oq14_creator — a function it creates there is its own to run, attach and grant; no client may',
    ]);
  });

  it('asks about every client role, by MEMBER — not only inherited privileges, which miss SET ROLE and ADMIN', async () => {
    const seen = [];
    await checkFunctionExecutors(async (sql) => (seen.push(sql), []));
    const clients = "c.rolname IN ('anon', 'authenticated', 'service_role', 'authenticator')";
    const actsAs = seen.find((sql) => sql.includes('AS "client"') && !sql.includes('AS "via"'));
    const creators = seen.find((sql) => sql.includes('AS "via"'));
    for (const sql of [actsAs, creators]) {
      expect(sql).toContain(clients);
      expect(sql).toContain("'MEMBER')");
    }
    expect(actsAs).toContain('pg_catalog.pg_has_role(c.oid, o.role, \'MEMBER\')');
    // Every role an owner's power flows from — the client itself included.
    for (const owner of [
      "SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.activity_records'::regclass",
      'UNION SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()',
      "UNION SELECT n.nspowner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'",
      "UNION SELECT k.relowner FROM pg_catalog.pg_class k WHERE k.relnamespace = 'public'::regnamespace",
      "UNION SELECT t.typowner FROM pg_catalog.pg_type t WHERE t.typnamespace = 'public'::regnamespace",
      "UNION SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace",
      "UNION SELECT 'tonyai_runtime'::regrole",
    ])
      expect(actsAs).toContain(owner);
    expect(actsAs).not.toContain('c.oid <> o.role');
    expect(creators).toContain("pg_catalog.pg_has_role(c.oid, r.oid, 'MEMBER')");
    expect(creators).toContain("pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE')");
    for (const sql of [actsAs, creators]) expect(sql).toMatch(/ORDER BY 1, 2`?$/);
  });

  it('lets a client-callable function through for its listed roles alone, by signature — not an overload', async () => {
    expect(CLIENT_CALLABLE_FUNCTIONS).toEqual({});
    expect(Object.isFrozen(CLIENT_CALLABLE_FUNCTIONS)).toBe(true);
    const rpc = (signature, args, grantee) => ({ fn: 'some_rpc', args, signature, trigger: false, grantee });
    const executors = [
      rpc('some_rpc(uuid)', 'p_id uuid', 'authenticated'),
      rpc('some_rpc(uuid)', 'p_id uuid', 'anon'),
      rpc('some_rpc(text)', 'p_name text', 'authenticated'),
    ];
    expect(await checkFunctionExecutors(fake(executors, []), { 'some_rpc(uuid)': ['authenticated'] })).toEqual([
      'anon may EXECUTE public.some_rpc(p_id uuid) — call it, through /rpc too; only its owner may',
      'authenticated may EXECUTE public.some_rpc(p_name text) — call it, through /rpc too; only its owner may',
    ]);
    // The signature the allowlist is keyed by is the one the query builds.
    const seen = [];
    await checkFunctionExecutors(async (sql) => (seen.push(sql), []));
    expect(seen[0]).toContain("p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' AS \"signature\"");
  });
});

describe('checkTableLevelGrants — only an owner holds the table-level verbs', () => {
  const fake = (granted, defaults) => async (sql) => (sql.includes('pg_default_acl') ? defaults : granted);

  it('passes when nobody but the owners holds them', async () => {
    expect(await checkTableLevelGrants(fake([], []))).toEqual([]);
  });

  it("names a grant on a table and the owner's default grant on future tables — not another creator's", async () => {
    expect(
      await checkTableLevelGrants(
        fake(
          [{ table: 'locations', grantee: 'service_role', privilege: 'TRIGGER' }],
          [
            { grantee: 'service_role', creator: 'postgres', privilege: 'TRUNCATE', ours: true },
            { grantee: 'anon', creator: 'supabase_admin', privilege: 'TRIGGER', ours: false },
          ],
        ),
      ),
    ).toEqual([
      'service_role holds TRIGGER on public.locations — only its owner may',
      'service_role is granted TRUNCATE on every new public table postgres creates — only its owner may hold it',
    ]);
  });

  it('asks for exactly the four verbs, on tables and on the default privileges every creator in public holds', async () => {
    const seen = [];
    await checkTableLevelGrants(async (sql) => (seen.push(sql), []));
    for (const sql of seen) expect(sql).toContain("('TRIGGER', 'TRUNCATE', 'REFERENCES', 'MAINTAIN')");
    expect(seen.some((sql) => sql.includes("n.nspname = 'public'"))).toBe(true);
    const [, defaults] = seen;
    // Every role that can create in public, its global default (or the
    // built-in one) and its per-schema one — not only the owner's per-schema row.
    expect(defaults).toContain("pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE')");
    expect(defaults).toContain("g.defaclnamespace = 0 AND g.defaclobjtype = 'r'");
    expect(defaults).toContain("COALESCE(g.defaclacl, pg_catalog.acldefault('r', c.role))");
    expect(defaults).toContain("d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r'");
    expect(defaults).not.toContain('d.defaclrole = (SELECT');
    expect(defaults).toContain("b.role = (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.activity_records'::regclass) AS \"ours\"");
  });
});

describe('platformDefaultPrivileges — another creator\'s defaults, named and grouped', () => {
  it('groups by creator, kind and grantee, and leaves the owner\'s to the checks', async () => {
    const tables = [
      { grantee: 'anon', creator: 'supabase_admin', privilege: 'TRIGGER', ours: false },
      { grantee: 'anon', creator: 'supabase_admin', privilege: 'TRUNCATE', ours: false },
      { grantee: 'authenticated', creator: 'supabase_admin', privilege: 'TRIGGER', ours: false },
      { grantee: 'anon', creator: 'pg_database_owner', privilege: 'TRIGGER', ours: false },
      { grantee: 'anon', creator: 'postgres', privilege: 'TRIGGER', ours: true },
    ];
    const functions = [
      { grantee: 'PUBLIC', creator: 'supabase_admin', privilege: 'EXECUTE', ours: false },
      { grantee: 'anon', creator: 'supabase_admin', privilege: 'EXECUTE', ours: false },
    ];
    expect(await platformDefaultPrivileges(async (sql) => (sql.includes("acldefault('r'") ? tables : functions))).toEqual([
      'anon is granted TRIGGER, TRUNCATE on every new public table supabase_admin creates',
      'authenticated is granted TRIGGER on every new public table supabase_admin creates',
      'anon is granted TRIGGER on every new public table pg_database_owner creates',
      'PUBLIC is granted EXECUTE on every new public function supabase_admin creates',
      'anon is granted EXECUTE on every new public function supabase_admin creates',
    ]);
    expect(await platformDefaultPrivileges(async () => [])).toEqual([]);
  });
});

describe('checkTenantInvariants — what a restore skips', () => {
  const fake = (n, slots) => async (sql) => (sql.includes('bool_or') ? [{ slots }] : [{ n }]);

  it('reports a grant across organisations and a slot holding both kinds of record', async () => {
    expect(await checkTenantInvariants(fake(0, 0))).toEqual([]);
    expect(await checkTenantInvariants(fake(1, 2))).toEqual([
      '1 user_subsidiary_access row(s) cross an organisation or point at nothing',
      '2 activity_records slot(s) hold typed records and an untyped one',
    ]);
  });
});

describe('factorLibraryReport (LP3-03)', () => {
  const fake = (n, releases, unrecorded = [], readable = true) => async (sql) =>
    sql.includes('has_table_privilege')
      ? [{ readable, who: 'tonyai_runtime' }]
      : sql.includes('WITH held') ? unrecorded : sql.includes('AS n') ? [{ n }] : releases;

  it('fails on rows the record never saw added — a load that bypassed its triggers', async () => {
    const report = await factorLibraryReport(
      fake(0, [], [{ releaseId: 'rel-1', tableName: 'unit_conversions', held: 3, recorded: 0 }]),
    );
    expect(report.problems).toEqual([
      'release rel-1 holds 3 unit_conversions row(s) but factor_release_events records 0',
    ]);
  });

  it('lists every non-authoritative release as a notice, never a problem', async () => {
    const report = await factorLibraryReport(
      fake(0, [{ publisher: 'TonyAI prototype', edition: '2026.1', status: 'placeholder', factors: 12, conversions: 3 }]),
    );
    expect(report).toEqual({
      problems: [],
      notices: ['placeholder release TonyAI prototype 2026.1 (12 factor(s), 3 conversion(s))'],
      skipped: [],
    });
  });

  it('fails on recorded rows the library no longer holds — a delete that bypassed its triggers', async () => {
    const report = await factorLibraryReport(fake(0, [], [{ releaseId: 'rel-1', tableName: 'emission_factors', held: 0, recorded: 2 }]));
    expect(report.problems).toEqual(['release rel-1 holds 0 emission_factors row(s) but factor_release_events records 2']);
  });

  it('says so — and still checks the rest — when the connection cannot read the record (the runtime role)', async () => {
    const report = await factorLibraryReport(fake(2, [], [{ releaseId: 'never', tableName: 'x', held: 1, recorded: 0 }], false));
    expect(report.problems).toEqual(['2 factor/conversion row(s) with an unspecified activity type under an authoritative release']);
    expect(report.skipped).toEqual([
      "the library's record was not reconciled: tonyai_runtime cannot read factor_release_events — run this check through the owner (DIRECT_URL)",
    ]);
  });

  it('fails on an unspecified activity type under an authoritative release', async () => {
    const report = await factorLibraryReport(fake(2, []));
    expect(report.problems).toEqual([
      '2 factor/conversion row(s) with an unspecified activity type under an authoritative release',
    ]);
  });
});
