import { Prisma } from '@tonyai/db';
import { FILE_FUELS, type EvidenceAssistantLineState, type FileFuel } from '@tonyai/shared-types';
import { sumDecimals } from '../fuel-files/decimal';
import type { ReadInvoiceLine } from './read-invoices';

/**
 * The comparison (inc29-evidence-assistant, design D6): pure, exact decimal
 * arithmetic over the invoice's read lines and the package's current rows. It
 * gives no verdict and stores nothing (B1, B15).
 */

type Litres = Partial<Record<FileFuel, string>>;

export interface ComparisonInput {
  /** As configured: a decimal from 0 to 100. */
  tolerancePercent: string;
  /** The package's invoice, as read. */
  invoiceLines: readonly ReadInvoiceLine[];
  /** The package's own litres per fuel: its `assigned` rows. */
  packageLitres: Litres;
  /**
   * When the invoice's live rows are not all in this package (B10): their sum
   * per fuel across every package, other accounts' and associates' rows
   * included — the figure compared. Null for a package-level comparison.
   */
  invoiceLevelLitres: Litres | null;
  /** The previous and next invoice's difference per fuel, worked out the same way (B8). */
  neighbourDifferences: readonly Litres[];
}

export interface ComparedLine {
  fuel: FileFuel;
  invoiceLitres: string | null;
  packageLitres: string | null;
  invoiceLevelLitres: string | null;
  state: EvidenceAssistantLineState;
  periodShift: boolean;
}

export interface Comparison {
  level: 'package' | 'invoice';
  lines: ComparedLine[];
  otherLines: { product: string; litres: string }[];
}

const dec = (value: string) => new Prisma.Decimal(value);

/** The invoice's litres per fuel; a fuel the invoice prints twice is one line already (`readInvoices`). */
export function invoiceFuelLitres(lines: readonly ReadInvoiceLine[]): Litres {
  const out: Litres = {};
  for (const line of lines) {
    // Exact, and with the precision the invoice prints (`312.80` stays `312.80`).
    if (line.fuel) out[line.fuel] = out[line.fuel] ? sumDecimals([out[line.fuel]!, line.litres]) : line.litres;
  }
  return out;
}

/**
 * The difference a fuel line shows, compared total minus invoice (D6), or null
 * when either side has no figure for the fuel. A neighbour's is worked out by
 * this same function, on its own basis (package or invoice level).
 */
export function lineDifference(compared: string | undefined, invoice: string | undefined): string | null {
  if (compared === undefined || invoice === undefined) return null;
  return dec(compared).minus(invoice).toFixed();
}

export function differences(invoiceLines: readonly ReadInvoiceLine[], compared: Litres): Litres {
  const invoice = invoiceFuelLitres(invoiceLines);
  const out: Litres = {};
  for (const fuel of FILE_FUELS) {
    const d = lineDifference(compared[fuel], invoice[fuel]);
    if (d !== null) out[fuel] = d;
  }
  return out;
}

/** Each fuel line's state: equal; else balanced by a neighbour (period shift); else within the tolerance. */
export function compare(input: ComparisonInput): Comparison {
  const invoice = invoiceFuelLitres(input.invoiceLines);
  const level = input.invoiceLevelLitres ? 'invoice' : 'package';
  const compared = input.invoiceLevelLitres ?? input.packageLitres;
  const share = dec(input.tolerancePercent).dividedBy(100);
  const lines: ComparedLine[] = [];
  for (const fuel of FILE_FUELS) {
    const onInvoice = invoice[fuel];
    const total = compared[fuel];
    const inPackage = input.packageLitres[fuel];
    if (onInvoice === undefined && total === undefined && inPackage === undefined) continue;
    const base = {
      fuel,
      invoiceLitres: onInvoice ?? null,
      packageLitres: inPackage ?? null,
      invoiceLevelLitres: input.invoiceLevelLitres ? (total ?? null) : null,
    };
    const d = lineDifference(total, onInvoice);
    // A fuel on one side only is always a possible difference: neither a
    // neighbour nor the tolerance may hide a missing line (D6).
    if (d === null) {
      lines.push({ ...base, state: 'possible_difference', periodShift: false });
      continue;
    }
    const diff = dec(d);
    if (diff.isZero()) {
      lines.push({ ...base, state: 'consistent', periodShift: false });
      continue;
    }
    // Exactly equal and opposite on the same account's previous or next invoice (B6–B9).
    const shifted = input.neighbourDifferences.some((n) => n[fuel] !== undefined && dec(n[fuel]!).plus(diff).isZero());
    if (shifted) {
      lines.push({ ...base, state: 'consistent', periodShift: true });
      continue;
    }
    // At the tolerance is consistent: the label reads "> tolerans" (B5, C3).
    const within = diff.abs().lessThanOrEqualTo(share.times(onInvoice!));
    lines.push({ ...base, state: within ? 'consistent' : 'possible_difference', periodShift: false });
  }
  const otherLines = input.invoiceLines.filter((l) => l.fuel === null).map((l) => ({ product: l.product, litres: l.litres }));
  return { level, lines, otherLines };
}
