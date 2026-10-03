import { describe, expect, it } from 'vitest';
import { isLoopback, parseArgs, refuseUnsafe, REMOTE_MIN_ORPHAN_AGE_HOURS } from './reconcile.cli';

/*
 * The CLI's refusals that need no database. What it reports and removes is
 * proven against real PostgreSQL and Storage in
 * test/int/storage-recovery.int.spec.ts, through the services it runs.
 */

describe('storage:reconcile — arguments', () => {
  it('reports only by default, over both buckets, 500 per check, orphans past 7 days', () => {
    expect(parseArgs([])).toMatchObject({
      buckets: ['evidence', 'import-sources'],
      limit: 500,
      verify: false,
      sweep: false,
      reclaim: false,
      apply: false,
      forgetUploads: false,
      olderThanHours: 168,
    });
  });

  it('takes pnpm\'s "--" separator, one bucket, and the mode flags', () => {
    expect(parseArgs(['--', '--bucket=import-sources', '--verify', '--limit=10'])).toMatchObject({
      buckets: ['import-sources'],
      verify: true,
      limit: 10,
    });
  });

  it('refuses what it does not know rather than ignoring it', () => {
    expect(() => parseArgs(['--aply'])).toThrow(/Unknown flag --aply/);
    expect(() => parseArgs(['reclaim'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--bucket=reports'])).toThrow(/--bucket must be one of/);
    expect(() => parseArgs(['--limit=0'])).toThrow(/at least 1/);
    expect(() => parseArgs(['--older-than=-1'])).toThrow(/at least 0/);
    expect(() => parseArgs(['--apply'])).toThrow(/only applies to --reclaim-orphans/);
    // An empty value is not zero, and a switch with a value is not on.
    expect(() => parseArgs(['--older-than='])).toThrow(/needs a value/);
    expect(() => parseArgs(['--older-than'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--limit= '])).toThrow(/needs a value/);
    expect(() => parseArgs(['--verify=no'])).toThrow(/takes no value/);
    expect(() => parseArgs(['--apply=false', '--reclaim-orphans'])).toThrow(/takes no value/);
  });
});

describe('storage:reconcile — where it may change things', () => {
  const opts = (argv: string[]) => parseArgs(argv);

  it('reports anywhere', () => {
    expect(() => refuseUnsafe(opts(['--verify']), false)).not.toThrow();
  });

  it('needs --allow-remote to sweep, reclaim or forget off a loopback host', () => {
    for (const argv of [['--sweep'], ['--reclaim-orphans', '--apply'], ['--forget-uploads']]) {
      expect(() => refuseUnsafe(opts(argv), false), argv.join(' ')).toThrow(/--allow-remote/);
      expect(() => refuseUnsafe(opts([...argv, '--allow-remote']), false), argv.join(' ')).not.toThrow();
      expect(() => refuseUnsafe(opts(argv), true), argv.join(' ')).not.toThrow();
    }
  });

  it(`never reclaims an orphan younger than ${REMOTE_MIN_ORPHAN_AGE_HOURS} h off a loopback host`, () => {
    const young = opts(['--reclaim-orphans', '--apply', '--allow-remote', '--older-than=0']);
    expect(() => refuseUnsafe(young, false)).toThrow(/cannot go below 24 hours/);
    expect(() => refuseUnsafe(young, true)).not.toThrow();
    const day = opts(['--reclaim-orphans', '--apply', '--allow-remote', '--older-than=24']);
    expect(() => refuseUnsafe(day, false)).not.toThrow();
  });

  it('judges loopback by the parsed host, not by a substring', () => {
    for (const url of ['postgresql://u:p@127.0.0.1:54322/db', 'http://localhost:54321', 'http://[::1]:5432', 'http://api.localhost']) {
      expect(isLoopback(url), url).toBe(true);
    }
    for (const url of [
      'http://localhost.evil.com',
      'http://127.0.0.1.nip.io',
      'http://localhost@evil.com',
      'postgresql://u:p@db.supabase.co:5432/postgres?host=localhost',
      undefined,
      'not a url',
    ]) {
      expect(isLoopback(url), String(url)).toBe(false);
    }
  });
});
