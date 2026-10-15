import type { BoundaryCellRow, BoundaryPolicyRow, BoundaryRows, BoundarySiteRow, BoundarySourceRow } from '../src/inventory-boundary/boundary-snapshot';

/**
 * An inventory boundary version's rows for DB-free specs (LP3-04): a complete
 * declaration — no boundary gap — that each case breaks in one place.
 */

export const SUB = 'sub-a';
export const SUB_B = 'sub-b';
export const SITE_1 = 'site-1';
export const SITE_2 = 'site-2';

export const site = (locationId: string, subsidiaryId = SUB): BoundarySiteRow => ({
  subsidiaryId, locationId, firstMonth: 1, lastMonth: 12,
  frozenName: null, frozenGeographyCode: null, liveName: `Site ${locationId}`, liveGeographyCode: 'GB',
});

export const policy = (category: string, level: 'company' | 'sites', reportingPeriod = 'annual', subsidiaryId = SUB): BoundaryPolicyRow => ({
  subsidiaryId, category, level, reportingPeriod,
});

export const cell = (
  locationId: string | null, category: string, applicability = 'included', subsidiaryId = SUB,
): BoundaryCellRow => ({
  subsidiaryId, locationId, category, applicability, reason: applicability === 'included' ? null : 'Not on site',
});

export function source(over: Partial<BoundarySourceRow> & { id: string }): BoundarySourceRow {
  return {
    subsidiaryId: SUB, locationId: null, name: `Source ${over.id}`, scope: 1, mapping: 'mapped',
    category: 'Natural Gas', activityType: null, unsupportedReason: null, applicability: 'included', reason: null,
    reportingPeriod: 'quarterly', evidenceReportingPeriod: null,
    ...over,
  };
}

/** Sub A: electricity metered per site, gas at the company, three categories
 * excluded — a named exclusion of each kind beside them. Sub B: every
 * category excluded at the company. No gap. */
export function complete(): BoundaryRows {
  return {
    header: {
      id: 'b-1', organisationId: 'org-a', reportingYear: 2026, version: 1, decision: 'unconfirmed',
      decidedBy: null, decidedAt: null, frozenAt: null,
    },
    subsidiaries: [SUB, SUB_B].map((subsidiaryId) => ({
      subsidiaryId, firstMonth: 1, lastMonth: 12,
      frozenName: null, frozenGeographyCode: null, liveName: `Company ${subsidiaryId}`, liveGeographyCode: 'GB',
    })),
    sites: [site(SITE_1), site(SITE_2)],
    policies: [
      policy('Electricity', 'sites', 'monthly'),
      policy('Natural Gas', 'company', 'quarterly'),
      policy('Fuel', 'company'),
      policy('Mobile Combustion', 'company'),
      policy('Refrigerants', 'company'),
      ...['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'].map((c) => policy(c, 'company', 'annual', SUB_B)),
    ],
    cells: [
      cell(SITE_1, 'Electricity'),
      cell(SITE_2, 'Electricity'),
      cell(null, 'Natural Gas'),
      cell(null, 'Fuel', 'excluded'),
      cell(null, 'Mobile Combustion', 'excluded'),
      cell(null, 'Refrigerants', 'excluded'),
      ...['Electricity', 'Natural Gas', 'Fuel', 'Mobile Combustion', 'Refrigerants'].map((c) => cell(null, c, 'excluded', SUB_B)),
    ],
    sources: [
      source({ id: 'e-1', locationId: SITE_1, category: 'Electricity', scope: 2, reportingPeriod: 'monthly' }),
      source({ id: 'e-2', locationId: SITE_2, category: 'Electricity', scope: 2, reportingPeriod: 'monthly' }),
      source({ id: 'g-1' }),
      // A named exclusion beside its included meter (PR B's (4)), and an
      // unsupported source excluded with its reason: neither is a gap.
      source({ id: 'g-2', applicability: 'excluded', reason: 'Landlord-billed', reportingPeriod: null }),
      source({
        id: 'u-1', mapping: 'unsupported', category: null, unsupportedReason: 'District heat',
        applicability: 'excluded', reason: 'Below threshold', reportingPeriod: null,
      }),
    ],
  };
}

export const without = <T>(list: readonly T[], drop: (row: T) => boolean): T[] => list.filter((row) => !drop(row));
