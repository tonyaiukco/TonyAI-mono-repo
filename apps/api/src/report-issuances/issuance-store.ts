import { Prisma } from '@tonyai/db';
import type {
  InventoryBoundarySnapshot,
  Locale,
  ReportDataset,
  ReportDatasetFingerprint,
  ReportingContext,
  ReportIssuance,
  ReportIssuanceGap,
  ReportIssuanceGapCode,
  ReportIssuanceList,
  ReportTemplate,
} from '@tonyai/shared-types';

/**
 * The issuances (`report_issuances`; LP3-04 PR D). Read through here only, so
 * the read rule — the caller's organisation, then every subsidiary the
 * issuance's dataset references in the caller's current access, else not
 * found — is written once, in SQL, before any limit.
 */

/** Newest first, at most this many a list. */
export const ISSUANCE_LIST_LIMIT = 50;

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** One row as the routes need it — the object's key never leaves the API. */
export interface IssuanceRow {
  id: string;
  organisation_id: string;
  dataset_id: string;
  reporting_year: number;
  canonicalization: ReportDatasetFingerprint['canonicalization'];
  dataset_fingerprint_hex: string;
  status: 'final' | 'partial';
  gaps: ReportIssuanceGap[];
  language: Locale;
  template: ReportTemplate;
  include_methodology_notes: boolean;
  include_evidence_summary: boolean;
  renderer_version: string;
  artifact_id: string;
  storage_path: string;
  size_bytes: number;
  sha256: string;
  issued_by: string;
  issued_at: string;
}

/** The issuances the caller may read — one by id, or a year's, newest first. */
export async function readIssuanceRows(
  db: Db,
  organisationId: string,
  access: readonly string[],
  which: { id: string } | { year: number },
): Promise<IssuanceRow[]> {
  if (access.length === 0) return [];
  const filter = 'id' in which
    ? Prisma.sql`i."id" = ${which.id}::uuid`
    : Prisma.sql`i."reporting_year" = ${which.year}`;
  return db.$queryRaw<IssuanceRow[]>`
    SELECT i."id"::text AS id,
           i."organisation_id"::text AS organisation_id,
           i."dataset_id"::text AS dataset_id,
           i."reporting_year" AS reporting_year,
           i."canonicalization" AS canonicalization,
           i."dataset_fingerprint_hex" AS dataset_fingerprint_hex,
           i."status" AS status,
           i."gaps" AS gaps,
           i."language" AS language,
           i."template" AS template,
           i."include_methodology_notes" AS include_methodology_notes,
           i."include_evidence_summary" AS include_evidence_summary,
           i."renderer_version" AS renderer_version,
           i."artifact_id"::text AS artifact_id,
           i."storage_path" AS storage_path,
           i."size_bytes" AS size_bytes,
           i."sha256" AS sha256,
           i."issued_by"::text AS issued_by,
           pg_catalog.to_char(i."issued_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at
    FROM "report_issuances" i
    WHERE i."organisation_id" = ${organisationId}::uuid
      AND ${filter}
      AND pg_catalog.cardinality(i."referenced_subsidiary_ids") > 0
      AND i."referenced_subsidiary_ids" <@ ${[...access]}::uuid[]
    ORDER BY i."issued_at" DESC, i."id" DESC
    LIMIT ${ISSUANCE_LIST_LIMIT}`;
}

interface SummaryRow {
  id: string;
  dataset_id: string;
  reporting_year: number;
  canonicalization: ReportDatasetFingerprint['canonicalization'];
  dataset_fingerprint_hex: string;
  status: 'final' | 'partial';
  gap_count: number;
  gap_counts: Partial<Record<ReportIssuanceGapCode, number>>;
  language: Locale;
  template: ReportTemplate;
  include_methodology_notes: boolean;
  include_evidence_summary: boolean;
  renderer_version: string;
  size_bytes: number;
  sha256: string;
  issued_by: string;
  issued_at: string;
  captured_at: string;
  context: ReportingContext;
  selection: ReportDataset['selection'];
  boundary_id: string;
  version: number;
  decision: InventoryBoundarySnapshot['decision'];
}

/**
 * A year's issuances as the list names them (LP4-03 K7; LP3-04 PR D follow-up
 * (8)): the read rule in SQL before the limit, as `readIssuanceRows`; the gaps
 * COUNTED in SQL (an issuance's gap arrays can reach about 1 MB, and fifty of
 * them were the old list's answer); one row past the limit read to say
 * `truncated`; and the year's newest readable final looked up on its own, so a
 * page of newer partials cannot push the current final out of sight.
 */
