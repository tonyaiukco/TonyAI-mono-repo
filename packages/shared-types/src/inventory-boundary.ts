import type { ReportingPeriod } from './index';
import type {
  InventoryAttributionPolicy, InventoryBoundarySnapshot, InventoryMonth, ReportCoverageGap,
} from './report-dataset';

/**
 * LP3-04's write path: the D12 editor's contract (W1, W13; Decisions
 * 2026-10-15 (fifth) E1–E9). Dormant — no route serves these yet; the
 * service-and-routes PR does. Type-only imports: `index.ts` re-exports this
 * module, so a runtime import from it would be circular.
 *
 * Routes, under /api/v1 (E1):
 *   GET    /inventory-boundaries?reportingYear=   → InventoryBoundaryVersionSummary[], newest version first
 *   GET    /inventory-boundaries/:id              → InventoryBoundaryVersionDTO
 *   POST   /inventory-boundaries                  CreateInventoryBoundaryRequest → InventoryBoundaryVersionDTO
 *   PUT    /inventory-boundaries/:id/subsidiaries/:subsidiaryId
 *                                                 PutInventoryBoundarySubsidiaryRequest → InventoryBoundaryVersionDTO
 *   DELETE /inventory-boundaries/:id/subsidiaries/:subsidiaryId → InventoryBoundaryVersionDTO
 *   POST   /inventory-boundaries/:id/confirm      (no body) → InventoryBoundaryVersionDTO
 *   DELETE /inventory-boundaries/:id              (an open version only) → 204
 *
 * Roles (W4, E2): super_admin creates, copies, edits, deletes an open version
 * and confirms; consultant and executive_viewer read; data_entry reads its
 * granted subsidiaries' part of a version (W3, `view`). Every other write
 * answers `forbidden`.
 *
 * Versions (W8, E4): a create takes the year's highest version + 1 and is
 * refused `boundary_draft_open` while that year's newest version is open, so
 * a year has one open version at most and it is the newest. Edits serialise on
 * the version's header row, in READ COMMITTED (TA014); there is no revision
 * precondition (E5) — the last writer of a subsidiary's declaration wins, and
 * the audit row of each write holds what it replaced.
 *
 * Confirm (W4, E3): super_admin only. It freezes and confirms the version in
 * one step (the stored decision says both). Refused `boundary_frozen` when
 * the version is already confirmed; `boundary_confirm_requires_copy` when it
 * froze unconfirmed, captured into a dataset (PR B's (4a)) — copy it, then
 * confirm the copy; `boundary_incomplete` when it declares no subsidiary or
 * holds any `boundaryGaps`, every one of which blocks a final report.
 *
 * Refusals (E7, E8): the service checks every rule the database's guard
 * enforces (TA014) before it writes, so a TA014 that still reaches it is a
 * defect — answered `internal_error` and logged, never shown as "frozen".
 * `boundary_not_found` is a version of another organisation or none; a
 * subsidiary or site of another organisation is `subsidiary_not_found` or
 * `location_not_found`; a body the DTOs refuse is `validation_failed`; a lost
 * race (two creates, a site deleted mid-write) is `conflict`.
 *
 * Audit (E8 defaults): entity `inventory_boundary`, `entityId` the version.
 * A create is `create` (its diff names `copyOf` when copied), a subsidiary's
 * declaration replaced or removed is `update` (its diff holds it before and
 * after), a deleted open version `delete`, a confirmation `confirm` — each in
 * the transaction of the write it records.
 */

/** The categories a boundary declares: the pilot's Scope 1/2 inventory
 * (`CATEGORY_SCOPE_MAP` 1 or 2), in `CATEGORIES` order. Scope 3 is declared
 * not covered, never as a boundary row. */
export const INVENTORY_CATEGORIES = Object.freeze([
  'Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants',
] as const);
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

/** The database's caps (PR B's CHECKs), in characters; free text also
 * follows its rule — nonblank, NFC, no edge space, no control, format or
 * bidi character. */
export const INVENTORY_SOURCE_NAME_MAX_LENGTH = 200;
export const INVENTORY_REASON_MAX_LENGTH = 500;

/** GET /inventory-boundaries — one year's versions. */
export interface ListInventoryBoundariesParams {
  reportingYear: number;
}

/** POST /inventory-boundaries. The organisation, the version number and the
 * author are the API's: from the caller's verified token and the year's
 * versions, never from a body (E6). */
export interface CreateInventoryBoundaryRequest {
  reportingYear: number;
  /** A version of the caller's organisation, any year and open or frozen —
   * a new year starts from the last one's. Its declarations are copied into
   * the new open version; names and geography are read live again until it
   * freezes (W7). Omitted: an empty version. */
  copyOf?: string;
}

/** A site of the subsidiary: one of its own locations, never the nil uuid
 * (the company entity's key). Months are the months it is included in the
 * inventory, within its subsidiary's (Decisions 2026-10-15 (third) (5)). */
export interface InventoryBoundarySiteInput {
  locationId: string;
  firstMonth: InventoryMonth;
  lastMonth: InventoryMonth;
}

/** D11, one per category at most; the subsidiary is the route's. */
export type InventoryAttributionPolicyInput =
  Omit<InventoryAttributionPolicy, 'subsidiaryId' | 'category'> & { category: InventoryCategory };

/** D12, one per entity and category at most. `locationId` null is the
 * company entity; any other is a site this declaration holds. An included
 * cell names no sources: it holds every included mapped source of its entity
 * and category. */
export type InventoryApplicabilityCellInput = {
  locationId: string | null;
  category: InventoryCategory;
} & (
  | { applicability: 'included'; reason?: never }
  | { applicability: 'excluded' | 'undetermined'; reason: string }
);

