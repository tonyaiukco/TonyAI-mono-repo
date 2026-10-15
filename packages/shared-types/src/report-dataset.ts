import type {
  ActivityRecordDTO, Category, EvidenceDTO, FactorReleaseDTO, FactorReleaseSnapshot,
  Locale, PeriodLockDTO, ReportingContext, ReportingPeriod, ReportTemplate,
} from './index';

/** LP3-04: additive, dormant contracts. No existing route returns these yet.
 * All timestamps use Date.prototype.toISOString() UTC spelling; months are calendar months of reportingYear.
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
  /** Inclusive months the entity is included in the inventory, which may
   * differ from its physical lifetime; never inferred from row createdAt. A
   * site's lie within its subsidiary's (Decisions 2026-10-15 (third) (5)). */
  firstMonth: InventoryMonth;
  lastMonth: InventoryMonth;
}

/** One D12 decision per entity/category cell selected by the D11 policy.
 * Included cells name all included mapped sources for that cell; source IDs
 * cannot be used to satisfy a second cell. Every included mapped source is named
 * by exactly one selected included cell with matching subsidiaryId/locationId/category.
 * Excluded and undetermined cells hold no included source. A breach is an invalid
 * boundary (attribution_conflict); its affected records are unmapped and never counted.
 * Exclusion reasons must be nonblank. */
export type InventoryApplicabilityDecision = {
  subsidiaryId: string;
  locationId: string | null;
  category: Category;
} & (
  | { applicability: 'included'; sourceIds: readonly string[]; reason?: never }
  | { applicability: 'excluded' | 'undetermined'; reason: string; sourceIds?: never }
);

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

/** A version is immutable once captured into any dataset or confirmed. New facts create a new
 * version; one captured unconfirmed is confirmed only as a copy
 * (`boundary_confirm_requires_copy`). super_admin owns decisions; reasons must be nonblank. Included
 * sources have obligations that exhaust their operating months exactly once
 * at the source reportingPeriod, matching the category attribution policy
 * wherever mapped (unsupported sources still declare a cadence), with canonical period labels
 * and intervals clipped to the source's active months (no gaps or overlaps).
 * evidenceReportingPeriod independently declares the evidence cadence; null
 * explicitly means none. Each obligation's evidencePeriods exhaust its active
 * months at that cadence; unknown/legacy period assignments never satisfy them.
 * firstMonth <= lastMonth in every interval.
 * For every boundary subsidiary, retain every entity operating in any month
 * of reportingYear. A site entity's firstMonth/lastMonth lie within its
 * subsidiary's company entity's: the months it is included in the inventory.
 * attribution holds exactly one policy per boundary subsidiary x Scope 1/2 category. A missing or duplicate policy, or a sites policy with no
 * operating site entity, is a final-blocking applicability_undetermined gap naming
 * the company entity and category. For every Scope 1/2 category, the D11 policy selects either
 * the company entity or ALL operating site entities. Each resulting entity x
 * category cell has exactly one applicability decision: included, excluded
 * with a nonblank reason, or undetermined. A missing cell is a final-blocking
 * applicability_undetermined gap, never an implicit exclusion. Included cells
 * reference a nonempty set of matching included mapped sources. Every included
 * mapped source is named by exactly one included cell selected by D11, with matching
 * (subsidiaryId, locationId, category). Excluded and undetermined cells hold no
 * included source. A breach is an invalid boundary (attribution_conflict); its
 * affected records raise unmapped_record and are never counted.
 * Unsupported sources that are included or undetermined raise unsupported_source
 * and block final. Unsupported sources excluded with a nonblank reason are named
 * exclusions: disclosed, never counted, and do not block final.
 * Included mapped sources are unique by (subsidiaryId, locationId, category,
 * activityType); two meters sharing this key cannot both claim one record.
 * Every source's entity snapshot agrees with the retained entity, including
 * firstMonth/lastMonth. Entity keys (subsidiaryId, locationId) and source IDs
 * are unique, and obligation IDs are unique across the whole boundary.
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
  /** The confirming super_admin's profile id, written by the API from the
   * caller's verified token — never a request field — and opaque: no foreign
   * key, so a profile's erasure (D20/D21) leaves it standing (LP3-04 E6). */
  decidedBy: string | null;
  decidedAt: string | null;
  /** Complete domain, including entities whose categories have no source yet. */
  entities: readonly InventoryEntitySnapshot[];
  applicability: readonly InventoryApplicabilityDecision[];
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
  /** Subset of dataset.records IDs. Until an evidence-period schema exists,
   * only a linked non-voided record's own period assigns evidence to coverage;
   * an annual link cannot be assigned to a monthly evidence obligation. */
  recordIds: readonly string[];
};

/** Current standing at capturedAt, distinct from standing in an immutable
 * calculation snapshot. Include factor AND conversion releases. A later
 * withdrawal never updates this captured disclosure or recalculates a figure. */
export type ReportReleaseStanding = Pick<FactorReleaseDTO,
  'id' | 'status' | 'withdrawnAt' | 'withdrawnBy' | 'withdrawalReason'
