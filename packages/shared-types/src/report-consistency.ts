import type { EmissionsSummary, Locale, ReportTemplate } from './index';
import type {
  InventoryBoundarySnapshot,
  ReportCoverageGapCode,
  ReportDatasetFingerprint,
  ReportDatasetSummary,
  ReportIssuance,
  ReportIssuanceGap,
  ReportIssuanceGapCode,
} from './report-dataset';

/** LP4-03 (Decisions 2026-10-24, K1–K13): consistent live reports, honest
 * completeness and the issued reports' read side. Every live figure, count,
 * badge and coverage below is read in ONE REPEATABLE READ snapshot of the
 * database, and every format of one request is written from that one read.
 * A live report certifies nothing: only a `final` issuance does. */

/** A live report's Scope 3 disclosure (K4). Scope 3 is not covered by the
 * pilot inventory: its committed records are named here and never summed into
 * a live total, a tile or a percentage. A `scope=3` selection has no Scope 1/2
 * figures at all — its tiles read "not covered", never 0. */
export interface ReportScope3Disclosure {
  coverage: 'not_covered';
  /** Committed (COUNTED_STATUSES) Scope 3 records in the selection. */
  recordCount: number;
  /** Sum of those that carry a figure; 0 when none does — read with the counts. */
  calculatedTCo2e: number;
  uncalculatedRecordCount: number;
}

/** A live report's own summary (K2, K4): the Scope 1/2 committed records it
 * lists, summed — `EmissionsSummary`'s shape with Scope 3 held at the literal
 * 0, so it cannot be summed into a total by mistake. NOT the emissions summary
 * (`GET /emissions/summary`), whose totals include Scope 3: a screen showing
 * both must label them apart. */
type InventoryPoint = Omit<EmissionsSummary['trend']['monthly'][number], 'scope3'> & { scope3: 0 };
export type ReportInventorySummary = Omit<EmissionsSummary, 'totals' | 'trend'> & {
  totals: { scope1: number; scope2: number; scope3: 0; total: number };
  trend: { monthly: InventoryPoint[]; quarterly: InventoryPoint[]; yearly: InventoryPoint[] };
};

/** What the live inventory boundary says about a live selection (K3). The
 * year's NEWEST boundary version — open, frozen or confirmed — assessed by the
 * capture's rule (`assessDataset`) over every Scope 1/2 record of the REPORT's
 * selection, any status, as it stands in the same snapshot — a subsidiary the
 * boundary does not declare included, its records `unmapped_record` gaps,
 * since the live total counts them. Not a dataset: nothing is retained, and
 * nothing here certifies the inventory. */
export type ReportLiveCoverage =
  /** No boundary version exists for the year: coverage is unknown, never complete. */
  | { state: 'no_boundary' }
  /** A version exists, but declares a subsidiary outside the caller's current
   * access (the boundary's read rule). Its contents are not disclosed. */
  | { state: 'not_readable' }
  /** A Scope 3 selection: the inventory does not cover it; no boundary is read. */
  | { state: 'not_covered' }
  /** The selection's records or evidence links exceed the report budgets
   * (what a capture refuses as `query_too_broad`): the figures stand, coverage is unknown. */
  | { state: 'too_broad' }
  | {
      state: 'assessed';
      boundary: Pick<InventoryBoundarySnapshot, 'id' | 'version' | 'decision'> & { frozen: boolean };
      /** `inventory` for no filter, `extract` for any — as a capture's. */
      selection: 'inventory' | 'extract';
      /** Included obligations in the selection, and how many a counted record satisfies. */
      obligationCount: number;
      satisfiedObligationCount: number;
      excludedSourceCount: number;
      /** Coverage gaps by code; absent codes are zero. */
      gapCounts: Partial<Record<ReportCoverageGapCode, number>>;
      /**
       * `complete` — no coverage gap and at least one included obligation;
       * `gaps` — at least one gap (a one-record year: its missing months are
       * `missing_record` gaps; an unconfirmed version: `boundary_unconfirmed`);
       * `nothing_included` — no gap and no included obligation (every category
       * excluded with its reason); `outside_boundary` — an extract of a
       * subsidiary the version does not declare (a capture refuses one,
       * `subsidiary_not_found`): none of its records is covered. Coverage only: approval, period locks, factor
       * standing and an uncalculated figure are a final issuance's gate — so
       * `complete` is never a certification, and an issued scope can still read
       * `partial`.
       */
      reading: 'complete' | 'gaps' | 'nothing_included' | 'outside_boundary';
    };

/** `GET /report-issuances?year=&status=` (K7): newest first, at most
 * `limit` items; `truncated` when more exist. `currentFinalIssuanceId` is the
 * year's newest readable final whether or not it is in `items` (Decisions
 * 2026-10-21, K1: "the newest final is the current one", per reporting year). */
export interface ReportIssuanceList {
  items: ReportIssuanceSummary[];
  truncated: boolean;
  currentFinalIssuanceId: string | null;
}

/** One issuance as a list names it — its gaps counted, never listed (an
 * issuance's gap arrays can reach about 1 MB; `GET /report-issuances/:id`
 * answers them whole). */
export interface ReportIssuanceSummary {
  issuanceId: string;
  datasetId: string;
  datasetFingerprint: ReportDatasetFingerprint;
  reportingYear: number;
  issuedAt: string;
  /** Opaque, as `ReportIssuance.issuedBy`. */
  issuedBy: string;
  status: 'final' | 'partial';
  gapCount: number;
  gapCounts: Partial<Record<ReportIssuanceGapCode, number>>;
  language: Locale;
  template: ReportTemplate;
  rendererVersion: string;
  options: ReportIssuance['options'];
  pdf: Pick<ReportIssuance['pdf'], 'sizeBytes' | 'fingerprint'>;
  /** The issued dataset, as its list names it. */
  dataset: Pick<ReportDatasetSummary, 'capturedAt' | 'context' | 'selection' | 'boundary'>;
}

/** `GET /report-datasets/:id/issuance-preview` (K7): what issuing this
 * dataset would derive — the gate's own pure derivation over the retained
 * dataset, nothing written. `finalAllowed` is whether the caller's role may
 * issue that final (W4: `super_admin` only); a partial is a consultant's too. */
export interface ReportIssuancePreview {
  datasetId: string;
  status: 'final' | 'partial';
  gaps: readonly ReportIssuanceGap[];
  finalAllowed: boolean;
}
