import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FACTOR_RELEASE_FILE_MAX_BYTES, isLocalDatabase, main, parseArgs, readReleaseFile, refuseUnsafe, UsageError } from './factor-release.cli';
import { LoaderRefusal } from './factor-release-loader';

const LOAD = ['load', '--file=release.json', '--operator=TonyAI data team'];

describe('parseArgs', () => {
  it('reads a load — a dry run unless --apply — and an erratum that withdraws the edition it supersedes', () => {
    expect(parseArgs(['--', ...LOAD])).toEqual({
      command: 'load', operator: 'TonyAI data team', apply: false, allowRemote: false, file: 'release.json',
    });
    expect(parseArgs([...LOAD, '--supersedes=2026', '--reason=Erratum: two rows corrected', '--apply'])).toEqual({
      command: 'load', operator: 'TonyAI data team', apply: true, allowRemote: false, file: 'release.json',
      supersedes: '2026', reason: 'Erratum: two rows corrected',
    });
  });

  it('reads a withdrawal of one edition of one publisher', () => {
    expect(
      parseArgs(['withdraw', '--publisher=TonyAI test fixture', '--edition=int-1', '--reason=Found wrong', '--operator=TonyAI data team', '--allow-remote']),
    ).toEqual({
      command: 'withdraw', operator: 'TonyAI data team', apply: false, allowRemote: true,
      publisher: 'TonyAI test fixture', edition: 'int-1', reason: 'Found wrong',
    });
  });

  it.each([
    ['no command', []],
    ['an unknown command', ['delete', '--operator=TonyAI data team']],
    ['no operator', ['load', '--file=r.json']],
    ['a load without its file', ['load', '--operator=TonyAI data team']],
    ['an erratum without its reason', [...LOAD, '--supersedes=2026']],
    ['a reason with nothing superseded', [...LOAD, '--reason=why']],
    ['a withdrawal without its reason', ['withdraw', '--publisher=P', '--edition=E', '--operator=TonyAI data team']],
    ['a withdrawal without its edition', ['withdraw', '--publisher=P', '--reason=r', '--operator=TonyAI data team']],
    ['a flag of another command', [...LOAD, '--publisher=P']],
    ['an unknown flag', [...LOAD, '--force']],
    ['a switch with a value', [...LOAD, '--apply=no']],
    ['an empty value', ['load', '--file=', '--operator=TonyAI data team']],
    ['a flag given twice', [...LOAD, '--file=other.json']],
    ['a stray argument', [...LOAD, 'extra']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });

  // `factor_release_events.actor` and `withdrawn_by` name a firm or a role,
  // never a person (P8); the database's CHECK bounds the rest.
  it.each([
    ['a person’s address', 'ayse@ornek.com.tr'],
    ['padding', ' TonyAI data team'],
    ['a control character', 'TonyAI\u0007data'],
    ['an invisible formatting character', 'TonyAI​data'],
    ['a decomposed letter (not NFC)', 'Örnek'.normalize('NFD')],
    ['more than 200 characters', 'x'.repeat(201)],
  ])('refuses an operator with %s', (_label, operator) => {
    expect(() => parseArgs(['load', '--file=r.json', `--operator=${operator}`])).toThrow(UsageError);
  });

  it('keeps an operator as written — refused, never quietly cleaned', () => {
    expect(parseArgs([...LOAD.slice(0, 2), '--operator=Örnek Danışmanlık A.Ş.']).operator).toBe('Örnek Danışmanlık A.Ş.');
  });
});

describe('refuseUnsafe', () => {
  const options = parseArgs(LOAD);
  it('lets a dry run read anywhere, and an --apply write a loopback database', () => {
    expect(() => refuseUnsafe(options, false)).not.toThrow();
    expect(() => refuseUnsafe({ ...options, apply: true }, true)).not.toThrow();
  });

  it('refuses an --apply off a loopback database without --allow-remote', () => {
    expect(() => refuseUnsafe({ ...options, apply: true }, false)).toThrow(/--allow-remote/);
    expect(() => refuseUnsafe({ ...options, apply: true, allowRemote: true }, false)).not.toThrow();
  });
});

describe('isLocalDatabase — an allowlist, as runtime-role.mjs reads a local URL', () => {
  it('admits a loopback host with only the parameters a local URL carries', () => {
    expect(isLocalDatabase('postgresql://u:p@127.0.0.1:54322/postgres')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@localhost:54322/postgres?schema=public&connection_limit=1')).toBe(true);
    expect(isLocalDatabase('postgresql://u:p@[::1]:54322/postgres')).toBe(true);
    expect(isLocalDatabase('postgres://u:p@127.0.0.1:54322/postgres')).toBe(true);
  });

  it('refuses another host, and any parameter that could redirect it — whatever its case', () => {
    for (const url of [
      'postgresql://u:p@db.example.com:5432/postgres',
      'postgresql://u:p@localhost:54322/postgres?host=staging.example',
      'postgresql://u:p@localhost:54322/postgres?HOST=staging.example',
      'postgresql://u:p@localhost:54322/postgres?hostaddr=10.0.0.1',
      'postgresql://u:p@localhost:54322/postgres?options=-c%20x',
      'postgresql://u:p@db.localhost:54322/postgres',
      'http://localhost:54322/postgres',
      'not a url',
      undefined,
    ]) {
      expect(isLocalDatabase(url), String(url)).toBe(false);
    }
  });
});

describe('readReleaseFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factor-release-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, content: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it('reads the release as JSON, unvalidated — the contract checks it', () => {
    expect(readReleaseFile(file('ok.json', '{"release":{},"factors":[],"conversions":[]}'))).toEqual({
      release: {}, factors: [], conversions: [],
    });
  });

  it('refuses a file that is not JSON, a missing file, a directory, and one over the size cap', () => {
    expect(() => readReleaseFile(file('bad.json', '{"release":'))).toThrow(UsageError);
    expect(() => readReleaseFile(join(dir, 'missing.json'))).toThrow(UsageError);
    expect(() => readReleaseFile(dir)).toThrow(UsageError);
    expect(() => readReleaseFile(file('big.json', Buffer.alloc(FACTOR_RELEASE_FILE_MAX_BYTES + 1, 32)))).toThrow(/larger than/);
  });

  it('reads a file of exactly the cap — the cap is the largest size allowed', () => {
    // All spaces: past the size check, refused only as JSON.
    expect(() => readReleaseFile(file('cap.json', Buffer.alloc(FACTOR_RELEASE_FILE_MAX_BYTES, 32)))).toThrow(/is not JSON/);
  });
});