> & { publication: Omit<FactorReleaseSnapshot, 'id' | 'status'> };

export interface ReportReviewAssessment {
  /** These three disjoint sets exhaust dataset.records. Empty is not complete.
   * approvedRecordIds includes approved AND locked (period locks flip approved
   * records to locked). For final issuance, every satisfying record belongs here. */
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

/** Every non-voided captured record must attach to exactly one included
 * obligation. Otherwise unmapped_record blocks final and the record is never
 * counted: outside boundary subsidiaries, excluded/undetermined/unsupported
 * source, outside operating months, or D11 attribution mismatch. Attribution
 * conflicts also name the conflicting records; none enter totals. */
export interface ReportCoverageGap {
  /** Required for a missing applicability cell with no source/obligation ID. */
  entity?: Pick<InventoryEntitySnapshot, 'subsidiaryId' | 'locationId'>;
  category?: Category;
  code: ReportCoverageGapCode;
  sourceIds: readonly string[];
  obligationIds: readonly string[];
  recordIds: readonly string[];
}

export interface ReportCoverageAssessment {
  /** Every included obligation occurs exactly once, whether met or missing.
   * Record/evidence references must agree with source, entity, type and period.
   * Voided records NEVER appear in these recordIds or satisfy activity/evidence
   * coverage. Only-voided obligations are missing and raise missing_record; a
   * D04 re-entry lists only the replacement. Evidence linked only to a voided
   * record cannot satisfy evidencePeriods. Only non-voided records in COUNTED_STATUSES
   * (submitted, under_review, approved, locked) satisfy ACTIVITY coverage and appear
   * in these recordIds. Draft/rejected-only slots remain missing with missing_record.
   * Evidence coverage remains independent, using a linked non-voided record's own
   * period. Final additionally requires every satisfying record approved or locked. */
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
  /** covered only when every included obligation of this scope is satisfied,
   * the scope has no gap, and every counted
   * record is calculated. Otherwise partial. */
  coverage: 'covered' | 'partial';
  /** Sum of calculated figures among countedRecordIds, null if none is
   * calculated. Zero needs actual calculated records, not missing factors. */
  tCo2e: number | null;
  /** Exactly the non-voided records in COUNTED_STATUSES attached to exactly
   * one included obligation under D11. Attribution-conflicting/unmapped rows
   * are disclosed in gaps and NEVER summed. */
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
 * Every lookup (capture, list, metadata, PDF download, CSV/Excel projection)
 * first requires requester.organisationId === dataset.organisationId. Then
 * require a NON-EMPTY referenced-subsidiary set derived from the built dataset:
 * context.subsidiaryId, boundary subsidiaries/entities/applicability/sources/
 * attribution, records, evidence, periodLocks, coverage gap entities and
 * resolvedSubsidiaryIds. Every ID must be in the requester's CURRENT access,
 * checked on every request. Never redact, authorize solely from resolvedSubsidiaryIds,
 * or allow the capturer/issuer a bypass. datasetId, issuanceId,
 * artifactId and fingerprints are never capabilities. Refusal is indistinguishable
 * from not-found. Signed URLs and credentials never belong in retained data. */
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
  /** Match exactly on (subsidiaryId, reportingYear, reportingPeriod, periodValue).
   * An annual obligation needs the Annual lock, not twelve monthly locks. */
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
 * An issuance is append-only like audit_log: no field is ever updated or
 * re-pointed. Create it only after verifying datasetFingerprint against the
 * retained dataset's recomputed fingerprint (same canonicalization tag) and
 * pdf.fingerprint against SHA-256 of the stored bytes. status and gaps derive
 * solely from the retained dataset; any correction is a new capture or issuance.
 * selection === 'extract' always yields partial with a filtered_extract gap.
 * Every lookup (capture, list, metadata, PDF download, CSV/Excel projection)
 * first requires requester.organisationId === dataset.organisationId ===
 * issuance.organisationId; then a NON-EMPTY referenced-subsidiary set computed
 * from the built dataset (including context.subsidiaryId and boundary-only
 * metadata) wholly inside CURRENT access on every request. Capturer/issuer
 * have no bypass. datasetId, issuanceId, artifactId and fingerprints are never
 * capabilities. Refusal is indistinguishable from not-found; never redact.
 * Retention duration and erasure exceptions remain D20/D21 policy decisions. */
export type ReportIssuance = {
  issuanceId: string;
  organisationId: string;
  datasetId: string;
  datasetFingerprint: ReportDatasetFingerprint;
  issuedAt: string;
  /** As `decidedBy`: the issuer's profile id from the verified token; opaque. */
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
   * locked (satisfying records approved OR locked); no attribution/evidence gap; authoritative calculations and D09's
   * consistent inventory-year GWP set. A missing
   * factor or unknown boundary always blocks final. Unsupported included or
   * undetermined sources raise unsupported_source and block final. Unsupported
   * sources excluded with a nonblank reason are disclosed, never counted, and
   * do not block final. */
  | { status: 'final'; gaps: readonly [] }
  | { status: 'partial'; gaps: readonly [ReportIssuanceGap, ...ReportIssuanceGap[]] }
);
