import type { ActorLabel } from '@/lib/audit-view';

/**
 * Who entered a record, and who decided it.
 *
 * The record DTO carries an actor as an id PLUS a name resolved at read time,
 * and between them they express four situations that must not collapse into
 * one another:
 *
 * - **no actor** (`id === null`) — nobody has reviewed this record yet.
 * - **not resolved** (`name === undefined`) — the response that produced this
 *   record did not join identities. Write responses do not.
 * - **resolved, gone** (`name === null` with an id) — a person did this and
 *   their profile was later deleted. Read-time resolution is what makes
 *   erasure work; the opaque id survives.
 * - **a name**.
 *
 * The first two render as an absence because there is genuinely nothing to
 * show. The third renders as "deleted user", and giving it to either of the
 * others would claim a person acted when none did — the same mistake
 * `actorLabel` exists to prevent on the audit trail, which is why this returns
 * that shape and reuses its muted convention.
 */
export function recordActorLabel(
  id: string | null,
  name: string | null | undefined,
): ActorLabel {
  if (id === null || name === undefined) return { text: '—', muted: true };
  return name === null
    ? { text: 'deleted user', muted: true }
    : { text: name, muted: false };
}
