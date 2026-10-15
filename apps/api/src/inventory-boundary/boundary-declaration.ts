import type {
  InventoryApplicabilityCell,
  InventoryAttributionPolicy as PolicyRow,
  InventoryBoundarySite,
  InventoryBoundarySubsidiary,
  InventorySource as SourceRow,
} from '@tonyai/db';
import {
  CATEGORIES,
  CATEGORY_SCOPE_MAP,
  type Category,
  type InventoryApplicabilityCellInput,
  type InventoryAttributionPolicyInput,
  type InventoryCategory,
  type InventoryMonth,
  type InventorySourceInput,
  type PutInventoryBoundarySubsidiaryRequest,
  type ReportingPeriod,
} from '@tonyai/shared-types';

/**
 * One subsidiary's declaration (LP3-04's write path, E1) as the boundary's
 * tables store it, and back. The API derives what the contract leaves out of
 * a body — the company entity's key, a mapped source's scope (its category's)
 * and cadence (its policy's, Decisions 2026-10-15 (third) (7)), an included
 * mapped source's claim key (PR B's (4)) — each by its CHECK's own rule, so a
 * body the DTOs admit is rows the database admits. Pure: the service writes
 * these rows, and an audit row holds `declarationOf` them, before and after.
 */

/** The company entity's key in cells and sources (PR B's migration). */
export const COMPANY_ENTITY_KEY = '00000000-0000-0000-0000-000000000000';

/** Where a declaration is written: the version and the route's subsidiary. */
export interface DeclarationTarget {
  boundaryId: string;
  organisationId: string;
  subsidiaryId: string;
}

type SubsidiaryRowInput = Pick<InventoryBoundarySubsidiary, 'boundaryId' | 'organisationId' | 'subsidiaryId' | 'firstMonth' | 'lastMonth'>;
type SiteRowInput = Pick<InventoryBoundarySite, 'boundaryId' | 'subsidiaryId' | 'locationId' | 'firstMonth' | 'lastMonth'>;
type CellRowInput = InventoryApplicabilityCell;
type SourceRowInput = SourceRow;

/** A declaration's rows, in the order their keys need them inserted. */
export interface DeclarationRows {
  subsidiary: SubsidiaryRowInput;
  sites: SiteRowInput[];
  policies: PolicyRow[];
  cells: CellRowInput[];
  sources: SourceRowInput[];
}

const entityKey = (locationId: string | null) => locationId ?? COMPANY_ENTITY_KEY;

/** The rows that store `body` as `target`'s declaration; `newId` names each source. */
export function declarationRows(
  target: DeclarationTarget,
  body: PutInventoryBoundarySubsidiaryRequest,
  newId: () => string,
): DeclarationRows {
  const { boundaryId, subsidiaryId } = target;
  const cadenceOf = new Map(body.attribution.map((p) => [p.category, p.reportingPeriod] as const));
  return {
    subsidiary: { ...target, firstMonth: body.firstMonth, lastMonth: body.lastMonth },
    sites: body.sites.map((s) => ({ boundaryId, subsidiaryId, locationId: s.locationId, firstMonth: s.firstMonth, lastMonth: s.lastMonth })),
    policies: body.attribution.map((p) => ({ boundaryId, subsidiaryId, category: p.category, level: p.level, reportingPeriod: p.reportingPeriod })),
    cells: body.applicability.map((c) => ({
      boundaryId,
      subsidiaryId,
      locationId: c.locationId,
      locationKey: entityKey(c.locationId),
      category: c.category,
      applicability: c.applicability,
      reason: c.applicability === 'included' ? null : c.reason,
    })),
    sources: body.sources.map((s) => {
      const included = s.applicability === 'included';
      const common = {
        id: newId(),
        boundaryId,
        subsidiaryId,
        locationId: s.locationId,
        locationKey: entityKey(s.locationId),
        name: s.name,
        applicability: s.applicability,
        reason: s.applicability === 'included' ? null : s.reason,
        evidenceReportingPeriod: s.applicability === 'included' ? s.evidenceReportingPeriod : null,
      };
      if (s.mapping.kind === 'mapped') {
        const { category, activityType } = s.mapping;
        return {
          ...common,
          scope: CATEGORY_SCOPE_MAP[category],
          mapping: 'mapped',
          category,
          activityType,
          // An included mapped source's claim: its type, '' for an untyped category.
          includedActivityKey: included ? (activityType ?? '') : null,
          unsupportedReason: null,
          // The DTOs hold that an included one's policy is declared (third (7)).
          reportingPeriod: included ? (cadenceOf.get(category) ?? null) : null,
        };
      }
      // A nested discriminant does not narrow the source itself.
      const unsupported = s as Extract<InventorySourceInput, { mapping: { kind: 'unsupported' } }>;
      return {
        ...common,
        scope: unsupported.scope,
        mapping: 'unsupported',
        category: null,
        activityType: null,
        includedActivityKey: null,
        unsupportedReason: unsupported.mapping.reason,
        reportingPeriod: unsupported.applicability === 'included' ? unsupported.reportingPeriod : null,
      };
    }),
  };
}

/** A declaration as an audit row holds it: the body's shape, each source
 * with the id it was stored under. */
