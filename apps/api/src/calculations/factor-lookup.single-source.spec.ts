import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * ONE factor lookup (LP3-04 PR B, W2; README: coverage "must not copy private
 * candidate SQL/diagnostic selection a third time"). Every read of the factor
 * library's rows in the API and the database package is listed here, file by
 * file, with how many times it names the library: a new reader — a report, a
 * coverage producer, a script — fails this spec until it either goes through
 * `lookupFactorPath` or is added below with the reason it is not a selection.
 */

const repoRoot = resolve(__dirname, '../../../..');
const ROOTS = ['apps/api/src', 'packages/db/prisma', 'packages/db/scripts', 'packages/db/src'];
/**
 * A model query however it is spelled across lines, a release that includes
 * or selects its rows, and the tables' names in raw SQL (qa-auditor P3-8).
 */
const LIBRARY_READ =
  /(emissionFactor|unitConversion)\s*\.\s*(find[A-Za-z]*|count|aggregate|groupBy)\b|\b(factors|conversions)\s*:\s*(true|\{)|\b(emission_factors|unit_conversions)\b/g;

/** File → how many times it may name the library; `'any'` for a catalogue that is no reader. */
const ALLOWED: Record<string, number | 'any'> = {
  // The lookup itself: the candidate factors and conversions.
  'apps/api/src/calculations/factor-lookup.ts': 2,
  // `listFactors` — the catalogue `GET /factors` lists, no selection.
  'apps/api/src/calculations/calculations.service.ts': 1,
  // A comment naming the table.
  'apps/api/src/calculations/normalization.ts': 1,
  // The loader re-reads a release it just stored, by its id.
  'apps/api/src/factor-releases/factor-release-loader.ts': 2,
  // The seed's `resolveFactor` — the accepted second copy (LP4-02 follow-up
  // (26)): local, single-writer, it prices the demo records — and its
  // presence checks by id.
  'packages/db/prisma/seed.ts': 4,
  // Grants and integrity checks name the tables; nothing is selected.
  'packages/db/scripts/runtime-role.mjs': 'any',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'generated' || name === 'migrations' ? [] : sources(path);
    if (!/\.(ts|mts|mjs|js)$/.test(name) || /\.spec\.(ts|mjs)$|\.test-support\.ts$/.test(name)) return [];
    return [path];
  });
}

describe('the factor library has one reader that selects', () => {
  const found = new Map<string, number>();
  for (const root of ROOTS) {
    for (const file of sources(join(repoRoot, root))) {
      const count = readFileSync(file, 'utf8').match(LIBRARY_READ)?.length ?? 0;
      if (count > 0) found.set(relative(repoRoot, file), count);
    }
  }

  it('names the library only where listed, as often as listed', () => {
    const unexpected = [...found].filter(([file, count]) => {
      const allowed = ALLOWED[file];
      return allowed === undefined || (allowed !== 'any' && count !== allowed);
    });
    expect(unexpected, 'a library read outside `lookupFactorPath` — route it through the lookup, or list it with its reason').toEqual([]);
  });

  it('sees a read however it is spelled — a split chain, a release that includes its rows (qa-auditor P3-8)', () => {
    for (const sample of [
      'await prisma.emissionFactor\n      .findMany({ where })',
      'db.unitConversion . findFirst({ where })',
      "prisma.factorRelease.findMany({ include: { factors: { where: { category } } } })",
      'tx.factorRelease.findUnique({ where: { id }, include: { conversions: true } })',
      "SELECT * FROM emission_factors",
    ]) {
      expect(sample.match(LIBRARY_READ)?.length ?? 0, sample).toBeGreaterThan(0);
    }
  });

  it('lists nothing stale', () => {
    expect(Object.keys(ALLOWED).filter((file) => !found.has(file))).toEqual([]);
  });
});
