import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FactorReleaseImport } from '@tonyai/shared-types';
import { FactorReleaseLoader } from '../../src/factor-releases/factor-release-loader';
import { connectLoader } from './db';

const DIR = resolve(__dirname, '../../../../packages/db/factor-releases/tr-2026-11');
const read = (name: string) => JSON.parse(readFileSync(resolve(DIR, `${name}.json`), 'utf8')) as FactorReleaseImport;
const OPERATOR = 'TonyAI Sustainability Team';

/**
 * The real TR releases, loaded into the test database (owner decision
 * 2026-11-05, option A). An authoritative release cannot be deleted, so a second
 * run or a second spec finds them `already_loaded`, the loader's no-op.
 */
export async function loadTrReleases(): Promise<void> {
  const loader = new FactorReleaseLoader(connectLoader(), OPERATOR);
  for (const name of ['ipcc', 'etkb']) {
    // The dry run first, as an operator would (the factor-release-import skill).
    const dry = await loader.load(read(name), { apply: false });
    if (!['would_load', 'already_loaded'].includes(dry.outcome)) throw new Error(`${name} dry run: ${dry.outcome}`);
    const applied = await loader.load(read(name), { apply: true });
    if (!['loaded', 'already_loaded'].includes(applied.outcome)) throw new Error(`${name} load: ${applied.outcome}`);
  }
}
