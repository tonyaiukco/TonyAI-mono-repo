import type { Prisma } from '@tonyai/db';
import {
  generationFuelRecordFor,
  type GenerationFuelRecordKind,
  type GenerationFuelRecordState,
} from '@tonyai/shared-types';

/** What the lookup reads of a record it answers for. */
export interface GenerationFuelSubject {
  id: string;
  subsidiaryId: string;
  locationId: string | null;
  reportingYear: number;
  category: string;
  parameters: unknown;
}

/** A fuel record's identity for the match (D5): its site, its year and its kind. */
function slotKey(
  subsidiaryId: string,
  locationId: string | null,
  reportingYear: number,
  category: string,
  activityType: string | null,
): string {
  // JSON keeps a null location apart from any location id.
  return JSON.stringify([subsidiaryId, locationId, reportingYear, category, activityType]);
}

/**
 * Whether each fuel-sourced Electricity record among `records` has its fuel
 * record (Decisions 2026-11-20 D5; `self-gen-form`, design 6), keyed by record
 * id. A record with no fuel source has no entry, and its DTO reads null.
 *
 * A match is a record that is not voided, of the same subsidiary, the same
 * location (null matching null: a whole-company record looks for a
 * whole-company fuel record), any period of the same reporting year, and the
 * kind `SELF_GENERATION_FUEL_RECORDS` names. One query for all of `records`,
 * one condition per distinct site, year and kind, and none at all when no
 * record needs one. Every condition carries the record's own subsidiary, and
 * the query is also bounded by the caller's accessible set: `records` were
 * read in that scope, so the bound changes no answer, but no query here runs
 * outside it. Only the key columns are read.
 */
export async function generationFuelRecords(
  client: Pick<Prisma.TransactionClient, 'activityRecord'>,
  accessibleSubsidiaryIds: readonly string[],
  records: readonly GenerationFuelSubject[],
): Promise<Map<string, GenerationFuelRecordState>> {
  const needs: { id: string; key: string; subject: GenerationFuelSubject; kind: GenerationFuelRecordKind }[] = [];
  for (const record of records) {
    const kind = generationFuelRecordFor(record);
    if (kind === null) continue;
    const key = slotKey(record.subsidiaryId, record.locationId, record.reportingYear, kind.category, kind.activityType);
    needs.push({ id: record.id, key, subject: record, kind });
  }
  const states = new Map<string, GenerationFuelRecordState>();
  if (needs.length === 0) return states;

  const accessible = new Set(accessibleSubsidiaryIds);
  const distinct = [...new Map(needs.filter((n) => accessible.has(n.subject.subsidiaryId)).map((n) => [n.key, n])).values()];
  const found = new Set<string>();
  if (distinct.length > 0) {
    const rows = await client.activityRecord.findMany({
      where: {
        subsidiaryId: { in: [...accessible] },
        status: { not: 'voided' },
        OR: distinct.map(({ subject, kind }) => ({
          subsidiaryId: subject.subsidiaryId,
          locationId: subject.locationId,
          reportingYear: subject.reportingYear,
          category: kind.category,
          ...(kind.activityType !== null ? { activityType: kind.activityType } : {}),
        })),
      },
      select: { subsidiaryId: true, locationId: true, reportingYear: true, category: true, activityType: true },
    });
    for (const row of rows) {
      // A row answers both a need for its exact type and one for any record of its category.
      found.add(slotKey(row.subsidiaryId, row.locationId, row.reportingYear, row.category, row.activityType));
      found.add(slotKey(row.subsidiaryId, row.locationId, row.reportingYear, row.category, null));
    }
  }
  for (const need of needs) states.set(need.id, found.has(need.key) ? 'present' : 'missing');
  return states;
}
