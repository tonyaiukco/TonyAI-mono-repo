import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_ROLE,
  isLoopbackUrl,
  randomRuntimePassword,
  runtimeUrlFrom,
  scramVerifier,
  urlUser,
  INTEGRITY_CHECKS,
  INTEGRITY_TRIGGERS,
  checkIntegrityTriggers,
  expectedTriggerFunctionBodies,
  factorLibraryReport,
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
    table: t.table, trigger: t.trigger, enabled: 'A', type: t.type, fnSchema: 'public', fn: t.fn, bodyMd5: md5(bodies.get(t.fn)),
  }));
  const allChecks = INTEGRITY_CHECKS.map(([table, name]) => ({ table, name, validated: true }));
  const fake = (triggers, constraints) => async (sql) => (sql.includes('pg_trigger') ? triggers : constraints);
  const check = (triggers, constraints = allChecks) => checkIntegrityTriggers(fake(triggers, constraints), bodies);
  const tweak = (name, change) => allTriggers.map((t) => (t.trigger === name ? { ...t, ...change } : t));

  it('passes when every trigger is ENABLE ALWAYS, on its events, running its own unaltered function', async () => {
    expect(await check(allTriggers)).toEqual([]);
  });

  it('covers K5, the slot rule and all four events on all three factor tables', () => {
    expect(INTEGRITY_TRIGGERS).toHaveLength(2 + 3 * 4);
    expect(INTEGRITY_TRIGGERS.map((t) => t.trigger)).toContain('activity_records_snapshot_immutable');
    expect(INTEGRITY_TRIGGERS.find((t) => t.trigger === 'unit_conversions_before_truncate')).toMatchObject({
      fn: 'factor_tables_before_truncate',
      type: 2 | 32,
    });
  });

  it('finds every trigger function in the migrations, as the database must hold it', () => {
    const real = expectedTriggerFunctionBodies();
    expect([...real.keys()].sort()).toEqual([...new Set(INTEGRITY_TRIGGERS.map((t) => t.fn))].sort());
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

  it('reports a dropped or NOT VALID check', async () => {
    const checks = allChecks
      .filter((c) => c.name !== 'factor_releases_publisher_check')
      .map((c) => (c.name === 'emission_factors_gas_check' ? { ...c, validated: false } : c));
    expect(await check(allTriggers, checks)).toEqual([
      'CHECK factor_releases_publisher_check on factor_releases is missing',
      'CHECK emission_factors_gas_check on emission_factors is NOT VALID',
    ]);
  });
});

describe('factorLibraryReport (LP3-03)', () => {
  const fake = (n, releases) => async (sql) => (sql.includes('AS n') ? [{ n }] : releases);

  it('lists every non-authoritative release as a notice, never a problem', async () => {
    const report = await factorLibraryReport(
      fake(0, [{ publisher: 'TonyAI prototype', edition: '2026.1', status: 'placeholder', factors: 12, conversions: 3 }]),
    );
    expect(report).toEqual({
      problems: [],
      notices: ['placeholder release TonyAI prototype 2026.1 (12 factor(s), 3 conversion(s))'],
    });
  });

  it('fails on an unspecified activity type under an authoritative release', async () => {
    const report = await factorLibraryReport(fake(2, []));
    expect(report.problems).toEqual([
      '2 factor/conversion row(s) with an unspecified activity type under an authoritative release',
    ]);
  });
});
