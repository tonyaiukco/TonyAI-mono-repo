import {
  CATEGORIES,
  INVENTORY_BOUNDARY_GAP_CODES,
  INVENTORY_CATEGORIES,
  type Category,
  type InventoryApplicabilityDecision,
  type InventoryAttributionPolicy,
  type InventoryBoundaryGap,
  type InventoryBoundaryGapCode,
  type InventoryBoundarySnapshot,
} from '@tonyai/shared-types';

/**
 * The gaps of a boundary itself, before any record is read (LP3-04's write
 * path; `InventoryBoundaryGap`, Decisions 2026-10-15 (fifth) E3) — the ones
 * `confirm` refuses and every final report is blocked by. Pure: a version's
 * routes report them, `confirm` refuses on them, and LP3-04 PR C's dataset
 * starts its coverage gaps from them (adding `boundary_unconfirmed` and the
 * record-based ones, and naming the records an attribution conflict leaves
 * unmapped).
 *
 * One rule per line of the contract, each at the entity it names; a source's
 * gap names that source alone. Every rule stays inside one subsidiary, so a
 * view of some subsidiaries holds exactly their gaps (a data_entry user's,
 * W3). A "selected" entity is the company entity under a `company` policy and
 * each declared site under a `sites` one.
 */
export function boundaryGaps(boundary: InventoryBoundarySnapshot): InventoryBoundaryGap[] {
  const gaps: InventoryBoundaryGap[] = [];
  const add = (
    code: InventoryBoundaryGapCode,
    entity: { subsidiaryId: string; locationId: string | null },
    category: Category | undefined,
    sourceIds: string[] = [],
  ) => {
    gaps.push({
      code,
      entity: { subsidiaryId: entity.subsidiaryId, locationId: entity.locationId },
      ...(category === undefined ? {} : { category }),
      sourceIds,
      obligationIds: [],
      recordIds: [],
    });
  };

  const policies = new Map<string, InventoryAttributionPolicy>();
  for (const p of boundary.attribution) policies.set(`${p.subsidiaryId}/${p.category}`, p);
  const sitesOf = new Map<string, string[]>();
  for (const e of boundary.entities) {
    if (e.locationId !== null) sitesOf.set(e.subsidiaryId, [...(sitesOf.get(e.subsidiaryId) ?? []), e.locationId]);
  }
  const cellKey = (subsidiaryId: string, locationId: string | null, category: string) =>
    `${subsidiaryId}/${locationId ?? ''}/${category}`;
  const cells = new Map<string, InventoryApplicabilityDecision>();
  for (const c of boundary.applicability) cells.set(cellKey(c.subsidiaryId, c.locationId, c.category), c);
  const selected = (subsidiaryId: string, locationId: string | null, category: string): boolean => {
    const policy = policies.get(`${subsidiaryId}/${category}`);
    if (policy === undefined) return false;
    return policy.level === 'company'
      ? locationId === null
      : locationId !== null && (sitesOf.get(subsidiaryId) ?? []).includes(locationId);
  };

  // applicability_undetermined: a missing policy, a `sites` policy with no
  // site (both at the company entity), and a selected entity's missing or
  // undetermined cell.
  for (const subsidiaryId of boundary.subsidiaryIds) {
    const company = { subsidiaryId, locationId: null };
    for (const category of INVENTORY_CATEGORIES) {
      const policy = policies.get(`${subsidiaryId}/${category}`);
      if (policy === undefined) {
        add('applicability_undetermined', company, category);
        continue;
      }
      const entities = policy.level === 'company' ? [null] : (sitesOf.get(subsidiaryId) ?? []);
      if (entities.length === 0) add('applicability_undetermined', company, category);
      for (const locationId of entities) {
        const decision = cells.get(cellKey(subsidiaryId, locationId, category))?.applicability;
        if (decision === undefined || decision === 'undetermined') {
          add('applicability_undetermined', { subsidiaryId, locationId }, category);
        }
      }
    }
  }

  for (const source of boundary.sources) {
    const { entity } = source;
    if (source.mapping.kind === 'unsupported') {
      // An excluded one, with its reason, is a named exclusion — no gap.
      if (source.applicability !== 'excluded') add('unsupported_source', entity, undefined, [source.id]);
      continue;
    }
    const { category } = source.mapping;
    if (source.applicability === 'undetermined') {
      add('applicability_undetermined', entity, category, [source.id]);
    } else if (source.applicability === 'included') {
      // Held only by an included cell at a selected entity of its category.
      const held = selected(entity.subsidiaryId, entity.locationId, category)
        && cells.get(cellKey(entity.subsidiaryId, entity.locationId, category))?.applicability === 'included';
      if (!held) add('attribution_conflict', entity, category, [source.id]);
    }
  }

  // An included cell holds every included mapped source at its entity and
  // category (the snapshot derives them): with none it would read as a
  // covered zero. At any entity — an unselected one's included cell is no
  // less empty (Decision 2A, the contract's literal reading).
  for (const c of boundary.applicability) {
    if (c.applicability === 'included' && c.sourceIds.length === 0) {
      add('attribution_conflict', { subsidiaryId: c.subsidiaryId, locationId: c.locationId }, c.category);
    }
  }

  return gaps.sort(compareGaps);
}

const categoryRank = (c: Category | undefined) => (c === undefined ? CATEGORIES.length : CATEGORIES.indexOf(c));
const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/** Subsidiary, entity (the company entity first), category (none last), code, source. */
function compareGaps(a: InventoryBoundaryGap, b: InventoryBoundaryGap): number {
  return compare(a.entity.subsidiaryId, b.entity.subsidiaryId)
    || compare(a.entity.locationId ?? '', b.entity.locationId ?? '')
    || compare(categoryRank(a.category), categoryRank(b.category))
    || compare(INVENTORY_BOUNDARY_GAP_CODES.indexOf(a.code), INVENTORY_BOUNDARY_GAP_CODES.indexOf(b.code))
    || compare(a.sourceIds[0] ?? '', b.sourceIds[0] ?? '');
}
