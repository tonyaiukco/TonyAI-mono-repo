import type {
  ActivityRecordDTO, Category, EvidenceDTO, FactorReleaseDTO, FactorReleaseSnapshot,
  Locale, PeriodLockDTO, ReportingContext, ReportingPeriod, ReportTemplate,
} from './index';

/** LP3-04: additive, dormant contracts. No existing route returns these yet.
 * All dates are UTC ISO strings; months are calendar months of reportingYear.
 * Producers validate runtime inputs, referential integrity and the invariants
 * below. TypeScript shapes alone do not certify a complete inventory. */
export const REPORT_DATASET_SCHEMA_VERSION = 1 as const;
export type InventoryMonth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** D11 is per subsidiary/year/category, across ALL its activity types. */
export interface InventoryAttributionPolicy {
  subsidiaryId: string;
  category: Category;
  level: 'company' | 'sites';
  reportingPeriod: ReportingPeriod;
}

export interface InventoryEntitySnapshot {
  subsidiaryId: string;
  subsidiaryName: string;
  locationId: string | null;
  locationName: string | null;
  geographyCode: string;
  /** Inclusive actual operating months, never inferred from row createdAt. */
  firstMonth: InventoryMonth;
  lastMonth: InventoryMonth;
}

/** An unsupported named source must still fit the boundary (D05). A missing
 * mapping is not an exclusion, a made-up category or a measured zero. */
export type InventorySourceMapping =
  | { kind: 'mapped'; category: Category; activityType: string | null }
  | { kind: 'unsupported'; reason: string; category?: never; activityType?: never };

export interface InventoryObligation {
  id: string;
  reportingPeriod: ReportingPeriod;
  /** Canonical PERIOD_VALUES entry for reportingPeriod. */
  periodValue: string;
  /** Inclusive months inside this source's operating interval. */
  firstMonth: InventoryMonth;
  lastMonth: InventoryMonth;
  /** Independent of activity granularity. An annual record does not satisfy
   * twelve monthly invoices by itself. Each required evidence period is named. */
  evidencePeriods: ReadonlyArray<{
    reportingPeriod: ReportingPeriod;
    periodValue: string;
  }>;
}

export type InventorySource = {
  id: string;
  /** Required even for excluded/unsupported sources. */
  name: string;
  entity: InventoryEntitySnapshot;
  scope: 1 | 2;
  mapping: InventorySourceMapping;
  /** Boundary declarations never hold measured emissions. */
  tCo2e?: never;
} & (
  | { applicability: 'included'; reportingPeriod: ReportingPeriod; evidenceReportingPeriod: ReportingPeriod | null; obligations: readonly InventoryObligation[]; reason?: never }
  | { applicability: 'excluded' | 'undetermined'; reason: string; obligations?: never }
);

/** A version is immutable once used by an issuance. New facts create a new
 * version. super_admin owns decisions; reasons must be nonblank. Included
 * sources have obligations that exhaust their operating months exactly once
 * at the source reportingPeriod, matching the category attribution policy
 * wherever mapped (unsupported sources still declare a cadence), with canonical period labels
 * and intervals clipped to the source's active months (no gaps or overlaps).
 * evidenceReportingPeriod independently declares the evidence cadence; null
 * explicitly means none. Each obligation's evidencePeriods exhaust its active
 * months at that cadence; unknown/legacy period assignments never satisfy them.
 * firstMonth <= lastMonth in every interval.
 * Source mappings must match CATEGORY_SCOPE_MAP and recordActivityTypesFor.
 * Company/site or granularity conflicts are gaps, never double-counted totals. */
export interface InventoryBoundarySnapshot {
  id: string;
  version: number;
  organisationId: string;
  reportingYear: number;
  /** Explicit declared inventory, not whatever the requester can currently see. */
  subsidiaryIds: readonly string[];
  decision: 'unconfirmed' | 'confirmed';
  decidedBy: string | null;
  decidedAt: string | null;
  attribution: readonly InventoryAttributionPolicy[];
  sources: readonly InventorySource[];
}

/** Opaque actor IDs only: no joined personal names copied into retained data.
 * calculation is copied unchanged, including zero inputs and historic factors.
 * A voided row remains disclosed and contributes to no inventory total. */
