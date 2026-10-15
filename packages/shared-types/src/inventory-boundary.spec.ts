import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AUDIT_ACTIONS, AUDIT_ENTITIES, CATEGORIES, CATEGORY_SCOPE_MAP,
  INVENTORY_BOUNDARY_GAP_CODES, INVENTORY_CATEGORIES, INVENTORY_REASON_MAX_LENGTH,
  INVENTORY_SOURCE_NAME_MAX_LENGTH, REPORT_COVERAGE_GAP_CODES,
  type Category, type CreateInventoryBoundaryRequest, type InventoryApplicabilityCellInput,
  type InventoryBoundaryGap, type InventoryBoundaryVersionDTO, type InventoryBoundaryVersionSummary,
  type InventoryCategory, type InventorySourceInput, type InventorySourceMapping,
  type InventorySourceMappingInput, type PutInventoryBoundarySubsidiaryRequest, type ReportCoverageGap,
} from './index';

/**
 * LP3-04's write path — the D12 editor's contract (W1; E1–E9). Type-level
 * cases are checked by `tsc` (this file is in the package's build), the
 * value-level ones by vitest.
 */

const grid = {
  locationId: null, name: 'Purchased electricity',
  mapping: { kind: 'mapped', category: 'Electricity', activityType: null },
  applicability: 'included', evidenceReportingPeriod: 'monthly',
} satisfies InventorySourceInput;
const heat = {
  locationId: null, name: 'Purchased heat', scope: 2, reportingPeriod: 'annual',
  mapping: { kind: 'unsupported', reason: 'No mapped source form yet.' },
  applicability: 'included', evidenceReportingPeriod: null,
} satisfies InventorySourceInput;
const noFleet = {
  locationId: '33333333-3333-3333-3333-333333330001', name: 'Company fleet',
  mapping: { kind: 'mapped', category: 'Mobile Combustion', activityType: 'diesel' },
  applicability: 'excluded', reason: 'No fleet operates at this site.',
} satisfies InventorySourceInput;

const declaration = {
  firstMonth: 1, lastMonth: 12,
  sites: [{ locationId: '33333333-3333-3333-3333-333333330001', firstMonth: 7, lastMonth: 12 }],
  attribution: [
    { category: 'Electricity', level: 'company', reportingPeriod: 'monthly' },
    { category: 'Mobile Combustion', level: 'sites', reportingPeriod: 'annual' },
  ],
  applicability: [
    { locationId: null, category: 'Electricity', applicability: 'included' },
    { locationId: '33333333-3333-3333-3333-333333330001', category: 'Mobile Combustion', applicability: 'excluded', reason: 'No fleet.' },
  ],
  sources: [grid, heat, noFleet],
} satisfies PutInventoryBoundarySubsidiaryRequest;

describe('the inventory categories', () => {
  it('are exactly the Scope 1/2 categories, in CATEGORIES order', () => {
    expect([...INVENTORY_CATEGORIES]).toEqual(CATEGORIES.filter((c) => CATEGORY_SCOPE_MAP[c] !== 3));
    expect(Object.isFrozen(INVENTORY_CATEGORIES)).toBe(true);
  });

  it('are categories', () => {
    expectTypeOf<InventoryCategory>().toMatchTypeOf<Category>();
  });
});

describe('the free-text caps the database holds', () => {
  it('pins them — a change is a deliberate edit here and in a migration', () => {
    expect(INVENTORY_SOURCE_NAME_MAX_LENGTH).toBe(200);
    expect(INVENTORY_REASON_MAX_LENGTH).toBe(500);
  });
});

describe('the record-independent gaps confirm refuses (E3)', () => {
  it('are three coverage gap codes', () => {
    expect([...INVENTORY_BOUNDARY_GAP_CODES]).toEqual(['applicability_undetermined', 'unsupported_source', 'attribution_conflict']);
    for (const code of INVENTORY_BOUNDARY_GAP_CODES) expect(REPORT_COVERAGE_GAP_CODES).toContain(code);
    expect(Object.isFrozen(INVENTORY_BOUNDARY_GAP_CODES)).toBe(true);
  });

  it('are coverage gaps a dataset can carry unchanged, naming no record', () => {
    expectTypeOf<InventoryBoundaryGap>().toMatchTypeOf<ReportCoverageGap>();
    expectTypeOf<InventoryBoundaryGap['recordIds']>().toEqualTypeOf<readonly []>();
  });
});

