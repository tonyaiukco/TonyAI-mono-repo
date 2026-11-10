import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FactorReleaseImport } from '@tonyai/shared-types';
import { FactorReleaseLoader } from '../../src/factor-releases/factor-release-loader';
import { connectLoader } from './db';

const RELEASES = resolve(__dirname, '../../../../packages/db/factor-releases');
/**
 * In load order: a publisher's ordinals must rise, so the TR package's IPCC
 * release (ordinal 1) precedes the supplementary MGO edition (ordinal 2,
 * UAT2 BUG-R2-11), which neither supersedes nor overlaps it.
 */
const FILES = {
  ipcc: 'tr-2026-11/ipcc.json',
  etkb: 'tr-2026-11/etkb.json',
  'ipcc-mgo': 'tr-mgo-2026-11/ipcc-mgo.json',
} as const;
const read = (name: keyof typeof FILES) =>
  JSON.parse(readFileSync(resolve(RELEASES, FILES[name]), 'utf8')) as FactorReleaseImport;
const OPERATOR = 'TonyAI Sustainability Team';

/**
 * The real TR releases and the MGO edition beside them, loaded into the test
 * database (owner decision 2026-11-05, option A). An authoritative release cannot be deleted, so a second
 * run or a second spec finds them `already_loaded`, the loader's no-op.
 */
export async function loadTrReleases(): Promise<void> {
  const client = connectLoader();
  const loader = new FactorReleaseLoader(client, OPERATOR);
  for (const name of ['ipcc', 'etkb', 'ipcc-mgo'] as const) {
    // The dry run first, as an operator would (the factor-release-import skill).
    const dry = await loader.load(read(name), { apply: false });
    if (!['would_load', 'already_loaded'].includes(dry.outcome)) throw new Error(`${name} dry run: ${dry.outcome}`);
    const applied = await loader.load(read(name), { apply: true });
    if (!['loaded', 'already_loaded'].includes(applied.outcome)) throw new Error(`${name} load: ${applied.outcome}`);
  }
  await client.$disconnect();
}
