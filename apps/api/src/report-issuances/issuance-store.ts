import { Prisma } from '@tonyai/db';
import type { Locale, ReportDatasetFingerprint, ReportIssuance, ReportIssuanceGap, ReportTemplate } from '@tonyai/shared-types';

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
