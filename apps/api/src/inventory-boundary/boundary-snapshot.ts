import {
  CATEGORIES,
  MONTH_NAMES,
  type Category,
  type InventoryApplicabilityDecision,
  type InventoryAttributionPolicy,
  type InventoryBoundarySnapshot,
  type InventoryEntitySnapshot,
  type InventoryMonth,
  type InventoryObligation,
  type InventorySource,
  type ReportingPeriod,
} from '@tonyai/shared-types';

/**
 * An inventory boundary version as `InventoryBoundarySnapshot` (LP3-04 PR B;
 * README "Inventory coverage and report datasets"), built from its stored rows
 * — pure, so every rule below is a DB-free spec. What the tables hold is the
 * owner's declaration; what this derives is never stored: the entities, the
 * obligations and their evidence periods, an included cell's sources (W1).
 *
 * It reports the version as it is, gaps and all: a missing cell or policy, an
 * included cell with no source, a source under an excluded cell are LP3-04 PR
 * C's coverage gaps to raise, not this builder's to hide or refuse. Structural
 * breaches the tables can hold none of (a duplicate policy, an included mapped
 * source off its policy's cadence, a source named by two cells) need no check
 * here: the keys refuse them.
 */

/** A version's header. */
export interface BoundaryHeaderRow {
  id: string;
  organisationId: string;
  reportingYear: number;
  version: number;
  decision: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  frozenAt: Date | null;
}

/** A name and geography: as frozen into the version, and as they are now. */
interface Named {
  frozenName: string | null;
  frozenGeographyCode: string | null;
  liveName: string;
  liveGeographyCode: string;
}

export interface BoundarySubsidiaryRow extends Named {
  subsidiaryId: string;
  firstMonth: number;
  lastMonth: number;
}

export interface BoundarySiteRow extends Named {
  subsidiaryId: string;
  locationId: string;
  firstMonth: number;
  lastMonth: number;
}

export interface BoundaryPolicyRow {
  subsidiaryId: string;
  category: string;
  level: string;
  reportingPeriod: string;
}

export interface BoundaryCellRow {
  subsidiaryId: string;
  locationId: string | null;
  category: string;
  applicability: string;
  reason: string | null;
}

export interface BoundarySourceRow {
  id: string;
  subsidiaryId: string;
  locationId: string | null;
  name: string;
  scope: number;
  mapping: string;
  category: string | null;
  activityType: string | null;
  unsupportedReason: string | null;
  applicability: string;
  reason: string | null;
  reportingPeriod: string | null;
  evidenceReportingPeriod: string | null;
}

export interface BoundaryRows {
  header: BoundaryHeaderRow;
  subsidiaries: readonly BoundarySubsidiaryRow[];
  sites: readonly BoundarySiteRow[];
  policies: readonly BoundaryPolicyRow[];
  cells: readonly BoundaryCellRow[];
  sources: readonly BoundarySourceRow[];
}

/** A row the tables' CHECKs and keys should have refused — a defect, never a gap. */
export class BoundaryRowsDefect extends Error {}

const month = (m: number): InventoryMonth => m as InventoryMonth;

/** The months of a period of a cadence: a month, a quarter, the year. */
function periodsOf(cadence: ReportingPeriod): Array<{ periodValue: string; firstMonth: number; lastMonth: number }> {
  switch (cadence) {
    case 'monthly':
      return MONTH_NAMES.map((name, i) => ({ periodValue: name, firstMonth: i + 1, lastMonth: i + 1 }));
    case 'quarterly':
      return [1, 2, 3, 4].map((q) => ({ periodValue: `Q${q}`, firstMonth: 3 * q - 2, lastMonth: 3 * q }));
    case 'annual':
      return [{ periodValue: 'Annual', firstMonth: 1, lastMonth: 12 }];
  }
}

/** The periods of a cadence that overlap [first, last], clipped to it. */
function clipped(cadence: ReportingPeriod, first: number, last: number) {
  return periodsOf(cadence)
    .filter((p) => p.lastMonth >= first && p.firstMonth <= last)
    .map((p) => ({ ...p, firstMonth: Math.max(p.firstMonth, first), lastMonth: Math.min(p.lastMonth, last) }));
}

