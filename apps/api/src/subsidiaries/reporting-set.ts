import type { Prisma } from '@tonyai/db';

/**
 * `holdsRecords` (`@tonyai/shared-types`) as a Prisma filter: every node but a
 * sector group, and never an associate (inc26-group-tree, design D6) — the
 * reporting set the matrix, the KPI counts, intensity and the pickers read;
 * the company list and the tree keep every node. Kept
 * beside the predicate's one definition — a change to either is a change to
 * both, pinned by `reporting-set.spec.ts`.
 */
export const HOLDS_RECORDS_WHERE = Object.freeze({
  nodeType: { not: 'sector_group' },
  control: 'controlled',
} as const) satisfies Prisma.SubsidiaryWhereInput;
