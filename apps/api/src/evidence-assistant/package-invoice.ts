import { Prisma } from '@tonyai/db';
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
 * The figures of a read copy, in the form two copies compare by: each fuel's
 * total by its exact value (`100.0` and `100.00` are one figure), whatever the
 * order its product names were printed in; each other product's line by its
 * folded name and exact value; order aside (review of PR B, fifth round).
 */
const figures = (inv: ReadInvoice) =>
  JSON.stringify(
    inv.lines
      .map((l) => [l.fuel ?? `other:${fold(l.product.trim())}`, new Prisma.Decimal(l.litres).toString()])
      .sort((a, b) => (a.join('|') < b.join('|') ? -1 : a.join('|') > b.join('|') ? 1 : 0)),
  );

/**
 * One entry per invoice number (trimmed, case-folded): copies of one invoice in
 * several files are one, and a read copy wins over one that was not read. Two
 * read copies whose figures differ are both kept — the caller then sees two
 * and answers the manual check, never the figure of whichever file came first
 * (review of PR B, fourth round).
 */
export function collapseCopies<T>(items: readonly T[], invoiceOf: (item: T) => ReadInvoice): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = fold(invoiceOf(item).invoiceNo.trim());
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const out: T[] = [];
  for (const group of groups.values()) {
    const read = group.filter((item) => invoiceOf(item).unreadReason === null);
    if (read.length === 0) {
      out.push(group[0]!);
      continue;
    }
    const distinct = new Map<string, T>();
    for (const item of read) if (!distinct.has(figures(invoiceOf(item)))) distinct.set(figures(invoiceOf(item)), item);
    out.push(...distinct.values());
  }
  return out;
}

/**
 * The read invoices that are this package's (design D6, C9, C10): for Petrol
 * Ofisi the `OZK` invoice whose number is the batch's invoice number (trimmed,
 * case-folded); for Shell the `DAU` invoices whose printed period is exactly the
 * batch's half-month; for a tanker none (C8). Copies are collapsed by
 * `collapseCopies`. The caller treats none, or more than one, as not read.
 */
export function packageInvoices(batch: PackageInvoiceKey, invoices: readonly ReadInvoice[]): ReadInvoice[] {
  let mine: ReadInvoice[] = [];
  if (batch.source === 'petrol_ofisi') {
    const ref = fold(batch.invoiceRef.trim());
    mine = invoices.filter((inv) => inv.series === 'OZK' && fold(inv.invoiceNo.trim()) === ref);
  } else if (batch.source === 'shell') {
    const half = shellHalfMonthDates(batch.invoiceRef);
    if (half) mine = invoices.filter((inv) => inv.series === 'DAU' && inv.periodFrom === half.from && inv.periodTo === half.to);
  }
  return collapseCopies(mine, (inv) => inv);
}
