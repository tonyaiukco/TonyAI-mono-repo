import type { ReportMetaDTO } from '@/lib/types';

/**
 * The Reports screen's restatement notice: whether it shows, and for how
 * many records. It exists so a user knows what the artifact will say BEFORE
 * they generate it — the same disclosure the PDF, Excel and CSV carry, in the
 * place the decision to send the file is made. The words are the `reports`
 * catalogue's (`withdrawnOne` / `withdrawnMany`, LP4-03 PR B): both halves,
 * excluded from every figure and listed in every export.
 *
 * Null for a clean year: an empty restatement notice is a claim of its own.
 */
export function withdrawalNotice(
  meta: Pick<ReportMetaDTO, 'voidedCount'> | null,
): { count: number } | null {
  if (!meta || meta.voidedCount <= 0) return null;
  return { count: meta.voidedCount };
}
