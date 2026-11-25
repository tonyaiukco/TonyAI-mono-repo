import { ApiError } from '@/lib/api';
import { formatNumber, parseLocaleDecimal } from '@/lib/i18n/number';
import type { ErrorDescription } from '@/lib/i18n/errors';
import type { ViewCopy } from '@/lib/i18n/view-translator';
import { NACE_CODE_MAX_LENGTH, NACE_CODE_PATTERN } from '@/lib/types';
import type { Locale, NodeType, SubsidiaryBlockerKind, SubsidiarySummaryDTO } from '@/lib/types';

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

/** The `subsidiaries` key the deletable note is worded with. */
export type DeletableKey = 'dependents.deletableNothing';

/**
 * Said when nothing blocks a delete. Since the group tree (inc26-group-tree,
 * RD9) a facility blocks the delete like a child node does, so nothing ever
 * goes with a deleted company.
 */
export function deletableNote({ t }: ViewCopy<DeletableKey>): string {
  return t('dependents.deletableNothing');
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

// ---------------------------------------------------------------------------
// The group tree (inc26-group-tree): the company screen draws its nodes
// nested by `parentId`.
// ---------------------------------------------------------------------------

/** What a tree row needs of a company node. */
export interface TreeNode {
  id: string;
  parentId: string | null;
  nodeType: NodeType;
  legalName: string;
}

export interface TreeRow<T extends TreeNode> {
  node: T;
  /** 0 for a top-level row. */
  depth: number;
  hasChildren: boolean;
}

const TYPE_ORDER: Readonly<Record<NodeType, number>> = {
  holding: 0,
  sub_holding: 1,
  sector_group: 2,
  company: 3,
  child_company: 4,
};

/**
 * The reader's nodes in tree order: each under its parent, depth-first,
 * siblings by type (holding, sub-holding, sector group, company, child
 * company) then name. A node whose parent is not among `nodes` — the reader
 * may not read it, and the API then sends `null` — is shown at the top level,
 * with nothing said of that parent. The children of a collapsed node are
 * left out. A malformed input (a cycle) still terminates, every node once.
 */
export function treeRows<T extends TreeNode>(
  nodes: readonly T[],
  collapsed: ReadonlySet<string> = new Set(),
  locale = 'en',
): TreeRow<T>[] {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map<string, T[]>();
  const tops: T[] = [];
  for (const n of nodes) {
    if (n.parentId !== null && n.parentId !== n.id && ids.has(n.parentId)) {
      children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
    } else {
      tops.push(n);
    }
  }
  const order = (a: T, b: T) =>
    TYPE_ORDER[a.nodeType] - TYPE_ORDER[b.nodeType] || a.legalName.localeCompare(b.legalName, locale) || a.id.localeCompare(b.id);
  const rows: TreeRow<T>[] = [];
  const seen = new Set<string>();
  const walk = (n: T, depth: number, visible: boolean) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    const kids = [...(children.get(n.id) ?? [])].sort(order);
    if (visible) rows.push({ node: n, depth, hasChildren: kids.length > 0 });
    for (const k of kids) walk(k, depth + 1, visible && !collapsed.has(n.id));
  };
  for (const t of [...tops].sort(order)) walk(t, 0, true);
  // Anything a cycle kept from every top, once, at the top level.
  for (const n of [...nodes].sort(order)) walk(n, 0, true);
  return rows;
}

/**
 * The create and edit forms' optional share percent, read in the user's
 * convention: blank is "none" (`null`), anything else a number from 0 to 100
 * with two decimals at most — the API's bound — or `invalid`.
 */
export function parseSharePercent(text: string, locale: Locale): number | null | 'invalid' {
  if (text.trim() === '') return null;
  const read = parseLocaleDecimal(text, locale);
  if (!read.ok) return 'invalid';
  const v = read.value;
  // At most two decimals, read with a tolerance: 1.1 * 100 is 110.00000000000001
  // in binary floating point, and an exact comparison refused about one valid
  // share in nine (QA review, WP7).
  if (v < 0 || v > 100 || Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return 'invalid';
  return v;
}

/** The optional NACE code: blank is none, else it must read as one. */
export function parseNaceCode(text: string): string | null | 'invalid' {
  const code = text.trim().toUpperCase();
  if (code === '') return null;
  return code.length <= NACE_CODE_MAX_LENGTH && NACE_CODE_PATTERN.test(code) ? code : 'invalid';
}
