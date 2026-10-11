import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  REPORT_DATASET_SCHEMA_VERSION, REPORT_COVERAGE_GAP_CODES,
  REPORT_PROVENANCE_ISSUE_CODES, REPORT_ISSUANCE_GAP_CODES,
  type ActivityCalculationSnapshot, type ActivityRecordDTO,
  type InventorySource, type InventoryAttributionPolicy, type InventoryBoundarySnapshot,
  type ReportDataset, type ReportDatasetRecord, type ReportIssuance,
  type ReportScopeDisclosure, type ReportUncoveredScope,
  type ReportCoverageAssessment, type ReportReviewAssessment,
  type ReportProvenanceAssessment, type ReportDatasetFingerprint,
} from './index';

const entity = {
  subsidiaryId: 'subsidiary', subsidiaryName: 'Fixture company', locationId: 'site',
  locationName: 'Fixture site', geographyCode: 'TR', firstMonth: 7, lastMonth: 12,
} as const;
const julySource = {
  id: 'grid', name: 'Purchased electricity', entity, scope: 2,
  mapping: { kind: 'mapped', category: 'Electricity', activityType: null },
  applicability: 'included', reportingPeriod: 'monthly', evidenceReportingPeriod: 'monthly',
  obligations: ([['July', 7], ['August', 8], ['September', 9], ['October', 10], ['November', 11], ['December', 12]] as const)
    .map(([periodValue, month]) => ({ id: `grid-${month}`, reportingPeriod: 'monthly', periodValue,
      firstMonth: month, lastMonth: month, evidencePeriods: [{ reportingPeriod: 'monthly', periodValue }] })),
} satisfies InventorySource;
const noFleet = {
  id: 'fleet', name: 'Company fleet', entity, scope: 1,
  mapping: { kind: 'mapped', category: 'Mobile Combustion', activityType: 'diesel' },
  applicability: 'excluded', reason: 'No fleet operates at this site.',
} satisfies InventorySource;
const heat = {
  id: 'heat', name: 'Purchased heat', entity, scope: 2,
  mapping: { kind: 'unsupported', reason: 'No mapped source form yet.' },
  applicability: 'undetermined', reason: 'Awaiting the pilot source list.',
} satisfies InventorySource;
const fingerprint: ReportDatasetFingerprint = {
  algorithm: 'sha256', canonicalization: 'tonyai-report-dataset-v1', hex: 'a'.repeat(64),
};

