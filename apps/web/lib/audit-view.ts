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
