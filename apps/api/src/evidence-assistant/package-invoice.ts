import { parseShellInvoiceRef } from '@tonyai/shared-types';
import { fold } from './invoice-layout';
import type { ReadInvoice } from './read-invoices';

/** What a fuel batch is keyed by for its invoice (INC-2.8 §1, §5, §6). */
export interface PackageInvoiceKey {
  source: string;
  invoiceRef: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A Shell half-month reference's first and last day, as ISO dates. */
export function shellHalfMonthDates(ref: string): { from: string; to: string } | null {
  const parsed = parseShellInvoiceRef(ref);
  if (!parsed) return null;
  const last = new Date(Date.UTC(parsed.year, parsed.month, 0)).getUTCDate();
  const ym = `${parsed.year}-${pad2(parsed.month)}`;
  return parsed.half === 1 ? { from: `${ym}-01`, to: `${ym}-15` } : { from: `${ym}-16`, to: `${ym}-${pad2(last)}` };
}

/**
 * The read invoices that are this package's (design D6, C9, C10): for Petrol
 * Ofisi the `OZK` invoice whose number is the batch's invoice number (trimmed,
 * case-folded); for Shell the `DAU` invoices whose printed period is exactly the
 * batch's half-month; for a tanker none (C8). One invoice printed in two files
 * is one, and the copy that was read wins over one that was not (a clean
 * invoice attached after an unsure PDF is compared — architect review of PR B,
 * P2). The caller treats none, or more than one, as not read.
 */
export function packageInvoices(batch: PackageInvoiceKey, invoices: readonly ReadInvoice[]): ReadInvoice[] {
  const out = new Map<string, ReadInvoice>();
  const add = (inv: ReadInvoice) => {
    const held = out.get(inv.invoiceNo);
    if (!held || (held.unreadReason !== null && inv.unreadReason === null)) out.set(inv.invoiceNo, inv);
  };
  if (batch.source === 'petrol_ofisi') {
    const ref = fold(batch.invoiceRef.trim());
    for (const inv of invoices) if (inv.series === 'OZK' && fold(inv.invoiceNo.trim()) === ref) add(inv);
  } else if (batch.source === 'shell') {
    const half = shellHalfMonthDates(batch.invoiceRef);
    if (half) {
      for (const inv of invoices) {
        if (inv.series === 'DAU' && inv.periodFrom === half.from && inv.periodTo === half.to) add(inv);
      }
    }
  }
  return [...out.values()];
}