/**
 * An included source's obligations: its cadence's periods over its entity's
 * operating months, clipped to them — every month exactly once — each with
 * the evidence periods of its own months at the evidence cadence (none for
 * null). An id is the source's and the period's, so it is the same whenever
 * the same version is read, and unique across the version.
 */
export function obligationsFor(
  sourceId: string,
  cadence: ReportingPeriod,
  evidenceCadence: ReportingPeriod | null,
  firstMonth: number,
  lastMonth: number,
): InventoryObligation[] {
  return clipped(cadence, firstMonth, lastMonth).map((p) => ({
    id: `${sourceId}:${p.periodValue}`,
    reportingPeriod: cadence,
    periodValue: p.periodValue,
    firstMonth: month(p.firstMonth),
    lastMonth: month(p.lastMonth),
    evidencePeriods: evidenceCadence === null
      ? []
      : clipped(evidenceCadence, p.firstMonth, p.lastMonth).map((e) => ({
          reportingPeriod: evidenceCadence,
          periodValue: e.periodValue,
        })),
  }));
}

/** A frozen version's copy, or the live name of one still open (W7). */
function named(row: Named, frozen: boolean, what: string): { name: string; geographyCode: string } {
  if (!frozen) return { name: row.liveName, geographyCode: row.liveGeographyCode };
  if (row.frozenName === null || row.frozenGeographyCode === null) {
    throw new BoundaryRowsDefect(`${what} of a frozen inventory boundary has no frozen name`);
  }
  return { name: row.frozenName, geographyCode: row.frozenGeographyCode };
}

const NIL = '';
const entityKey = (subsidiaryId: string, locationId: string | null) => `${subsidiaryId}/${locationId ?? NIL}`;
const categoryRank = (c: string | null) => (c === null ? CATEGORIES.length : CATEGORIES.indexOf(c as Category));
const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

