import { describe, expect, it } from 'vitest';
import type { UserRole } from '@tonyai/shared-types';
import type { InventoryBoundary } from '@tonyai/db';
import { ResourceNotFoundError } from '../common/api-error';
import { boundaryGaps } from './boundary-gaps';
import { buildBoundarySnapshot, type BoundaryRows } from './boundary-snapshot';
import { versionDTO, versionSummary } from './boundary-version';
import { complete, policy, SUB, SUB_B, without } from '../../test/boundary-fixtures';

/**
 * The routes' view of a version (LP3-04's write path; the contract's `view`):
 * the whole declared inventory for every reader but data_entry, whose view is
 * its granted subsidiaries' part — and none at all, answered as a missing
 * version, when it declares none of them (the boundary's RLS, W3).
 */

const HEADER: InventoryBoundary = {
  id: 'b-1', organisationId: 'org-a', reportingYear: 2026, version: 3, decision: 'unconfirmed',
  decidedBy: null, decidedAt: null, frozenAt: null,
  createdBy: 'user-admin', createdAt: new Date('2026-10-15T09:00:00.000Z'),
};

/** Sub B's Fuel policy missing: one gap of each subsidiary's, so a filter shows. */
function rows(): BoundaryRows {
  const base = complete();
  return {
    ...base,
    header: HEADER,
    policies: without(base.policies, (p) => p.category === 'Fuel' && p.subsidiaryId === SUB_B),
    cells: [...base.cells],
    sources: base.sources.filter((s) => s.id !== 'g-1'),
  };
}

const viewer = (role: UserRole, accessibleSubsidiaryIds: string[] = [SUB, SUB_B]) => ({ role, accessibleSubsidiaryIds });
const loaded = (r: BoundaryRows = rows()) => ({ header: HEADER, rows: r });

describe('versionSummary', () => {
  it("names the version as the list does — its bookkeeping, the API's own author, ISO dates", () => {
    const frozen = { ...HEADER, decision: 'confirmed', decidedBy: 'user-admin', decidedAt: new Date('2026-10-16T08:00:00.000Z'), frozenAt: new Date('2026-10-16T08:00:00.000Z') };
    expect(versionSummary(frozen)).toEqual({
      id: 'b-1', reportingYear: 2026, version: 3, decision: 'confirmed',
      decidedBy: 'user-admin', decidedAt: '2026-10-16T08:00:00.000Z', frozenAt: '2026-10-16T08:00:00.000Z',
      createdBy: 'user-admin', createdAt: '2026-10-15T09:00:00.000Z',
    });
    expect(versionSummary(HEADER)).toMatchObject({ decision: 'unconfirmed', decidedBy: null, decidedAt: null, frozenAt: null });
  });
});

describe('versionDTO', () => {
  it.each(['super_admin', 'consultant', 'executive_viewer'] as const)('%s reads the whole declared inventory and every gap', (role) => {
    const dto = versionDTO(loaded(), viewer(role, [SUB]));
    const snapshot = buildBoundarySnapshot(rows());
    expect(dto.view).toBe('organisation');
    expect(dto.boundary).toEqual(snapshot);
    expect(dto.boundaryGaps).toEqual(boundaryGaps(snapshot));
    expect(dto.boundaryGaps.map((g) => g.entity.subsidiaryId)).toEqual([SUB, SUB_B]);
    expect(dto).toMatchObject(versionSummary(HEADER));
  });

  it("data_entry reads its granted subsidiaries' part only — every collection and gap filtered, nothing of the other named", () => {
    const dto = versionDTO(loaded(), viewer('data_entry', [SUB]));
    expect(dto.view).toBe('granted_subsidiaries');
    expect(dto.boundary.subsidiaryIds).toEqual([SUB]);
    expect(dto.boundary.entities.every((e) => e.subsidiaryId === SUB)).toBe(true);
    expect(dto.boundary.entities).toHaveLength(3);
    expect(dto.boundary.applicability.every((c) => c.subsidiaryId === SUB)).toBe(true);
    expect(dto.boundary.attribution.every((p) => p.subsidiaryId === SUB)).toBe(true);
    expect(dto.boundary.sources.every((s) => s.entity.subsidiaryId === SUB)).toBe(true);
    expect(dto.boundaryGaps.map((g) => [g.code, g.entity.subsidiaryId, g.category])).toEqual([
      ['attribution_conflict', SUB, 'Natural Gas'],
    ]);
    const json = JSON.stringify(dto);
    expect(json).not.toContain(SUB_B);
    expect(json).not.toContain(`Company ${SUB_B}`);
  });

  it('a granted view holds exactly the gaps its subsidiaries would have alone — every rule stays inside one subsidiary', () => {
    const all = rows();
    for (const subsidiaryId of [SUB, SUB_B]) {
      const alone: BoundaryRows = {
        ...all,
        subsidiaries: all.subsidiaries.filter((s) => s.subsidiaryId === subsidiaryId),
        sites: all.sites.filter((s) => s.subsidiaryId === subsidiaryId),
        policies: all.policies.filter((p) => p.subsidiaryId === subsidiaryId),
        cells: all.cells.filter((c) => c.subsidiaryId === subsidiaryId),
        sources: all.sources.filter((s) => s.subsidiaryId === subsidiaryId),
      };
      const dto = versionDTO(loaded(all), viewer('data_entry', [subsidiaryId]));
      expect(dto.boundaryGaps).toEqual(boundaryGaps(buildBoundarySnapshot(alone)));
      expect(dto.boundary).toEqual(buildBoundarySnapshot(alone));
    }
  });

  it('a data_entry user granted none of the declared subsidiaries reads it as missing — byte for byte', () => {
    const missing = new ResourceNotFoundError('boundary_not_found').getResponse();
    for (const granted of [[], ['sub-elsewhere']]) {
      let thrown: unknown;
      try {
        versionDTO(loaded(), viewer('data_entry', granted));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ResourceNotFoundError);
      expect(JSON.stringify((thrown as ResourceNotFoundError).getResponse())).toBe(JSON.stringify(missing));
      expect((thrown as ResourceNotFoundError).getStatus()).toBe(404);
    }
  });

  it('a version declaring no subsidiary is no data_entry user’s — and every other reader’s, empty', () => {
    const empty: BoundaryRows = { ...rows(), subsidiaries: [], sites: [], policies: [], cells: [], sources: [] };
    expect(() => versionDTO(loaded(empty), viewer('data_entry', [SUB]))).toThrow(ResourceNotFoundError);
    const dto = versionDTO(loaded(empty), viewer('consultant'));
    expect(dto.boundary.subsidiaryIds).toEqual([]);
    expect(dto.boundaryGaps).toEqual([]);
    expect(dto.view).toBe('organisation');
  });

  it('keeps a policy row of a subsidiary out of view along with it', () => {
    const r = rows();
    const dto = versionDTO(loaded({ ...r, policies: [...r.policies, policy('Fuel', 'company', 'annual', SUB_B)] }), viewer('data_entry', [SUB_B]));
    expect(dto.boundary.attribution.map((p) => p.subsidiaryId)).toEqual(Array(5).fill(SUB_B));
  });
});
