import type { ReportMetaDTO } from '@/lib/types';

/**
 * What the Reports screen says about figures withdrawn from the reporting year.
 *
 * A pure function rather than JSX for the same reason `void-view.ts` is one: it
 * is the sentence that tells a user what the file they are about to generate
 * will disclose, and a sentence living inside a component is a sentence no test
 * can hold to account. Mutation proved the point on this very package — a
 * banner counting the wrong set read identically on a fixture where both counts
 * happened to be 1.
 *
 * Returns `null` when there is nothing to disclose. An empty restatement notice
 * is a claim of its own: a clean year should read as a clean year.
 */
export function withdrawalNotice(
  meta: Pick<ReportMetaDTO, 'voidedCount'> | null,
): string | null {
  if (!meta || meta.voidedCount <= 0) return null;
  const subject =
    meta.voidedCount === 1
      ? '1 record was withdrawn'
      : `${meta.voidedCount} records were withdrawn`;
  const pronoun = meta.voidedCount === 1 ? 'It counts' : 'They count';
  const object = meta.voidedCount === 1 ? 'it' : 'them';
  return (
    `${subject} from this reporting year. ${pronoun} towards no figure above, ` +
    `and every export lists ${object} with the reason recorded at the time.`
  );
}