/** `InventorySourceMapping`, narrowed to the inventory categories. A typed
 * category's source names one of its activity types (`recordActivityTypesFor`;
 * contract follow-up (21)), an untyped one's null. */
export type InventorySourceMappingInput =
  | { kind: 'mapped'; category: InventoryCategory; activityType: string | null; reason?: never }
  | { kind: 'unsupported'; reason: string; category?: never; activityType?: never };

type InventorySourceDecisionInput =
  /** `evidenceReportingPeriod` declares the evidence cadence; null: none (W5). */
  | { applicability: 'included'; evidenceReportingPeriod: ReportingPeriod | null; reason?: never }
  | { applicability: 'excluded' | 'undetermined'; reason: string; evidenceReportingPeriod?: never };

/**
 * A named source of the subsidiary (D05). `locationId` null is the company
 * entity; any other is a site this declaration holds. Its id is the server's,
 * new on every PUT (an open version's source ids are not stable; a frozen
 * one's never change).
 *
 * A mapped source sends no scope and no cadence: its scope is its category's
 * (`CATEGORY_SCOPE_MAP`), and an included one's cadence is its category's
 * policy's, which it needs first (Decisions 2026-10-15 (third) (7)). Two
 * included mapped sources never share an entity, category and activity type;
 * a named exclusion may sit beside its included meter (PR B's (4)). An
 * unsupported source declares its scope, and its cadence exactly when it is
 * included.
 */
export type InventorySourceInput = {
  locationId: string | null;
  name: string;
} & (
  | ({ mapping: Extract<InventorySourceMappingInput, { kind: 'mapped' }>; scope?: never; reportingPeriod?: never }
      & InventorySourceDecisionInput)
  | ({ mapping: Extract<InventorySourceMappingInput, { kind: 'unsupported' }>; scope: 1 | 2; reportingPeriod: ReportingPeriod }
      & Extract<InventorySourceDecisionInput, { applicability: 'included' }>)
  | ({ mapping: Extract<InventorySourceMappingInput, { kind: 'unsupported' }>; scope: 1 | 2; reportingPeriod?: never }
      & Extract<InventorySourceDecisionInput, { applicability: 'excluded' | 'undetermined' }>)
);

/**
 * PUT /inventory-boundaries/:id/subsidiaries/:subsidiaryId — the whole
 * declaration of one subsidiary in an open version (E1), replacing the one
 * stored; DELETE removes it. Every rule the database holds sits inside one
 * subsidiary, so one body is one validation unit.
 *
 * Refused (`validation_failed`) when it breaks a rule the database would:
 * a month outside 1–12, an interval ending before it starts, a site outside
 * the subsidiary's months, an entry declared twice, a cell or source at a site
 * this body does not declare, a free text outside its rule, a source mapping
 * outside `InventorySourceInput`, an included mapped source without its
 * category's policy, two included mapped sources on one key. Stored, and
 * reported in `boundaryGaps` (blocking a confirmation, not the write), when it
 * is incomplete or inconsistent across rows: a missing policy or cell, an
 * `undetermined` decision, an unsupported source not excluded, a source under
 * a cell that does not include it.
 */
export interface PutInventoryBoundarySubsidiaryRequest {
  /** The months the subsidiary is included in the inventory. */
  firstMonth: InventoryMonth;
  lastMonth: InventoryMonth;
  sites: readonly InventoryBoundarySiteInput[];
  attribution: readonly InventoryAttributionPolicyInput[];
  applicability: readonly InventoryApplicabilityCellInput[];
  sources: readonly InventorySourceInput[];
}

/** The coverage gaps a boundary has before any record is read — the ones
 * `confirm` refuses (E3). `boundary_unconfirmed` is the decision itself, and
 * the others need records. */
export const INVENTORY_BOUNDARY_GAP_CODES = Object.freeze([
  'applicability_undetermined', 'unsupported_source', 'attribution_conflict',
] as const);
export type InventoryBoundaryGapCode = (typeof INVENTORY_BOUNDARY_GAP_CODES)[number];

/** A dataset carries it unchanged (PR C): a coverage gap naming no record. */
export type InventoryBoundaryGap = Omit<ReportCoverageGap, 'code' | 'recordIds'> & {
  code: InventoryBoundaryGapCode;
  recordIds: readonly [];
};

/** A version as the list names it. `decidedBy` and `createdBy` are profile
 * ids the API writes from the caller's verified token — never a request
 * field, no foreign key (E6, PR B's (5)). */
export interface InventoryBoundaryVersionSummary {
  id: string;
  reportingYear: number;
  version: number;
  decision: 'unconfirmed' | 'confirmed';
  decidedBy: string | null;
  decidedAt: string | null;
  /** Set when the version is confirmed or captured into a dataset; a frozen
   * version takes no write (W10) — new facts make a new version. */
  frozenAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** A version as its routes answer. `boundary` is the snapshot a dataset
 * embeds (names and geography read live until the version freezes, W7);
 * this version's bookkeeping stays outside it, so its fingerprint does not
 * move. */
export interface InventoryBoundaryVersionDTO extends InventoryBoundaryVersionSummary {
  boundary: InventoryBoundarySnapshot;
  boundaryGaps: readonly InventoryBoundaryGap[];
  /** `organisation`: the whole declared inventory. `granted_subsidiaries`: a
   * data_entry user's view (W3) — only its granted subsidiaries' entities,
   * cells, policies, sources and gaps, so `boundary.subsidiaryIds` is not the
   * declared inventory. Such a view is never captured or issued. */
  view: 'organisation' | 'granted_subsidiaries';
}