// These are structural examples, not an implementation of the finality gate.
describe('the additive report dataset contract', () => {
  it('keeps independent assessments and canonical calculation/record types', () => {
    expectTypeOf<ReportDataset['review']>().toEqualTypeOf<ReportReviewAssessment>();
    expectTypeOf<ReportDataset['coverage']>().toEqualTypeOf<ReportCoverageAssessment>();
    expectTypeOf<ReportDataset['provenance']>().toEqualTypeOf<ReportProvenanceAssessment>();
    expectTypeOf<ReportDatasetRecord['calculation']>().toEqualTypeOf<ActivityCalculationSnapshot>();
    expectTypeOf<ReportDatasetRecord['scope']>().toEqualTypeOf<1 | 2>();
    expectTypeOf<ReportDatasetRecord['status']>().toEqualTypeOf<ActivityRecordDTO['status']>();
    expectTypeOf<ReportDatasetRecord['activityType']>().toEqualTypeOf<string | null>();
    expectTypeOf<InventoryAttributionPolicy>().not.toHaveProperty('activityType');
    expectTypeOf<ReportDatasetRecord['createdByName']>().toEqualTypeOf<undefined>();
    expectTypeOf<ReportDatasetRecord['reviewedByName']>().toEqualTypeOf<undefined>();
    expectTypeOf<ReportDatasetRecord['voidedByName']>().toEqualTypeOf<undefined>();
    expect(REPORT_DATASET_SCHEMA_VERSION).toBe(1);
  });

  it('can describe a mid-year site, named exclusions and an unsupported source without invented amounts', () => {
    const boundary: InventoryBoundarySnapshot = {
      id: 'boundary', version: 1, organisationId: 'org', reportingYear: 2026,
      subsidiaryIds: ['subsidiary'], decision: 'unconfirmed', decidedBy: null, decidedAt: null,
      attribution: [{ subsidiaryId: 'subsidiary', category: 'Electricity', level: 'sites', reportingPeriod: 'monthly' }],
      sources: [julySource, noFleet, heat],
    };
    expect(JSON.parse(JSON.stringify(boundary)).sources[0].entity.firstMonth).toBe(7);
    expect(julySource.obligations.map((o) => o.firstMonth)).toEqual([7, 8, 9, 10, 11, 12]);
    expect(boundary.sources[0]).not.toHaveProperty('tCo2e');
    expect(boundary.sources[1]).not.toHaveProperty('obligations');
    expect(boundary.sources[2].mapping).not.toHaveProperty('category');
  });

  it('represents monthly evidence obligations separately from annual activity', () => {
    const annual: InventorySource = {
      ...julySource, reportingPeriod: 'annual', obligations: [{
        id: 'annual', reportingPeriod: 'annual', periodValue: 'Annual', firstMonth: 7, lastMonth: 12,
        evidencePeriods: ['July', 'August', 'September', 'October', 'November', 'December']
          .map((periodValue) => ({ reportingPeriod: 'monthly', periodValue })),
      }],
    };
    expect(annual.obligations[0].reportingPeriod).toBe('annual');
    expect(annual.obligations[0].evidencePeriods).toHaveLength(6);
    const assessment: ReportCoverageAssessment['obligations'][number] = {
      obligationId: 'annual', state: 'missing', recordIds: ['annual-record'],
      evidencePeriods: annual.obligations[0].evidencePeriods.map((period) => ({ ...period,
        state: period.periodValue === 'July' ? 'satisfied' : 'missing',
        evidenceIds: period.periodValue === 'July' ? ['july-invoice'] : [],
      })),
    };
    expect(assessment.evidencePeriods.find((p) => p.periodValue === 'December'))
      .toEqual({ reportingPeriod: 'monthly', periodValue: 'December', state: 'missing', evidenceIds: [] });
  });

  it('separates observed approval from missing inventory and calculation provenance', () => {
    const review: ReportReviewAssessment = { approvedRecordIds: ['january'], unapprovedRecordIds: [], voidedRecordIds: [] };
    const coverage: ReportCoverageAssessment = {
      obligations: [{ obligationId: 'february', state: 'missing', recordIds: [], evidencePeriods: [{ reportingPeriod: 'monthly', periodValue: 'February', state: 'missing', evidenceIds: [] }] }],
      excludedSourceIds: ['fleet'], gaps: [{ code: 'missing_record', sourceIds: ['grid'], obligationIds: ['february'], recordIds: [] }],
    };
    const provenance: ReportProvenanceAssessment = {
      records: [{ recordId: 'january', standing: 'non_authoritative', issues: ['placeholder_release'] }], releases: [],
    };
    expect(review.approvedRecordIds).toContain('january');
    expect(coverage.gaps[0].code).toBe('missing_record');
    expect(provenance.records[0].standing).toBe('non_authoritative');
  });

  it('can block final for conflicting GWP sets even when each record is authoritative', () => {
    const provenance: ReportProvenanceAssessment = {
      records: ['ar5-record', 'ar6-record'].map((recordId) => ({
        recordId, standing: 'authoritative', issues: ['gwp_set_mismatch'],
      })), releases: [],
    };
    expect(provenance.records.every((record) => record.standing === 'authoritative')).toBe(true);
    expect(provenance.records.flatMap((record) => record.issues)).toEqual(['gwp_set_mismatch', 'gwp_set_mismatch']);
    expect(REPORT_ISSUANCE_GAP_CODES).toContain('gwp_set_mismatch');
  });

  it('distinguishes measured zero, missing figures and the uncovered Scope 3', () => {
    const zero: ReportScopeDisclosure<1> = { scope: 1, coverage: 'covered', tCo2e: 0, countedRecordIds: ['zero-record'] };
    const missing: ReportScopeDisclosure<2> = { scope: 2, coverage: 'partial', tCo2e: null, countedRecordIds: [] };
    const uncovered: ReportUncoveredScope = { scope: 3, coverage: 'not_covered' };
    expect(JSON.parse(JSON.stringify([zero, missing, uncovered]))).toEqual([
      { scope: 1, coverage: 'covered', tCo2e: 0, countedRecordIds: ['zero-record'] },
      { scope: 2, coverage: 'partial', tCo2e: null, countedRecordIds: [] },
      { scope: 3, coverage: 'not_covered' },
    ]);
  });

  it('requires retained PDF metadata and distinguishes dataset identity from language/template issuance', () => {
    const issued: ReportIssuance = {
      issuanceId: 'issue-en', datasetId: 'dataset', datasetFingerprint: fingerprint,
      issuedAt: '2026-10-11T00:00:00.000Z', issuedBy: 'actor', language: 'en',
      template: 'executive_summary', rendererVersion: 'test-only',
      options: { includeMethodologyNotes: true, includeEvidenceSummary: true },
      pdf: { artifactId: 'pdf-en', mimeType: 'application/pdf', sizeBytes: 123, fingerprint },
      status: 'partial', gaps: [{ code: 'filtered_extract', sourceIds: [], obligationIds: [], recordIds: [] }],
    };
    const translated: ReportIssuance = { ...issued, issuanceId: 'issue-tr', language: 'tr',
      pdf: { ...issued.pdf, artifactId: 'pdf-tr', fingerprint: { algorithm: 'sha256', hex: 'b'.repeat(64) } } };
    expect(translated.datasetFingerprint).toEqual(issued.datasetFingerprint);
    expect(translated.issuanceId).not.toBe(issued.issuanceId);
    expect(translated.pdf.fingerprint.hex).not.toBe(issued.pdf.fingerprint.hex);
  });

  it('pins the gap vocabularies consumers must handle', () => {
    expect(REPORT_COVERAGE_GAP_CODES).toEqual(['boundary_unconfirmed', 'applicability_undetermined', 'unsupported_source',
      'missing_record', 'missing_evidence', 'attribution_conflict', 'overlapping_periods', 'unmapped_record']);
    expect(REPORT_PROVENANCE_ISSUE_CODES).toEqual(['uncalculated', 'legacy_snapshot', 'placeholder_release',
      'fixture_release', 'withdrawn_release', 'partial_gas_coverage', 'declared_year_fallback', 'gwp_set_mismatch']);
    expect(REPORT_ISSUANCE_GAP_CODES).toEqual(['filtered_extract', 'coverage_gap', 'unapproved_record',
      'unlocked_period', 'non_authoritative_calculation', 'gwp_set_mismatch']);
  });
});

