import { Prisma } from '@tonyai/db';
import { periodsOverlap } from './record-entities';

type Db = Prisma.TransactionClient;

/** One pair of records of opposite parties whose periods overlap (ids and canonical values only). */
export interface SingleEntryOverlap {
  subsidiaryId: string;
  category: string;
  reportingYear: number;
  companyUserRecord: { id: string; period: string; status: string };
  centralReporterRecord: { id: string; period: string; status: string };
}

export interface SingleEntryOverlapReport {
  pairs: number;
  /** How many pairs hold a record already decided (approved): those count in today's totals. */
  approvedPairs: number;
  overlaps: SingleEntryOverlap[];
}

/**
 * The pairs single entry (INC-2.6 §4.2) would refuse today but that were
 * stored before migration `20261128200000_single_entry_overlapping_periods`:
 * for one company, category and year, a company user's record and a central
 * reporter's record, neither voided, whose periods overlap (the year with any
 * of its periods, a month with its quarter). The trigger judges a record when
 * it is entered or its identity moves, never on a status step, so such a pair
 * stays in the lifecycle until someone settles it. Read only; organisation-wide
 * on purpose (an operator's pre-pilot read), and it answers ids and canonical
 * values, never a name or a figure.
 */
export async function findSingleEntryOverlaps(db: Db): Promise<SingleEntryOverlapReport> {
  const rows = await db.$queryRaw<Array<{
    subsidiary_id: string; category: string; reporting_year: number;
    own_id: string; own_period: string; own_status: string;
    reporter_id: string; reporter_period: string; reporter_status: string;
  }>>`
    SELECT own.subsidiary_id::text AS subsidiary_id, own.category, own.reporting_year,
           own.id::text AS own_id, own.reporting_period || ' ' || own.period_value AS own_period, own.status::text AS own_status,
           rep.id::text AS reporter_id, rep.reporting_period || ' ' || rep.period_value AS reporter_period, rep.status::text AS reporter_status
      FROM activity_records own
      JOIN profiles p ON p.id = own.created_by AND p.role::text = 'standard_user'
      JOIN activity_records rep
        ON rep.subsidiary_id = own.subsidiary_id
       AND rep.category = own.category
       AND rep.reporting_year = own.reporting_year
       AND rep.reported_by_subsidiary_id IS NOT NULL
       AND rep.reported_by_subsidiary_id <> rep.subsidiary_id
     WHERE (own.reported_by_subsidiary_id IS NULL OR own.reported_by_subsidiary_id = own.subsidiary_id)
       AND own.status::text <> 'voided'
       AND rep.status::text <> 'voided'
       AND ${periodsOverlap(
         { period: Prisma.sql`own.reporting_period`, value: Prisma.sql`own.period_value` },
         { period: Prisma.sql`rep.reporting_period`, value: Prisma.sql`rep.period_value` },
       )}
     ORDER BY own.subsidiary_id, own.category, own.reporting_year, own.id, rep.id`;
  const overlaps = rows.map((r) => ({
    subsidiaryId: r.subsidiary_id,
    category: r.category,
    reportingYear: r.reporting_year,
    companyUserRecord: { id: r.own_id, period: r.own_period, status: r.own_status },
    centralReporterRecord: { id: r.reporter_id, period: r.reporter_period, status: r.reporter_status },
  }));
  return {
    pairs: overlaps.length,
    approvedPairs: overlaps.filter((o) => o.companyUserRecord.status === 'approved' || o.centralReporterRecord.status === 'approved').length,
    overlaps,
  };
}
