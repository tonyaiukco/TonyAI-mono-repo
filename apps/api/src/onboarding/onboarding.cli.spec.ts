import { afterEach, describe, expect, it } from 'vitest';
import { isLoopback, parseArgs, refuseUnsafe, run, UsageError } from './onboarding.cli';

const PROVISION = [
  'provision', '--operator=ops@tonyai.com', '--legal-name=Örnek Holding A.Ş.', '--country=tr', '--geography-code=tr',
  '--admin-email=ayse@ornek.com.tr', '--admin-name=Ayşe Yılmaz', '--language=tr',
];

describe('parseArgs', () => {
  it('reads a provisioning of a new organisation — a dry run unless --apply', () => {
    const options = parseArgs(['--', ...PROVISION]);
    expect(options).toMatchObject({
      command: 'provision', operator: 'ops@tonyai.com', apply: false, allowRemote: false,
      provision: {
        adminEmail: 'ayse@ornek.com.tr', adminName: 'Ayşe Yılmaz', language: 'tr',
        organisation: { legalName: 'Örnek Holding A.Ş.', country: 'TR', geographyCode: 'TR', reportingCurrency: 'EUR' },
      },
    });
    expect(parseArgs([...PROVISION, '--apply', '--currency=try']).provision?.organisation?.reportingCurrency).toBe('TRY');
  });

  it('reads a first administrator for an existing organisation, and offboard / reconcile', () => {
    const org = '11111111-1111-1111-1111-111111111111';
    expect(parseArgs(['provision', '--operator=o@x.io', `--organisation-id=${org}`, '--admin-email=a@x.io', '--admin-name=A', '--language=en']))
      .toMatchObject({ organisationId: org, provision: { organisationId: org, organisation: undefined } });
    expect(parseArgs(['offboard', '--operator=o@x.io', `--organisation-id=${org}`, '--apply'])).toMatchObject({ command: 'offboard', apply: true });
    const mixed = 'AbCdEf12-3456-4789-8ABC-DEF012345678';
    expect(parseArgs(['offboard', '--operator=o@x.io', `--organisation-id=${mixed}`]).organisationId).toBe(mixed.toLowerCase());
    expect(parseArgs(['reconcile', '--operator=o@x.io'])).toMatchObject({ command: 'reconcile', organisationId: undefined });
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['delete', '--operator=o@x.io']],
    ['no operator', ['reconcile']],
    ['an operator that is not an address', ['reconcile', '--operator=ops']],
    ['an unknown flag', ['reconcile', '--operator=o@x.io', '--force']],
    ['a flag of another command', ['offboard', '--operator=o@x.io', '--organisation-id=11111111-1111-1111-1111-111111111111', '--language=en']],
    ['a switch with a value', ['reconcile', '--operator=o@x.io', '--apply=no']],
    ['an empty value', ['reconcile', '--operator=']],
    ['a flag given twice', ['reconcile', '--operator=o@x.io', '--operator=p@x.io']],
    ['an id that is not one', ['offboard', '--operator=o@x.io', '--organisation-id=1']],
    ['offboard without the organisation', ['offboard', '--operator=o@x.io']],
    ['a language the product does not speak', PROVISION.map((a) => (a === '--language=tr' ? '--language=de' : a))],
    ['a country that is not ISO', PROVISION.map((a) => (a === '--country=tr' ? '--country=Turkey' : a))],
    ['a new organisation without its name', PROVISION.filter((a) => !a.startsWith('--legal-name'))],
    ['organisation fields beside --organisation-id', [...PROVISION, '--organisation-id=11111111-1111-1111-1111-111111111111']],
    ['a positional argument', ['reconcile', 'now', '--operator=o@x.io']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  // UAT round 2, K1: the default subsidiary takes the organisation's geography,
  // and a subsidiary may only be UK, TR or EU — refused before anything is written.
  it.each(['de', 'GB', 'TR-34'])('refuses a geography no subsidiary can have (%s), naming the accepted ones', (code) => {
    const argv = PROVISION.map((a) => (a === '--geography-code=tr' ? `--geography-code=${code}` : a));
    expect(() => parseArgs(argv)).toThrow(new UsageError('--geography-code must be one of UK, TR, EU'));
  });

  it.each([['tr', 'TR'], ['uk', 'UK'], ['EU', 'EU']])('accepts the geography %s as %s', (given, stored) => {
    const argv = PROVISION.map((a) => (a === '--geography-code=tr' ? `--geography-code=${given}` : a));
    expect(parseArgs(argv).provision?.organisation?.geographyCode).toBe(stored);
  });

  it.each([
    ['a one-character legal name', '--legal-name=X', '--legal-name must be 2 to 200 characters'],
    ['a legal name past 200 characters', `--legal-name=${'x'.repeat(201)}`, '--legal-name must be 2 to 200 characters'],
    ['a trading name past 200 characters', `--trading-name=${'x'.repeat(201)}`, '--trading-name must be at most 200 characters'],
    ['a sector past 200 characters', `--sector=${'x'.repeat(201)}`, '--sector must be at most 200 characters'],
  ])('refuses %s — the default subsidiary carries it (K1)', (_label, flag, message) => {
    const argv = flag.startsWith('--legal-name') ? PROVISION.map((a) => (a.startsWith('--legal-name') ? flag : a)) : [...PROVISION, flag];
    expect(() => parseArgs(argv)).toThrow(new UsageError(message));
  });

  it('accepts names at a subsidiary\'s bounds', () => {
    const argv = [...PROVISION.map((a) => (a.startsWith('--legal-name') ? `--legal-name=${'x'.repeat(200)}` : a)), `--trading-name=${'t'.repeat(200)}`, `--sector=${'s'.repeat(200)}`];
    expect(parseArgs(argv).provision?.organisation).toMatchObject({ legalName: 'x'.repeat(200) });
    expect(parseArgs(PROVISION.map((a) => (a.startsWith('--legal-name') ? '--legal-name=XY' : a))).provision?.organisation?.legalName).toBe('XY');
  });

  it('needs no geography for an existing organisation', () => {
    const org = '11111111-1111-1111-1111-111111111111';
    expect(() => parseArgs(['provision', '--operator=o@x.io', `--organisation-id=${org}`, '--admin-email=a@x.io', '--admin-name=A', '--language=en'])).not.toThrow();
  });
});

describe('isLoopback and refuseUnsafe', () => {
  it('knows this machine, and not a parameter that points elsewhere', () => {
    expect(isLoopback('postgresql://postgres:x@127.0.0.1:54322/postgres')).toBe(true);
    expect(isLoopback('http://localhost:54321')).toBe(true);
    expect(isLoopback('postgresql://postgres:x@127.0.0.1:5432/postgres?host=db.prod.example.com')).toBe(false);
    expect(isLoopback('postgresql://postgres:x@db.example.com:5432/postgres')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });

  it('writes off loopback only with --allow-remote; a dry run anywhere', () => {
    const dry = parseArgs(['reconcile', '--operator=o@x.io']);
    const apply = parseArgs(['reconcile', '--operator=o@x.io', '--apply']);
    const allowed = parseArgs(['reconcile', '--operator=o@x.io', '--apply', '--allow-remote']);
    expect(() => refuseUnsafe(dry, false)).not.toThrow();
    expect(() => refuseUnsafe(apply, true)).not.toThrow();
    expect(() => refuseUnsafe(apply, false)).toThrow(UsageError);
    expect(() => refuseUnsafe(allowed, false)).not.toThrow();
  });
});

describe('run — where it points, before it connects', () => {
  const saved = { DIRECT_URL: process.env.DIRECT_URL, SUPABASE_URL: process.env.SUPABASE_URL };
  afterEach(() => Object.assign(process.env, saved));

  it('refuses to write when Supabase is remote although the database is local (it would ban real accounts)', async () => {
    process.env.DIRECT_URL = 'postgresql://postgres:x@127.0.0.1:1/none';
    process.env.SUPABASE_URL = 'https://abc.supabase.co';
    await expect(run(parseArgs(['reconcile', '--operator=o@x.io', '--apply']))).rejects.toBeInstanceOf(UsageError);
  });

  it('refuses without the owner connection', async () => {
    delete process.env.DIRECT_URL;
    await expect(run(parseArgs(['reconcile', '--operator=o@x.io']))).rejects.toThrow('DIRECT_URL');
  });
});
