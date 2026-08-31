import type { ActorLabel } from '@/lib/audit-view';

/**
 * Who entered a record, and who decided it.
 *
 * The record DTO carries an actor as an id PLUS a name resolved at read time,
 * and between them they express four situations that must not collapse into
 * one another:
 *
 * - **no actor** (`id === null`) — nobody has reviewed this record yet.
 * - **resolved, gone** (`name === null` with an id) — a person did this and
 *   their profile was later deleted. Read-time resolution is what makes
 *   erasure work; the opaque id survives.
 * - **resolved, unnamed** (a blank name) — `profiles.full_name` is NOT NULL but
 *   may be empty, and an empty cell that is not muted reads as a rendering bug
 *   rather than as missing data. Distinct from "gone" on purpose: this person
 *   still has an account.
 * - **a name**.
 *
 * The first renders as an absence because there is genuinely nothing to show.
 * Giving it "deleted user" would claim a person acted when none did — the same
 * mistake `actorLabel` exists to prevent on the audit trail, which is why this
 * returns that shape and reuses its muted convention.
 *
 * There is deliberately no "not resolved" state: `createdByName`,
 * `reviewedByName` and `voidedByName` are all REQUIRED on the DTO, so every
 * response that carries a record carries its actors. An earlier cut made them optional and resolved
 * them only on reads, and both screens then rendered an em dash for a record
 * that plainly had an author, because a write response had been spliced into
 * state built from a read.
 */
export function recordActorLabel(
  id: string | null,
  name: string | null,
): ActorLabel {
  if (id === null) return { text: '—', muted: true };
  if (name === null) return { text: 'deleted user', muted: true };
  // Third, and ONLY third. The type says the key is always present, but this
  // value crosses an HTTP boundary: a web bundle rolled forward ahead of the
  // API — which Phase 2 makes possible, since the two become separate
  // Container Apps revisions — receives `undefined`, and `.trim()` on it used
  // to throw inside the review queue's row `.map()`, losing the whole table
  // rather than blanking one cell.
  //
  // Order is the whole trick, and two obvious shortenings are both wrong.
  // `typeof name !== 'string'` hoisted above the null check swallows it, since
  // `typeof null` is 'object' — "deleted user" then becomes unreachable, which
  // is what the spec caught when this was written that way. `!name` folds the
  // blank-name case in too, and a blank name is a person with an account.
  if (typeof name !== 'string') return { text: '—', muted: true };
  return name.trim() === ''
    ? { text: 'unnamed user', muted: true }
    : { text: name, muted: false };
}