describe('the audit taxonomy', () => {
  it('names a boundary version and its confirmation', () => {
    expect(AUDIT_ENTITIES).toContain('inventory_boundary');
    expect(AUDIT_ACTIONS).toContain('confirm');
  });
});

describe('the request shapes', () => {
  it('take a year and an optional version to copy', () => {
    expectTypeOf<CreateInventoryBoundaryRequest>().toEqualTypeOf<{ reportingYear: number; copyOf?: string }>();
  });

  it("narrow a source's mapping to the inventory categories, and stay a contract mapping", () => {
    expectTypeOf<InventorySourceMappingInput>().toMatchTypeOf<InventorySourceMapping>();
    // @ts-expect-error — Water is Scope 3: outside the boundary.
    const water: InventorySourceMappingInput = { kind: 'mapped', category: 'Water', activityType: null };
    void water;
  });

  it('send no scope or cadence for a mapped source — both are derived', () => {
    // @ts-expect-error — a mapped source's scope is its category's.
    const scoped: InventorySourceInput = { ...grid, scope: 2 };
    // @ts-expect-error — a mapped source's cadence is its category's policy's.
    const periodic: InventorySourceInput = { ...grid, reportingPeriod: 'monthly' };
    void scoped; void periodic;
  });

  it('give an unsupported source a declared scope, and a cadence exactly when it is included', () => {
    const { scope: _scope, ...unscoped } = heat;
    // @ts-expect-error — no category to derive it from.
    const missing: InventorySourceInput = unscoped;
    const { reportingPeriod: _period, ...uncadenced } = heat;
    // @ts-expect-error — an included unsupported source declares its cadence.
    const included: InventorySourceInput = uncadenced;
    // @ts-expect-error — only an included source has a cadence.
    const excluded: InventorySourceInput = { ...noFleet, mapping: heat.mapping, scope: 2, reportingPeriod: 'annual' };
    const named: InventorySourceInput = { ...noFleet, mapping: heat.mapping, scope: 2 };
    void missing; void included; void excluded; void named;
  });

  it('tie a reason to every decision but inclusion', () => {
    const { reason: _reason, ...unreasoned } = noFleet;
    // @ts-expect-error — an exclusion names its reason.
    const silent: InventorySourceInput = unreasoned;
    // @ts-expect-error — an included source carries no reason.
    const reasoned: InventorySourceInput = { ...grid, reason: 'why' };
    const { evidenceReportingPeriod: _evidence, ...noEvidence } = grid;
    // @ts-expect-error — an included source states its evidence cadence (null: none).
    const bare: InventorySourceInput = noEvidence;
    // @ts-expect-error — an excluded cell names its reason.
    const cell: InventoryApplicabilityCellInput = { locationId: null, category: 'Fuel', applicability: 'excluded' };
    // @ts-expect-error — an included cell carries no reason.
    const includedCell: InventoryApplicabilityCellInput = { locationId: null, category: 'Fuel', applicability: 'included', reason: 'x' };
    void silent; void reasoned; void bare; void cell; void includedCell;
  });

  it('name no source ids in a cell — an included cell holds its entity and category\'s included mapped sources', () => {
    // @ts-expect-error — derived, never sent.
    const named: InventoryApplicabilityCellInput = { locationId: null, category: 'Fuel', applicability: 'included', sourceIds: [] };
    void named;
  });

  it('carry no actor — the API writes it from the verified token (E6)', () => {
    // @ts-expect-error — never a request field.
    const authored: CreateInventoryBoundaryRequest = { reportingYear: 2026, createdBy: 'someone' };
    void authored;
    expectTypeOf(declaration).toMatchTypeOf<PutInventoryBoundarySubsidiaryRequest>();
  });
});

describe('the version a route answers with', () => {
  it('keeps the frozen-at and author outside the fingerprinted snapshot', () => {
    expectTypeOf<InventoryBoundaryVersionDTO>().toMatchTypeOf<InventoryBoundaryVersionSummary>();
    expectTypeOf<InventoryBoundaryVersionDTO['boundary']>().not.toHaveProperty('frozenAt');
    expectTypeOf<InventoryBoundaryVersionDTO['boundary']>().not.toHaveProperty('createdBy');
    expectTypeOf<InventoryBoundaryVersionDTO['view']>().toEqualTypeOf<'organisation' | 'granted_subsidiaries'>();
    expectTypeOf<InventoryBoundaryVersionDTO['boundaryGaps']>().toEqualTypeOf<readonly InventoryBoundaryGap[]>();
  });
});
