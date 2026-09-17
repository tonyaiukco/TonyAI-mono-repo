import type { AuditLogDTO } from '@/lib/types';

/**
 * Who performed an audited action — and whether anyone did.
 *
 * `userId === null` and "a `userId` whose profile is gone" are different rows
 * and the trail must not conflate them:
 *
 * - a **deleted profile** (`userId` set, no name or email) means a person did
 *   this and their account was later removed. Identity is joined at read time,
 *   which is what makes erasure work while the opaque id survives.
 * - a **null actor** means no person was involved at all. `pnpm
 *   anomaly:recompute` writes `rescore` rows that way.
 *
 * Rendering the second as "deleted user" tells a reader of a compliance trail
 * something untrue about both — that someone acted, and that their account is
 * gone. It lives here with its own spec because it is a claim, not styling.
 */
export interface ActorLabel {
  text: string;
  /** Render muted + italic: the label is a description, not a name. */
  muted: boolean;
}

export function actorLabel(
  row: Pick<AuditLogDTO, 'userId' | 'userFullName' | 'userEmail'>,
): ActorLabel {
  if (row.userId === null) return { text: 'system', muted: true };
  const named = row.userFullName ?? row.userEmail;
  return named === null || named === undefined
    ? { text: 'deleted user', muted: true }
    : { text: named, muted: false };
}

/**
 * The batch rows `bulk_import` and `bulk_submit` write: a file or a request,
 * not a figure. Keyed on the diff's SHAPE, not the verb, because rows written
 * before the verbs existed sit under `create`/`submit` with the same diff.
 * Every field is optional on purpose — the diff is what the API of the day
 * recorded (`BulkImportAuditDiff` / `BulkSubmitAuditDiff` today), and a
 * missing count is left out rather than shown as 0.
 */
export function summariseBatch(diff: Record<string, unknown>): string | null {
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const count = (v: unknown) => (typeof v === 'number' ? v : null);
  if (diff.refused === true) {
    return [text(diff.fileName), 'refused', text(diff.reason)].filter(Boolean).join(' · ');
  }
  if ('fileName' in diff || 'acceptedCount' in diff) {
    const accepted = count(diff.acceptedCount);
    const rejected = count(diff.rejectedCount);
    const dryRun = diff.dryRun === true;
    const parts = [
      text(diff.fileName),
      dryRun ? 'dry run' : null,
      accepted !== null ? `${accepted} ${dryRun ? 'would import' : 'imported'}` : null,
      rejected ? `${rejected} refused` : null,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }
  if ('requested' in diff) {
    const submitted = count(diff.submittedCount);
    const requested = count(diff.requested);
    return submitted !== null && requested !== null
      ? `${submitted} of ${requested} submitted`
      : null;
  }
  return null;
}