export async function readIssuanceList(
  db: Db,
  organisationId: string,
  access: readonly string[],
  year: number,
  status?: 'final' | 'partial',
): Promise<ReportIssuanceList> {
  if (access.length === 0) return { items: [], truncated: false, currentFinalIssuanceId: null };
  const readable = Prisma.sql`i."organisation_id" = ${organisationId}::uuid
      AND i."reporting_year" = ${year}
      AND pg_catalog.cardinality(i."referenced_subsidiary_ids") > 0
      AND i."referenced_subsidiary_ids" <@ ${[...access]}::uuid[]`;
  const byStatus = status === undefined ? Prisma.empty : Prisma.sql`AND i."status" = ${status}`;
  const rows = await db.$queryRaw<SummaryRow[]>`
    SELECT i."id"::text AS id,
           i."dataset_id"::text AS dataset_id,
           i."reporting_year" AS reporting_year,
           i."canonicalization" AS canonicalization,
           i."dataset_fingerprint_hex" AS dataset_fingerprint_hex,
           i."status" AS status,
           pg_catalog.jsonb_array_length(i."gaps") AS gap_count,
           COALESCE((SELECT pg_catalog.jsonb_object_agg(c.code, c.n)
                     FROM (SELECT g.value ->> 'code' AS code, pg_catalog.count(*)::int AS n
                           FROM pg_catalog.jsonb_array_elements(i."gaps") AS g
                           GROUP BY 1) AS c), '{}'::jsonb) AS gap_counts,
           i."language" AS language,
           i."template" AS template,
           i."include_methodology_notes" AS include_methodology_notes,
           i."include_evidence_summary" AS include_evidence_summary,
           i."renderer_version" AS renderer_version,
           i."size_bytes" AS size_bytes,
           i."sha256" AS sha256,
           i."issued_by"::text AS issued_by,
           pg_catalog.to_char(i."issued_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued_at,
           pg_catalog.to_char(d."captured_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           d."context" AS context,
           d."selection" AS selection,
           d."boundary_id"::text AS boundary_id,
           b."version" AS version,
           b."decision" AS decision
    FROM "report_issuances" i
    JOIN "report_datasets" d ON d."id" = i."dataset_id" AND d."organisation_id" = i."organisation_id"
    JOIN "inventory_boundaries" b ON b."id" = d."boundary_id" AND b."organisation_id" = d."organisation_id"
    WHERE ${readable} ${byStatus}
    ORDER BY i."issued_at" DESC, i."id" DESC
    LIMIT ${ISSUANCE_LIST_LIMIT + 1}`;
  const [current] = await db.$queryRaw<Array<{ id: string }>>`
    SELECT i."id"::text AS id FROM "report_issuances" i
    WHERE ${readable} AND i."status" = 'final'
    ORDER BY i."issued_at" DESC, i."id" DESC
    LIMIT 1`;
  return {
    items: rows.slice(0, ISSUANCE_LIST_LIMIT).map((r) => ({
      issuanceId: r.id,
      datasetId: r.dataset_id,
      datasetFingerprint: { algorithm: 'sha256', canonicalization: r.canonicalization, hex: r.dataset_fingerprint_hex },
      reportingYear: r.reporting_year,
      issuedAt: r.issued_at,
      issuedBy: r.issued_by,
      status: r.status,
      gapCount: r.gap_count,
      gapCounts: r.gap_counts,
      language: r.language,
      template: r.template,
      rendererVersion: r.renderer_version,
      options: { includeMethodologyNotes: r.include_methodology_notes, includeEvidenceSummary: r.include_evidence_summary },
      pdf: { sizeBytes: r.size_bytes, fingerprint: { algorithm: 'sha256', hex: r.sha256 } },
      dataset: {
        capturedAt: r.captured_at,
        context: r.context,
        selection: r.selection,
        boundary: { id: r.boundary_id, version: r.version, decision: r.decision },
      },
    })),
    truncated: rows.length > ISSUANCE_LIST_LIMIT,
    currentFinalIssuanceId: current?.id ?? null,
  };
}

/** The contract's shape of a row — its status and gaps as the gate derived them. */
export function toIssuance(row: IssuanceRow): ReportIssuance {
  const common = {
    issuanceId: row.id,
    organisationId: row.organisation_id,
    datasetId: row.dataset_id,
    datasetFingerprint: { algorithm: 'sha256' as const, canonicalization: row.canonicalization, hex: row.dataset_fingerprint_hex },
    issuedAt: row.issued_at,
    issuedBy: row.issued_by,
    language: row.language,
    template: row.template,
    rendererVersion: row.renderer_version,
    options: { includeMethodologyNotes: row.include_methodology_notes, includeEvidenceSummary: row.include_evidence_summary },
    pdf: {
      artifactId: row.artifact_id,
      mimeType: 'application/pdf' as const,
      sizeBytes: row.size_bytes,
      fingerprint: { algorithm: 'sha256' as const, hex: row.sha256 },
    },
  };
  // The table's CHECK holds the two shapes: a final has no gap, a partial one at least.
  return row.status === 'final'
    ? { ...common, status: 'final', gaps: [] }
    : { ...common, status: 'partial', gaps: row.gaps as [ReportIssuanceGap, ...ReportIssuanceGap[]] };
}
