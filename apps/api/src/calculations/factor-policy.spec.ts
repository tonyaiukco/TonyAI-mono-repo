import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOW_PLACEHOLDER_FACTORS,
  factorPolicyFrom,
  isPlainlyLocalUrl,
  parseAllowPlaceholders,
} from './factor-policy';

const LOCAL_DB = 'postgresql://tonyai_runtime:pw@127.0.0.1:54322/postgres';

describe('parseAllowPlaceholders — only the exact string `true` is on (K3)', () => {
  it.each([
    ['true', true],
    [undefined, false],
    ['', false],
    ['TRUE', false],
    ['True', false],
    ['1', false],
    ['yes', false],
    ['on', false],
    [' true', false],
    ['true ', false],
    ['"true"', false],
    ['false', false],
  ])('%j → %s', (raw, on) => {
    expect(parseAllowPlaceholders(raw)).toBe(on);
  });
});

describe('isPlainlyLocalUrl', () => {
  it.each([
    'postgresql://u:p@127.0.0.1:54322/postgres',
    'postgresql://u:p@localhost:5432/db',
    'postgresql://u:p@[::1]:5432/db',
    'http://127.0.0.1:54321',
    'http://LOCALHOST:54321',
  ])('accepts %s', (url) => {
    expect(isPlainlyLocalUrl(url)).toBe(true);
  });

  it.each([
    'postgresql://u:p@db.example.supabase.co:5432/postgres',
    'https://abc.supabase.co',
    // libpq lets a query parameter redirect the connection whatever the
    // authority says.
    'postgresql://u:p@127.0.0.1:5432/db?host=db.example.com',
    'postgresql://u:p@127.0.0.1:5432/db?hostaddr=10.0.0.5',
    'postgresql://u:p@127.0.0.1:5432/db?HOST=db.example.com',
    // Local to a container, not to the machine the guard can see.
    'http://host.docker.internal:54321',
    'http://127.0.0.1.example.com',
    'not a url',
    '',
  ])('refuses %s', (url) => {
    expect(isPlainlyLocalUrl(url)).toBe(false);
  });
});

describe('factorPolicyFrom', () => {
  it('is off, and frozen, when the flag is absent — whatever the URLs', () => {
    const policy = factorPolicyFrom({ DATABASE_URL: 'postgresql://u:p@db.example.com/x' });
    expect(policy).toEqual({ allowPlaceholders: false });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('is on for a local database and a local (or unset) Supabase project', () => {
    expect(factorPolicyFrom({ [ALLOW_PLACEHOLDER_FACTORS]: 'true', DATABASE_URL: LOCAL_DB })).toEqual({
      allowPlaceholders: true,
    });
    expect(
      factorPolicyFrom({
        [ALLOW_PLACEHOLDER_FACTORS]: 'true',
        DATABASE_URL: LOCAL_DB,
        SUPABASE_URL: 'http://127.0.0.1:54321',
      }),
    ).toEqual({ allowPlaceholders: true });
  });

  it('refuses the flag against a remote database, a redirected one, or none', () => {
    for (const DATABASE_URL of [
      'postgresql://u:p@db.example.supabase.co:5432/postgres',
      `${LOCAL_DB}?host=db.example.com`,
      undefined,
      '',
    ]) {
      expect(() => factorPolicyFrom({ [ALLOW_PLACEHOLDER_FACTORS]: 'true', DATABASE_URL })).toThrow(
        /ALLOW_PLACEHOLDER_FACTORS=true is refused: DATABASE_URL/,
      );
    }
  });

  it('refuses the flag against a remote Supabase project', () => {
    expect(() =>
      factorPolicyFrom({
        [ALLOW_PLACEHOLDER_FACTORS]: 'true',
        DATABASE_URL: LOCAL_DB,
        SUPABASE_URL: 'https://abc.supabase.co',
      }),
    ).toThrow(/SUPABASE_URL is not a local project/);
  });
});

describe('the flag stays out of deployed configuration', () => {
  // Obligation 2 of LP3-03 PR A's review: staging and production must never
  // set it, and `infra/**` is where their configuration lives (Terraform,
  // runbooks, Container Apps settings). A mention there is refused here,
  // in `pnpm test`, before CI.
  const repoRoot = resolve(__dirname, '../../../..');
  function filesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name.startsWith('.terraform')) return [];
      const path = join(dir, name);
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
  }

  it('is not named anywhere under infra/', () => {
    const offenders = filesUnder(join(repoRoot, 'infra')).filter((file) =>
      readFileSync(file, 'utf8').includes(ALLOW_PLACEHOLDER_FACTORS),
    );
    expect(offenders.map((f) => relative(repoRoot, f))).toEqual([]);
  });
});