export type ReportDatasetRecord = Pick<ActivityRecordDTO,
  'id' | 'subsidiaryId' | 'locationId' | 'reportingYear' | 'reportingPeriod' |
  'periodValue' | 'category' | 'status' | 'activityValue' | 'activityUnit' |
  'calculation' | 'createdBy' | 'createdAt' | 'updatedAt' | 'reviewedBy' |
  'reviewedAt' | 'submittedAt' | 'voidedBy' | 'voidedAt' | 'voidReason'
> & {
  /** Pilot dataset membership is Scope 1/2 only. Water/other Scope 3 records
   * are outside this inventory, not unexplained provenance/coverage gaps. */
  scope: 1 | 2;
  createdByName?: never;
  reviewedByName?: never;
  voidedByName?: never;
  activityType: string | null;
  subsidiaryName: string;
  locationName: string | null;
};

export interface Sha256Fingerprint {
  algorithm: 'sha256';
  /** Exactly 64 lowercase hexadecimal characters; never a URL or a secret. */
  hex: string;
}

export type ReportEvidenceReference = Pick<EvidenceDTO,
  'id' | 'subsidiaryId' | 'fileName' | 'mimeType' | 'sizeBytes' | 'createdAt'
> & {
  /** null means legacy/unknown content identity, never an empty-file hash. */
  contentFingerprint: Sha256Fingerprint | null;
  recordIds: readonly string[];
};

/** Current standing at capturedAt, distinct from standing in an immutable
 * calculation snapshot. Include factor AND conversion releases. A later
 * withdrawal never updates this captured disclosure or recalculates a figure. */
export type ReportReleaseStanding = Pick<FactorReleaseDTO,
  'id' | 'status' | 'withdrawnAt' | 'withdrawnBy' | 'withdrawalReason'
> & { publication: FactorReleaseSnapshot };

export interface ReportReviewAssessment {
  /** These three disjoint sets exhaust dataset.records. Empty is not complete. */
  approvedRecordIds: readonly string[];
  unapprovedRecordIds: readonly string[];
  voidedRecordIds: readonly string[];
}

export const REPORT_COVERAGE_GAP_CODES = [
  'boundary_unconfirmed', 'applicability_undetermined', 'unsupported_source',
  'missing_record', 'missing_evidence', 'attribution_conflict', 'overlapping_periods',
  'unmapped_record',
] as const;
export type ReportCoverageGapCode = (typeof REPORT_COVERAGE_GAP_CODES)[number];

export interface ReportCoverageGap {
  code: ReportCoverageGapCode;
  sourceIds: readonly string[];
  obligationIds: readonly string[];
  recordIds: readonly string[];
}

export interface ReportCoverageAssessment {
  /** Every included obligation occurs exactly once, whether met or missing.
   * Record/evidence references must agree with source, entity, type and period.
   * A record can satisfy coverage before approval; review stays independent. */
  obligations: ReadonlyArray<{
    obligationId: string;
    state: 'satisfied' | 'missing';
    recordIds: readonly string[];
    /** Every declared evidence period occurs exactly once, with the evidence
     * assigned to that period. Flat file counts cannot prove monthly coverage. */
    evidencePeriods: ReadonlyArray<{
      reportingPeriod: ReportingPeriod;
      periodValue: string;
      state: 'satisfied' | 'missing';
      evidenceIds: readonly string[];
    }>;
  }>;
  excludedSourceIds: readonly string[];
  gaps: readonly ReportCoverageGap[];
}

export const REPORT_PROVENANCE_ISSUE_CODES = [
  'uncalculated', 'legacy_snapshot', 'placeholder_release', 'fixture_release',
  'withdrawn_release', 'partial_gas_coverage', 'declared_year_fallback', 'gwp_set_mismatch',
] as const;
export type ReportProvenanceIssueCode = (typeof REPORT_PROVENANCE_ISSUE_CODES)[number];

export interface ReportProvenanceAssessment {
  /** Every non-voided record appears once. authoritative requires both the
   * factor and conversion to be authoritative at capture. Gas coverage and
   * declared year fallback remain disclosed, not silently treated as errors.
   * D09 compares all counted GHG calculations across the inventory year: more
   * than one GWP set adds gwp_set_mismatch to every conflicting record and
   * blocks final even if each release is authoritative. CO2-only paths may
   * carry null GWP metadata and do not introduce a conflicting set. */
  records: ReadonlyArray<{
    recordId: string;
    standing: 'authoritative' | 'non_authoritative' | 'uncalculated' | 'legacy';
    issues: readonly ReportProvenanceIssueCode[];
  }>;
  releases: readonly ReportReleaseStanding[];
}

