import type { Prisma } from '@tonyai/db';
import {
  isCalculated,
  judgeFuelBatch,
  type ActivityCalculationSnapshot,
  type AnomalyVerdict,
  type FuelBatchAnomalyInvoice,
} from '@tonyai/shared-types';

/**
 * The per-invoice anomaly verdicts of a fuel batch's records (inc28-fuel-bulk
 * D12), read from the database and judged by `judgeFuelBatch` — the function
 * `pnpm anomaly:recompute` judges with too. Run inside the submitting step's
 * transaction, under the batch's lock.
 */

type Db = Pick<Prisma.TransactionClient, '$queryRaw' | 'activityRecord'>;

/** The statuses of a batch whose invoice counts as history. */
export const FUEL_BATCH_COUNTED_STATUSES = ['submitted', 'under_review', 'approved'] as const;

export async function fuelBatchVerdicts(db: Db, batchId: string): Promise<Record<string, AnomalyVerdict>> {
  const invoices = await db.$queryRaw<Array<{ id: string; invoice_ref: string; status: string; period: number }>>`
    SELECT b.id::text, b.invoice_ref, b.status,
           min(COALESCE(to_char(r.transaction_at, 'YYYYMMDD')::int, r.year * 10000 + r.month * 100 + 1))::int AS period
    FROM fuel_batches b
    JOIN fuel_batches me ON me.id = ${batchId}::uuid
    JOIN fuel_rows r ON r.fuel_batch_id = b.id AND r.state = 'assigned'
    WHERE b.fuel_account_id = me.fuel_account_id AND b.usage = me.usage
      AND (b.id = me.id OR b.status = ANY(${[...FUEL_BATCH_COUNTED_STATUSES]}::text[]))
    GROUP BY b.id`;
  const records = await db.activityRecord.findMany({
    where: {
      fuelBatchId: { in: invoices.map((i) => i.id) },
      status: { notIn: ['voided', 'rejected', 'draft'] },
    },
    select: {
      id: true, fuelBatchId: true, category: true, activityType: true, activityValue: true,
      activityUnit: true, parameters: true, calculation: true, status: true,
    },
  });
  // The batch's own records in whatever status it holds them now; others' only while counted.
  const own = await db.activityRecord.findMany({
    where: { fuelBatchId: batchId, status: { not: 'voided' } },
    select: {
      id: true, fuelBatchId: true, category: true, activityType: true, activityValue: true,
      activityUnit: true, parameters: true, calculation: true, status: true,
    },
  });
  const toInvoice = (i: (typeof invoices)[number]): FuelBatchAnomalyInvoice => ({
    id: i.id,
    period: i.period,
    invoiceRef: i.invoice_ref,
    counted: (FUEL_BATCH_COUNTED_STATUSES as readonly string[]).includes(i.status),
    records: (i.id === batchId ? own : records.filter((r) => r.fuelBatchId === i.id)).map((r) => {
      const calc = r.calculation as unknown as ActivityCalculationSnapshot | null;
      return {
        id: r.id,
        activityType: r.activityType,
        tCo2e: isCalculated(calc) ? calc.tCo2e : null,
        ceiling: {
          category: r.category,
          activityType: r.activityType,
          activityValue: r.activityValue,
          activityUnit: r.activityUnit,
          parameters: r.parameters ?? undefined,
        },
      };
    }),
  });
  const self = invoices.find((i) => i.id === batchId);
  if (!self) return {};
  return judgeFuelBatch(toInvoice(self), invoices.filter((i) => i.id !== batchId).map(toInvoice));
}
