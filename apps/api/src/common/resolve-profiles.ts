import type { PrismaService } from '../prisma/prisma.service';

export interface ResolvedProfile {
  email: string;
  fullName: string | null;
}

/**
 * Resolve a set of actor ids to their profiles in ONE query.
 *
 * Actor columns across this schema — `audit_log.user_id`, `activity_records`'
 * `created_by`, `reviewed_by` and `voided_by` — are plain UUIDs with **no
 * foreign key**, deliberately: the row has to survive the actor's deletion, and
 * identity is joined at read time so an erasure removes the name while the
 * opaque id stays. That design is what makes this helper necessary; there is no
 * `include` to reach for.
 *
 * Two queries per page, never per row, and none at all for a page with no
 * actors. Extracted from `AuditService.list`, which held the only copy in the
 * API: doing it before a second caller exists is the cheapest moment, and it
 * closes the door on a third hand-rolled version drifting from the other two.
 */
export async function resolveProfiles(
  prisma: Pick<PrismaService, 'profile'>,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, ResolvedProfile>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const profiles = await prisma.profile.findMany({
    where: { id: { in: unique } },
    select: { id: true, email: true, fullName: true },
  });
  return new Map(
    profiles.map((p) => [p.id, { email: p.email, fullName: p.fullName }]),
  );
}

/**
 * The name to show for an actor, or `null` when there is nothing to show.
 *
 * `null` means two different things and the CALLER has to keep them apart: no
 * actor at all (`id` is null — a record nobody has reviewed), versus an actor
 * whose profile is gone. Both render as an absence, but only the second means a
 * person did this. The id is what tells them apart, which is why it stays on
 * the DTO beside the name.
 *
 * Falls back to email when a profile carries no full name, matching
 * `actorLabel` on the web side. A row that resolved to neither is not a name.
 */
export function actorDisplayName(
  id: string | null | undefined,
  byId: Map<string, ResolvedProfile>,
): string | null {
  if (!id) return null;
  const profile = byId.get(id);
  return profile ? (profile.fullName ?? profile.email) : null;
}
