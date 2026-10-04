import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertLocalSeedTarget, seedActivityType } from './seed-guards';

describe('assertLocalSeedTarget — the seed writes placeholder factors and known-password users', () => {
  it.each([
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    'postgresql://postgres:postgres@localhost:5432/postgres',
    'http://127.0.0.1:54321',
    'http://[::1]:54321',
  ])('accepts %s', (url) => {
    expect(() => assertLocalSeedTarget(url, 'X')).not.toThrow();
  });

  it.each([
    'postgresql://postgres:pw@db.abc.supabase.co:5432/postgres',
    'postgresql://postgres:pw@127.0.0.1:5432/postgres?host=db.example.com',
    'postgresql://postgres:pw@127.0.0.1:5432/postgres?hostaddr=10.0.0.1',
    'https://abc.supabase.co',
    'http://localhost.evil.example:54321',
    'not a url',
    undefined,
  ])('refuses %s', (url) => {
    expect(() => assertLocalSeedTarget(url, 'X')).toThrow();
  });
});

describe('seedActivityType', () => {
  it('names diesel for Fuel, nothing for an implicit category', () => {
    expect(seedActivityType('Fuel')).toBe('diesel');
    expect(seedActivityType('Electricity')).toBeNull();
    expect(seedActivityType('Natural Gas')).toBeNull();
  });

  it('refuses a typed category the seed has no type for, rather than writing a legacy-only untyped record', () => {
    expect(() => seedActivityType('Refrigerants')).toThrow(/names no activity type/);
  });
});

describe('the seed calls its guards before it connects', () => {
  // seed.ts runs on import, so it is pinned by its text: each target is
  // checked before the client that writes to it is built.
  const seed = readFileSync(join(__dirname, 'seed.ts'), 'utf8');
  const at = (needle: string) => {
    const i = seed.indexOf(needle);
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it('checks the database URL before the Prisma client', () => {
    expect(at("assertLocalSeedTarget(SEED_DATABASE_URL, ")).toBeLessThan(at('new PrismaClient({ datasourceUrl: SEED_DATABASE_URL })'));
  });

  it('checks the Supabase URL before the auth client that creates the demo users', () => {
    expect(at("assertLocalSeedTarget(SUPABASE_URL, ")).toBeLessThan(at('createClient(SUPABASE_URL, '));
  });
});