/** tsc must reject misleading wire shapes, including a value introduced by a spread. */
function invalidContractShapes(issuance: ReportIssuance, record: ReportDatasetRecord) {
  // @ts-expect-error An uncovered scope cannot be a measured zero.
  const scope: ReportUncoveredScope = { scope: 3, coverage: 'not_covered', tCo2e: 0 };
  const measuredExclusion = { ...noFleet, tCo2e: 0 };
  // @ts-expect-error An exclusion never carries a measured amount.
  const exclusion: InventorySource = measuredExclusion;
  // @ts-expect-error An exclusion needs an explicit reason.
  const reasonless: InventorySource = { id: 'source', name: 'Fleet', entity, scope: 1, mapping: noFleet.mapping, applicability: 'excluded' };
  // @ts-expect-error Final cannot carry unresolved gaps.
  const final: ReportIssuance = { ...issuance, status: 'final', gaps: [{ code: 'coverage_gap', sourceIds: [], obligationIds: [], recordIds: [] }] };
  // @ts-expect-error Partial cannot suppress its gap list.
  const partial: ReportIssuance = { ...issuance, status: 'partial', gaps: [] };
  const { pdf: _pdf, ...withoutPdf } = issuance;
  // @ts-expect-error A successful issuance must retain its PDF metadata.
  const noPdf: ReportIssuance = withoutPdf;
  // @ts-expect-error Scope 3 records do not become Scope 1/2 provenance gaps.
  const water: ReportDatasetRecord = { ...record, scope: 3 };
  // @ts-expect-error Retained record snapshots exclude joined actor names, even through spreads.
  const personalName: ReportDatasetRecord = { ...record, createdByName: 'A person' };
  void [scope, exclusion, reasonless, final, partial, noPdf, personalName, water];
}
void invalidContractShapes;