export type StoredDeclaration = Omit<PutInventoryBoundarySubsidiaryRequest, 'sources'> & {
  sources: ReadonlyArray<InventorySourceInput & { id: string }>;
};

/** The columns a stored declaration is read back from. */
export interface StoredDeclarationRows {
  subsidiary: Pick<InventoryBoundarySubsidiary, 'firstMonth' | 'lastMonth'>;
  sites: ReadonlyArray<Pick<InventoryBoundarySite, 'locationId' | 'firstMonth' | 'lastMonth'>>;
  policies: ReadonlyArray<Pick<PolicyRow, 'category' | 'level' | 'reportingPeriod'>>;
  cells: ReadonlyArray<Pick<InventoryApplicabilityCell, 'locationId' | 'category' | 'applicability' | 'reason'>>;
  sources: ReadonlyArray<Pick<
    SourceRow,
    | 'id' | 'locationId' | 'name' | 'scope' | 'mapping' | 'category' | 'activityType' | 'unsupportedReason'
    | 'applicability' | 'reason' | 'reportingPeriod' | 'evidenceReportingPeriod'
  >>;
}

const month = (m: number) => m as InventoryMonth;
const categoryRank = (c: string | null) => (c === null ? CATEGORIES.length : CATEGORIES.indexOf(c as Category));
const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** The declaration its rows store, in one order whatever order they were read in. */
export function declarationOf(rows: StoredDeclarationRows): StoredDeclaration {
  return {
    firstMonth: month(rows.subsidiary.firstMonth),
    lastMonth: month(rows.subsidiary.lastMonth),
    sites: [...rows.sites]
      .sort((a, b) => compare(a.locationId, b.locationId))
      .map((s) => ({ locationId: s.locationId, firstMonth: month(s.firstMonth), lastMonth: month(s.lastMonth) })),
    attribution: [...rows.policies]
      .sort((a, b) => compare(categoryRank(a.category), categoryRank(b.category)))
      .map((p) => ({
        category: p.category as InventoryCategory,
        level: p.level as InventoryAttributionPolicyInput['level'],
        reportingPeriod: p.reportingPeriod as ReportingPeriod,
      })),
    applicability: [...rows.cells]
      .sort((a, b) => compare(a.locationId ?? '', b.locationId ?? '') || compare(categoryRank(a.category), categoryRank(b.category)))
      .map((c): InventoryApplicabilityCellInput => {
        const cell = { locationId: c.locationId, category: c.category as InventoryCategory };
        return c.applicability === 'included'
          ? { ...cell, applicability: 'included' }
          : { ...cell, applicability: c.applicability as 'excluded' | 'undetermined', reason: c.reason as string };
      }),
    sources: [...rows.sources]
      .sort((a, b) =>
        compare(a.locationId ?? '', b.locationId ?? '')
        || compare(categoryRank(a.category), categoryRank(b.category))
        || compare(a.activityType ?? '', b.activityType ?? '')
        || compare(a.name, b.name)
        || compare(a.id, b.id))
      .map((s) => sourceOf(s)),
  };
}

function sourceOf(s: StoredDeclarationRows['sources'][number]): InventorySourceInput & { id: string } {
  const head = { id: s.id, locationId: s.locationId, name: s.name };
  const decision = s.applicability === 'included'
    ? { applicability: 'included' as const, evidenceReportingPeriod: s.evidenceReportingPeriod as ReportingPeriod | null }
    : { applicability: s.applicability as 'excluded' | 'undetermined', reason: s.reason as string };
  if (s.mapping === 'mapped') {
    return {
      ...head,
      mapping: { kind: 'mapped', category: s.category as InventoryCategory, activityType: s.activityType },
      ...decision,
    };
  }
  const mapping = { kind: 'unsupported' as const, reason: s.unsupportedReason as string };
  const scope = s.scope as 1 | 2;
  return decision.applicability === 'included'
    ? { ...head, mapping, scope, reportingPeriod: s.reportingPeriod as ReportingPeriod, ...decision }
    : { ...head, mapping, scope, ...decision };
}

/** A version's rows, as a copy reads them. */
export interface VersionRows {
  subsidiaries: readonly InventoryBoundarySubsidiary[];
  sites: readonly InventoryBoundarySite[];
  policies: readonly PolicyRow[];
  cells: readonly InventoryApplicabilityCell[];
  sources: readonly SourceRow[];
}

/**
 * A version's rows as they are, into the version `boundaryId` (a create's
 * `copyOf`, W8): months and decisions included; each source a new id; names
 * and geography cleared, read live again until the new version freezes (W7).
 */
export function copiedRows(source: VersionRows, boundaryId: string, newId: () => string): VersionRows {
  return {
    subsidiaries: source.subsidiaries.map((s) => ({ ...s, boundaryId, subsidiaryName: null, geographyCode: null })),
    sites: source.sites.map((s) => ({ ...s, boundaryId, locationName: null, geographyCode: null })),
    policies: source.policies.map((p) => ({ ...p, boundaryId })),
    cells: source.cells.map((c) => ({ ...c, boundaryId })),
    sources: source.sources.map((s) => ({ ...s, id: newId(), boundaryId })),
  };
}
