import {
  isProvenanceSnapshot,
  LOCALE_FORMAT_TAGS,
  type ActivityCalculationSnapshot,
  type Locale,
  type SealedFactorReleaseDTO,
} from '@/lib/types';

/**
 * The package seal date beside the release a figure names (UAT round 2, S2).
 * Read at display time through the release id the calculation snapshot
 * already holds, so no stored snapshot is rewritten to carry it. A figure that
 * names no release, or one the list does not hold, shows no date at all.
 */

/** Release id → the ISO timestamp the database recorded when it was sealed. */
export type SealDates = ReadonlyMap<string, string>;

export function sealDateIndex(releases: readonly SealedFactorReleaseDTO[]): SealDates {
  return new Map(releases.map((r) => [r.id, r.sealedAt]));
}

/** The seal timestamp of `releaseId`, or null when it is unknown. */
export function sealDateFor(dates: SealDates | null, releaseId: string | null | undefined): string | null {
  if (!dates || !releaseId) return null;
  return dates.get(releaseId) ?? null;
}

/** The release a calculated figure was priced from; null for a snapshot that names none. */
export function factorReleaseId(snapshot: ActivityCalculationSnapshot | null | undefined): string | null {
  return isProvenanceSnapshot(snapshot) ? snapshot.factorRelease.id : null;
}

/**
 * A seal timestamp as a date in the user's locale (date only). In one fixed
 * time zone, Istanbul's, where the TonyAI reviewer seals packages: a seal at
 * 22:30 UTC must not read as two different dates on two screens.
 */
export function formatSealDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/Istanbul',
  }).format(new Date(iso));
}
