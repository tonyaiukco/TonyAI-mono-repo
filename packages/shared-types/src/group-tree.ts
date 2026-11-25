/**
 * The group tree (inc26-group-tree, INC-2.6 Rev.3 §2, §3, §5): node types,
 * control, the consolidation approach, facility types, and the three rules
 * the API, the database triggers (TA018–TA022) and the web share — where a
 * node may sit, whether it holds records, and its roll-up.
 *
 * No runtime import from `./index`: `index.ts` re-exports this module.
 */

/** Company node types (§2). Only the root is a `holding`. A facility is not a
 *  company node: it stays a `locations` row, the leaf under one company. */
export const NODE_TYPES = ['holding', 'sub_holding', 'sector_group', 'company', 'child_company'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** A company's standing (§2, `masterkey tikler`). */
export const CONTROL_KINDS = ['controlled', 'associate'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** The approaches an organisation can hold (§3). */
export const CONSOLIDATION_APPROACHES = ['operational_control', 'financial_control'] as const;
export type ConsolidationApproach = (typeof CONSOLIDATION_APPROACHES)[number];

/** Announced as "coming soon", shown disabled, refused by the API (§3). */
export const UPCOMING_CONSOLIDATION_APPROACHES = ['equity_share'] as const;
export type UpcomingConsolidationApproach = (typeof UPCOMING_CONSOLIDATION_APPROACHES)[number];

/** A facility's optional type (§2 `location`). */
export const LOCATION_TYPES = [
  'warehouse',
  'office',
  'factory',
  'plant',
  'refinery',
  'retail_shop',
  'mall',
  'building',
  'apartment',
  'rms_station',
] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

/**
 * A NACE Rev. 2 code as written: a section letter (`C`), a division (`10`),
 * a group (`10.1`) or a class (`10.11`), the division optionally after its
 * section letter (`C10.11`). Optional on a company and checked for shape
 * only: no rule or figure reads it.
 */
export const NACE_CODE_PATTERN = /^(?:[A-U]|[A-U]?\d{2}(?:\.\d{1,2})?)$/;
export const NACE_CODE_MAX_LENGTH = 8;

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && (NODE_TYPES as readonly string[]).includes(value);
}
export function isControlKind(value: unknown): value is ControlKind {
  return typeof value === 'string' && (CONTROL_KINDS as readonly string[]).includes(value);
}
export function isConsolidationApproach(value: unknown): value is ConsolidationApproach {
  return typeof value === 'string' && (CONSOLIDATION_APPROACHES as readonly string[]).includes(value);
}
export function isLocationType(value: unknown): value is LocationType {
  return typeof value === 'string' && (LOCATION_TYPES as readonly string[]).includes(value);
}

/**
 * The placement matrix (design RD7, drawn from §2's two example chains). The
 * database's TA018 holds the same table; `group-tree.spec.ts` pins it cell by
 * cell. A `holding` is never a child: it is the root.
 */
const CHILD_TYPES: Readonly<Record<NodeType, readonly NodeType[]>> = Object.freeze({
  holding: Object.freeze(['sub_holding', 'sector_group', 'company'] as NodeType[]),
  sub_holding: Object.freeze(['sub_holding', 'sector_group', 'company'] as NodeType[]),
  sector_group: Object.freeze(['company'] as NodeType[]),
  company: Object.freeze(['child_company'] as NodeType[]),
  child_company: Object.freeze(['child_company'] as NodeType[]),
});

/** The types a node of `parentType` admits beneath it, by type alone. */
export function allowedChildTypes(parentType: NodeType): readonly NodeType[] {
  return CHILD_TYPES[parentType] ?? [];
}

/** Whether `parent` admits a child of `childType`: by type, and never under an
 *  associate (an associate has no child node, §2.1). */
export function admitsChild(parent: { nodeType: NodeType; control: ControlKind }, childType: NodeType): boolean {
  return parent.control !== 'associate' && allowedChildTypes(parent.nodeType).includes(childType);
}

/** The types that may be ticked associate; every other type is always `controlled`. */
export const CONTROLLABLE_NODE_TYPES = Object.freeze(['company', 'child_company'] as const);
export function mayBeAssociate(nodeType: NodeType): boolean {
  return (CONTROLLABLE_NODE_TYPES as readonly string[]).includes(nodeType);
}

/**
 * Whether a node can hold activity records, facilities' records included,
 * user grants and boundary declarations: every type but `sector_group` (a
 * label, §2.1), and never an associate (outside Scope 1 and 2, §3). The one
 * definition the API's gates, the read models' reporting set and the web's
 * pickers share; TA019–TA021 hold it in the database.
 */
export function holdsRecords(node: { nodeType: NodeType; control: ControlKind }): boolean {
  return node.nodeType !== 'sector_group' && node.control !== 'associate';
}

/** A company's GHG basis, derived and never chosen (§3): a controlled node is
 *  counted at 100 % under the organisation's approach; an associate is equity,
 *  outside Scope 1 and 2, at 0 %. The share percent enters neither. */
export interface GhgBasis {
  basis: ConsolidationApproach | 'equity';
  percent: 100 | 0;
  inScope12: boolean;
}
export function ghgBasis(control: ControlKind, approach: ConsolidationApproach): GhgBasis {
  return control === 'associate'
    ? { basis: 'equity', percent: 0, inScope12: false }
    : { basis: approach, percent: 100, inScope12: true };
}

/** Scope 1 and 2 in tCO₂e, and their sum (the main total's definition). */
export interface ScopeFigures {
  scope1: number;
  scope2: number;
  total: number;
}

/** `GET /organisation`: the caller's own organisation (design D8). */
export interface OrganisationDTO {
  id: string;
  legalName: string;
  tradingName: string | null;
  consolidationApproach: ConsolidationApproach;
}

/** `PATCH /organisation/consolidation-approach`. `equity_share` is refused as invalid. */
export interface UpdateConsolidationApproachInput {
  consolidationApproach: ConsolidationApproach;
}

/** One node of `GET /emissions/roll-up?reportingYear=` (design D9). */
export interface RollUpRow {
  subsidiaryId: string;
  /** Only a parent the caller may read; `null` otherwise (D4). */
  parentId: string | null;
  nodeType: NodeType;
  control: ControlKind;
  own: ScopeFigures | null;
  rollUp: ScopeFigures | null;
}

export interface RollUpResponse {
  reportingYear: number;
  rows: RollUpRow[];
}

/** One associate of `GET /subsidiaries/boundary-exclusions` (design D8, RD11). */
export interface BoundaryExclusionDTO {
  subsidiaryId: string;
  legalName: string;
  sharePercent: number | null;
}

export interface RollUpNode {
  id: string;
  parentId: string | null;
  nodeType: NodeType;
  control: ControlKind;
}

export interface RollUpResult {
  /** The node's own counted records; null for a node that holds none by rule
   *  (a sector group, an associate). */
  own: ScopeFigures | null;
  /** Own plus the children's roll-ups; null for an associate, which adds
   *  nothing anywhere. */
  rollUp: ScopeFigures | null;
}

const ZERO: ScopeFigures = Object.freeze({ scope1: 0, scope2: 0, total: 0 });

function add(a: ScopeFigures, b: ScopeFigures): ScopeFigures {
  return { scope1: a.scope1 + b.scope1, scope2: a.scope2 + b.scope2, total: a.total + b.total };
}

/**
 * Each node's own figure and roll-up (§5.2): roll-up = own + the children's
 * roll-ups. A pure fold over the nodes GIVEN — the caller passes only what its
 * reader may read, so a node whose parent is absent is the top of its own
 * fragment and nothing is said of what lies outside (RD13). A node that would
 * hold no records contributes no own figure even if `ownTotals` names one;
 * an associate contributes nothing at all. A malformed input (a cycle) still
 * terminates: a node already on the current path adds nothing a second time.
 */
export function rollUp(
  nodes: readonly RollUpNode[],
  ownTotals: ReadonlyMap<string, ScopeFigures> | Readonly<Record<string, ScopeFigures>>,
): Map<string, RollUpResult> {
  const ownOf = (id: string): ScopeFigures | undefined =>
    ownTotals instanceof Map ? ownTotals.get(id) : (ownTotals as Readonly<Record<string, ScopeFigures>>)[id];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, RollUpNode[]>();
  for (const n of nodes) {
    if (n.parentId === null || n.parentId === n.id || !byId.has(n.parentId)) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  const result = new Map<string, RollUpResult>();
  const onPath = new Set<string>();

  const visit = (node: RollUpNode): ScopeFigures | null => {
    const done = result.get(node.id);
    if (done) return done.rollUp;
    if (onPath.has(node.id)) return null; // a cycle in the input: add nothing twice
    onPath.add(node.id);
    let rolled: ScopeFigures | null;
    let own: ScopeFigures | null;
    if (node.control === 'associate') {
      own = null;
      rolled = null;
      for (const child of children.get(node.id) ?? []) visit(child); // still answer every node
    } else {
      own = node.nodeType === 'sector_group' ? null : { ...(ownOf(node.id) ?? ZERO) };
      rolled = own ? { ...own } : { ...ZERO };
      for (const child of children.get(node.id) ?? []) {
        const c = visit(child);
        if (c) rolled = add(rolled, c);
      }
    }
    onPath.delete(node.id);
    result.set(node.id, { own, rollUp: rolled });
    return rolled;
  };

  for (const n of nodes) visit(n);
  return result;
}