export function buildBoundarySnapshot(rows: BoundaryRows): InventoryBoundarySnapshot {
  const { header } = rows;
  const frozen = header.frozenAt !== null;
  if (header.decision !== 'confirmed' && header.decision !== 'unconfirmed') {
    throw new BoundaryRowsDefect(`inventory boundary ${header.id} has decision ${header.decision}`);
  }

  // Entities: each declared subsidiary's company entity, then its sites.
  const companies = [...rows.subsidiaries].sort((a, b) => compare(a.subsidiaryId, b.subsidiaryId));
  const subsidiaryName = new Map<string, string>();
  const entities = new Map<string, InventoryEntitySnapshot>();
  for (const s of companies) {
    const { name, geographyCode } = named(s, frozen, `subsidiary ${s.subsidiaryId}`);
    subsidiaryName.set(s.subsidiaryId, name);
    entities.set(entityKey(s.subsidiaryId, null), {
      subsidiaryId: s.subsidiaryId,
      subsidiaryName: name,
      locationId: null,
      locationName: null,
      geographyCode,
      firstMonth: month(s.firstMonth),
      lastMonth: month(s.lastMonth),
    });
  }
  const sites = [...rows.sites].sort((a, b) => compare(a.subsidiaryId, b.subsidiaryId) || compare(a.locationId, b.locationId));
  for (const s of sites) {
    const parent = subsidiaryName.get(s.subsidiaryId);
    if (parent === undefined) throw new BoundaryRowsDefect(`site ${s.locationId} has no declared subsidiary`);
    const { name, geographyCode } = named(s, frozen, `site ${s.locationId}`);
    entities.set(entityKey(s.subsidiaryId, s.locationId), {
      subsidiaryId: s.subsidiaryId,
      subsidiaryName: parent,
      locationId: s.locationId,
      locationName: name,
      geographyCode,
      firstMonth: month(s.firstMonth),
      lastMonth: month(s.lastMonth),
    });
  }
  const entityOf = (subsidiaryId: string, locationId: string | null, what: string) => {
    const entity = entities.get(entityKey(subsidiaryId, locationId));
    if (entity === undefined) throw new BoundaryRowsDefect(`${what} is at an entity the version does not declare`);
    return entity;
  };

  // Sources, in a stable order: entity, category, activity type, name, id.
  const orderedSources = [...rows.sources].sort(
    (a, b) =>
      compare(a.subsidiaryId, b.subsidiaryId) ||
      compare(a.locationId ?? NIL, b.locationId ?? NIL) ||
      compare(categoryRank(a.category), categoryRank(b.category)) ||
      compare(a.activityType ?? NIL, b.activityType ?? NIL) ||
      compare(a.name, b.name) ||
      compare(a.id, b.id),
  );
  const sources: InventorySource[] = orderedSources.map((s) => {
    const entity = entityOf(s.subsidiaryId, s.locationId, `source ${s.id}`);
    if (s.scope !== 1 && s.scope !== 2) throw new BoundaryRowsDefect(`source ${s.id} has scope ${s.scope}`);
    const common = {
      id: s.id,
      name: s.name,
      entity,
      scope: s.scope as 1 | 2,
      mapping:
        s.mapping === 'mapped'
          ? { kind: 'mapped' as const, category: s.category as Category, activityType: s.activityType }
          : { kind: 'unsupported' as const, reason: s.unsupportedReason as string },
    };
    if (s.applicability === 'included') {
      const cadence = s.reportingPeriod as ReportingPeriod;
      const evidence = s.evidenceReportingPeriod as ReportingPeriod | null;
      return {
        ...common,
        applicability: 'included',
        reportingPeriod: cadence,
        evidenceReportingPeriod: evidence,
        obligations: obligationsFor(s.id, cadence, evidence, entity.firstMonth, entity.lastMonth),
      };
    }
    return { ...common, applicability: s.applicability as 'excluded' | 'undetermined', reason: s.reason as string };
  });

  // Cells: an included one names every included mapped source at its entity
  // and category; the others hold none.
  const included = new Map<string, string[]>();
  for (const s of orderedSources) {
    if (s.applicability === 'included' && s.mapping === 'mapped') {
      const key = `${entityKey(s.subsidiaryId, s.locationId)}/${s.category}`;
      included.set(key, [...(included.get(key) ?? []), s.id]);
    }
  }
  const applicability: InventoryApplicabilityDecision[] = [...rows.cells]
    .sort(
      (a, b) =>
        compare(a.subsidiaryId, b.subsidiaryId) ||
        compare(a.locationId ?? NIL, b.locationId ?? NIL) ||
        compare(categoryRank(a.category), categoryRank(b.category)),
    )
    .map((c) => {
      entityOf(c.subsidiaryId, c.locationId, `a ${c.category} cell`);
      const cell = { subsidiaryId: c.subsidiaryId, locationId: c.locationId, category: c.category as Category };
      return c.applicability === 'included'
        ? { ...cell, applicability: 'included' as const, sourceIds: [...(included.get(`${entityKey(c.subsidiaryId, c.locationId)}/${c.category}`) ?? [])].sort() }
        : { ...cell, applicability: c.applicability as 'excluded' | 'undetermined', reason: c.reason as string };
    });

  const attribution: InventoryAttributionPolicy[] = [...rows.policies]
    .sort((a, b) => compare(a.subsidiaryId, b.subsidiaryId) || compare(categoryRank(a.category), categoryRank(b.category)))
    .map((p) => ({
      subsidiaryId: p.subsidiaryId,
      category: p.category as Category,
      level: p.level as 'company' | 'sites',
      reportingPeriod: p.reportingPeriod as ReportingPeriod,
    }));

  return {
    id: header.id,
    version: header.version,
    organisationId: header.organisationId,
    reportingYear: header.reportingYear,
    subsidiaryIds: companies.map((s) => s.subsidiaryId),
    decision: header.decision,
    decidedBy: header.decidedBy,
    decidedAt: header.decidedAt?.toISOString() ?? null,
    entities: [...entities.values()],
    applicability,
    attribution,
    sources,
  };
}
