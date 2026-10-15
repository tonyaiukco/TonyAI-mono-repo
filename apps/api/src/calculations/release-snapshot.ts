import type { FactorRelease } from '@tonyai/db';
import type { FactorReleaseSnapshot, FactorStatus, GwpSet } from '@tonyai/shared-types';

/**
 * A release as a calculation snapshot names it (LP3-03) — the engine's
 * spelling, and a report dataset's for a release's publication (LP3-04 PR C,
 * V11), so the two never disagree. A leaf: no Nest service is imported to
 * reach it.
 */

/** The release columns a `FactorReleaseSnapshot` carries — never reviewer, withdrawer or notes. */
export const RELEASE_SNAPSHOT_SELECT = {
  id: true,
  publisher: true,
  title: true,
  edition: true,
  ordinal: true,
  status: true,
  sourceUrl: true,
  licence: true,
  publishedAt: true,
  gwpSet: true,
} as const;

export function releaseSnapshot(
  release: Pick<FactorRelease, keyof typeof RELEASE_SNAPSHOT_SELECT>,
): FactorReleaseSnapshot {
  return {
    id: release.id,
    publisher: release.publisher,
    title: release.title,
    edition: release.edition,
    ordinal: release.ordinal,
    status: release.status as FactorStatus,
    sourceUrl: release.sourceUrl,
    licence: release.licence,
    publishedAt: release.publishedAt ? release.publishedAt.toISOString().slice(0, 10) : null,
    gwpSet: release.gwpSet as GwpSet | null,
  };
}