describe('main — the exit code an operator script reads', () => {
  const sink = () => {
    const chunks: string[] = [];
    return { chunks, write: (chunk: string) => (chunks.push(chunk), true) };
  };

  it('answers a refusal with 2 and the whole report as JSON — every issue, however many', async () => {
    const out = sink();
    const issues = Array.from({ length: 20_000 }, (_, i) => ({ path: `factors[${i}].gas`, message: 'is not a gas' }));
    const code = await main([...LOAD], out, sink(), async () => {
      throw new LoaderRefusal('the release file has 20000 issue(s) — nothing was written', issues);
    });
    expect(code).toBe(2);
    expect(JSON.parse(out.chunks.join(''))).toMatchObject({ outcome: 'refused', issues: { length: 20_000 } });
  });

  it('answers a usage error with 2, a done or planned run with 0, and a failure with 2', async () => {
    const err = sink();
    expect(await main(['load'], sink(), err, async () => ({}) as never)).toBe(2);
    expect(err.chunks.join('')).toMatch(/load needs --file/);
    const out = sink();
    expect(await main([...LOAD], out, sink(), async () => ({ command: 'load', outcome: 'would_load' }) as never)).toBe(0);
    expect(JSON.parse(out.chunks.join(''))).toMatchObject({ outcome: 'would_load' });
    expect(await main([...LOAD], sink(), sink(), async () => {
      throw new Error('connection refused');
    })).toBe(2);
  });
});
