import { ApiError } from '@/lib/api';
import { formatNumber } from '@/lib/i18n/number';
import type { ErrorDescription } from '@/lib/i18n/errors';
import type { ViewCopy } from '@/lib/i18n/view-translator';
import type { SubsidiaryBlockerKind, SubsidiarySummaryDTO } from '@/lib/types';

/**
 * The Subsidiaries screens' sentences (LP4-04 slice 2 PR C): what stands in
 * the way of a delete, whether a delete would take locations with it, and a
 * failed read or write in the user's words.
 */

/** The `subsidiaries` keys a blocker is worded with — one per kind. */
export type BlockerKey = `blockers.${SubsidiaryBlockerKind}`;

/**
 * Why the subsidiary cannot be deleted, one line per dependent, in the user's
 * language — the same facts and order as the API's own sentences
 * (`SubsidiarySummaryDTO.blockerCounts`; English word for word the server's,
 * its counts grouped). An API that sent no facts (an older build) is shown by
 * its English sentences, never by nothing.
 */
export function blockerLines(
  summary: Pick<SubsidiarySummaryDTO, 'blockers' | 'blockerCounts'>,
  { t, locale }: ViewCopy<BlockerKey>,
): string[] {
  const counts = summary.blockerCounts ?? [];
  if (counts.length === 0) return summary.blockers;
  return counts.map(({ kind, count }) => t(`blockers.${kind}`, { count: formatNumber(count, locale) }));
}

/** The `subsidiaries` keys the deletable note is worded with. */
export type DeletableKey = 'dependents.deletableOne' | 'dependents.deletableMany' | 'dependents.deletableNothing';

/** Said when nothing blocks a delete: what would go with the subsidiary. */
export function deletableNote(locations: number, { t, locale }: ViewCopy<DeletableKey>): string {
  if (locations === 0) return t('dependents.deletableNothing');
  const count = formatNumber(locations, locale);
  return locations === 1 ? t('dependents.deletableOne', { count }) : t('dependents.deletableMany', { count });
}

/** The `subsidiaries` keys an error is worded with. */
export type SubsidiaryErrorKey = 'errors.forbidden' | 'errors.unavailable';

/**
 * A failed read or write on the subsidiary's page in the user's words. A seat
 * without access and an outage get the page's own sentences; anything else —
 * a lapsed session included — is described by its code (`describe`: the
 * catalogue's sentence, the server's English beneath a generic Turkish one
 * where the code is generic, K5).
 */
export function subsidiaryError(
  error: unknown,
  { t }: ViewCopy<SubsidiaryErrorKey>,
  describe: (error: unknown) => ErrorDescription,
): ErrorDescription {
  if (error instanceof ApiError) {
    if (error.status === 403) return { title: t('errors.forbidden') };
    if (error.status >= 500) return { title: t('errors.unavailable') };
  }
  return describe(error);
}

/** The `subsidiaries` keys the locations drawer's subtitle is worded with. */
export type LocationCountKey = 'locations.drawerCountOne' | 'locations.drawerCountMany';

export function locationCountLine(name: string, count: number, { t, locale }: ViewCopy<LocationCountKey>): string {
  const values = { name, count: formatNumber(count, locale) };
  return count === 1 ? t('locations.drawerCountOne', values) : t('locations.drawerCountMany', values);
}