export type ReportScopeDisclosure<S extends 1 | 2 = 1 | 2> = {
  scope: S;
  coverage: 'covered' | 'partial';
  /** null when no counted record has a calculated figure. Zero requires real
   * calculated records; exclusions and missing factors never supply zeroes. */
  tCo2e: number | null;
  countedRecordIds: readonly string[];
};

export interface ReportUncoveredScope {
  scope: 3;
  coverage: 'not_covered';
  tCo2e?: never;
  countedRecordIds?: never;
}

/** SHA-256 of UTF-8 canonical content (see README). Identity and capture time
 * are retained, but excluded from the content-equivalence fingerprint. */
export interface ReportDatasetFingerprint extends Sha256Fingerprint {
  canonicalization: 'tonyai-report-dataset-v1';
}

/** Built and retained from ONE bounded consistent database snapshot; renderers
 * perform no live metadata, evidence, summary or release reads afterwards.
 * This contract does not change today's independent report queries.
 * Capture AND retrieval require access to every subsidiary referenced anywhere
 * in boundary.subsidiaryIds/sources/attribution, records, evidence, periodLocks
 * and resolvedSubsidiaryIds. This includes boundary-only metadata in an extract;
 * never authorize solely from resolvedSubsidiaryIds or silently redact a retained
 * dataset. Refuse the operation if any referenced subsidiary is inaccessible. Signed URLs and credentials never belong in the retained dataset. */
export interface ReportDataset {
  schemaVersion: typeof REPORT_DATASET_SCHEMA_VERSION;
  datasetId: string;
  capturedAt: string;
  organisationId: string;
  organisationName: string;
  context: ReportingContext;
  /** inventory requires the complete declared boundary, no scope/category
   * filters and access to every subsidiary. All-accessible is not all-owned. */
  selection: 'inventory' | 'extract';
  resolvedSubsidiaryIds: readonly string[];
  boundary: InventoryBoundarySnapshot;
  /** Scope 1/2 members only. A scope=3 context yields an empty partial extract
   * and the explicit not_covered disclosure, never Water in these assessments. */
  records: readonly ReportDatasetRecord[];
  evidence: readonly ReportEvidenceReference[];
  periodLocks: readonly PeriodLockDTO[];
  review: ReportReviewAssessment;
  coverage: ReportCoverageAssessment;
  provenance: ReportProvenanceAssessment;
  scopes: readonly [ReportScopeDisclosure<1>, ReportScopeDisclosure<2>, ReportUncoveredScope];
  fingerprint: ReportDatasetFingerprint;
}

export const REPORT_ISSUANCE_GAP_CODES = [
  'filtered_extract', 'coverage_gap', 'unapproved_record', 'unlocked_period',
  'non_authoritative_calculation', 'gwp_set_mismatch',
] as const;
export type ReportIssuanceGapCode = (typeof REPORT_ISSUANCE_GAP_CODES)[number];
export interface ReportIssuanceGap {
  code: ReportIssuanceGapCode;
  sourceIds: readonly string[];
  obligationIds: readonly string[];
  recordIds: readonly string[];
}

/** Present only after both immutable dataset and exact PDF bytes are retained.
 * A failed render/upload is not an issuance. A later language/template render
 * gets another issuanceId; its datasetId/content fingerprint may be shared.
 * Export projections of that dataset carry its same identity/fingerprint.
 * Retention duration and erasure exceptions remain D20/D21 policy decisions. */
export type ReportIssuance = {
  issuanceId: string;
  datasetId: string;
  datasetFingerprint: ReportDatasetFingerprint;
  issuedAt: string;
  issuedBy: string;
  language: Locale;
  template: ReportTemplate;
  rendererVersion: string;
  options: { includeMethodologyNotes: boolean; includeEvidenceSummary: boolean };
  pdf: {
    /** Opaque retained-artifact ID; never a bucket path or a signed URL. */
    artifactId: string;
    mimeType: 'application/pdf';
    sizeBytes: number;
    fingerprint: Sha256Fingerprint;
  };
} & (
  /** Server proves: confirmed full boundary; all obligations met, approved and
   * locked; no attribution/evidence gap; authoritative calculations and D09's
   * consistent inventory-year GWP set. A missing
   * factor, unknown boundary or unresolved named source always blocks final. */
  | { status: 'final'; gaps: readonly [] }
  | { status: 'partial'; gaps: readonly [ReportIssuanceGap, ...ReportIssuanceGap[]] }
);
