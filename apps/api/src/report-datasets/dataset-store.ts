import { Prisma } from '@tonyai/db';
import type { InventoryBoundarySnapshot, ReportDataset, ReportDatasetFingerprint, ReportDatasetSummary, ReportingContext } from '@tonyai/shared-types';

/**
 * The retained datasets (`report_datasets`; LP3-04 PR C, V5, V7). A row holds
 * the dataset's exact JSON text — `content` — and the columns the read rule
 * and the list need; the table's guard (TA016) holds every column to the
 * content it stores. Read through here only, so the rule — the caller's
 * organisation, then every referenced subsidiary in the caller's current
 * access, else not found — is written once.
 */

/** Newest first, at most this many a list. */
export const DATASET_LIST_LIMIT = 50;

type Db = Pick<Prisma.TransactionClient, 'reportDataset' | '$queryRaw'>;

/** Readable: a non-empty referenced set wholly inside current access (README). */
export const readableBy = (referenced: readonly string[], access: readonly string[]): boolean => {
  const granted = new Set(access);
  return referenced.length > 0 && referenced.every((id) => granted.has(id));
};

/** The row a capture inserts — its columns taken from the dataset itself. */
export function datasetRow(dataset: ReportDataset, referenced: readonly string[], capturedBy: string) {
  return {
    id: dataset.datasetId,
    organisationId: dataset.organisationId,
    boundaryId: dataset.boundary.id,
    reportingYear: dataset.context.year,
    selection: dataset.selection,
    context: dataset.context as unknown as Prisma.InputJsonObject,
    schemaVersion: dataset.schemaVersion,
    canonicalization: dataset.fingerprint.canonicalization,
    fingerprintHex: dataset.fingerprint.hex,
    referencedSubsidiaryIds: [...referenced],
    capturedBy,
    capturedAt: new Date(dataset.capturedAt),
    content: JSON.stringify(dataset),
  } satisfies Prisma.ReportDatasetUncheckedCreateInput;
}

export function datasetSummary(dataset: ReportDataset, capturedBy: string): ReportDatasetSummary {
  return {
    datasetId: dataset.datasetId,
    capturedAt: dataset.capturedAt,
    capturedBy,
    context: dataset.context,
    selection: dataset.selection,
    boundary: { id: dataset.boundary.id, version: dataset.boundary.version, decision: dataset.boundary.decision },
    fingerprint: dataset.fingerprint,
  };
}

/** One retained dataset's text, or null — unknown, another organisation's, or not wholly in access. */
export async function readDatasetContent(
  db: Db,
  id: string,
  organisationId: string,
  access: readonly string[],
): Promise<string | null> {
  const row = await db.reportDataset.findFirst({
    where: { id, organisationId },
    select: { content: true, referencedSubsidiaryIds: true },
  });
  return row !== null && readableBy(row.referencedSubsidiaryIds, access) ? row.content : null;
}

interface SummaryRow {
  id: string;
  captured_at: string;
  captured_by: string;
  context: ReportingContext;
  selection: ReportDataset['selection'];
  boundary_id: string;
  version: number;
  decision: InventoryBoundarySnapshot['decision'];
  canonicalization: ReportDatasetFingerprint['canonicalization'];
  fingerprint_hex: string;
}

/**
 * A year's datasets the caller may read, newest first: the subset rule is
 * applied in SQL before the limit, so an unreadable dataset never takes a
 * readable one's place.
 */
export async function listDatasetSummaries(
  db: Db,
  organisationId: string,
  reportingYear: number,
  access: readonly string[],
): Promise<ReportDatasetSummary[]> {
  if (access.length === 0) return [];
  const rows = await db.$queryRaw<SummaryRow[]>`
    SELECT d."id"::text AS id,
           pg_catalog.to_char(d."captured_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
           d."captured_by"::text AS captured_by,
           d."context" AS context,
           d."selection" AS selection,
           d."boundary_id"::text AS boundary_id,
           b."version" AS version,
           b."decision" AS decision,
           d."canonicalization" AS canonicalization,
           d."fingerprint_hex" AS fingerprint_hex
    FROM "report_datasets" d
    JOIN "inventory_boundaries" b ON b."id" = d."boundary_id" AND b."organisation_id" = d."organisation_id"
    WHERE d."organisation_id" = ${organisationId}::uuid
      AND d."reporting_year" = ${reportingYear}
      AND pg_catalog.cardinality(d."referenced_subsidiary_ids") > 0
      AND d."referenced_subsidiary_ids" <@ ${[...access]}::uuid[]
    ORDER BY d."captured_at" DESC, d."id" DESC
    LIMIT ${DATASET_LIST_LIMIT}`;
  return rows.map((r) => ({
    datasetId: r.id,
    capturedAt: r.captured_at,
    capturedBy: r.captured_by,
    context: r.context,
    selection: r.selection,
    boundary: { id: r.boundary_id, version: r.version, decision: r.decision },
    // The row's own tag: fingerprints are compared only when tags match.
    fingerprint: { algorithm: 'sha256', canonicalization: r.canonicalization, hex: r.fingerprint_hex },
  }));
}
