import { recogniseFuel, type FileFuel } from '@tonyai/shared-types';
import { sumDecimals } from '../fuel-files/decimal';
import { readQuantity } from '../fuel-files/adapters/cells';
import {
  INVOICE_NUMBER,
  LABELS,
  PERIOD_RANGE,
  TABLE_END,
  TAX_ID,
  TAX_ID_ROWS_BELOW_BUYER,
  foldChar,
  isInvoiceSeries,
} from './invoice-layout';
import type { ReaderItem, ReaderPage } from './pdf-reader.service';

/**
 * Reading a fuel invoice is a pure function over positioned text
 * (inc29-evidence-assistant, design D2): no I/O, so it is tested without a PDF.
 * It reads only what it is sure of; anything else leaves an invoice unread, and
 * an unsure page structure leaves the whole document unsplit.
 */

/** Why one invoice of a read document has no figures. */
export type InvoiceUnreadReason = 'unknown_series' | 'unreadable' | 'unreadable_row';

/** A line of a read invoice: a fuel's total, or a product the fuel-name rule does not name (B12). */
export interface ReadInvoiceLine {
  /** The product text as printed; for a fuel's total, each distinct name, joined by ` + `. */
  product: string;
  fuel: FileFuel | null;
  /** A plain decimal string: stored and compared exactly (B9). */
  litres: string;
}

/** One invoice as stored in `evidence_readings.invoices` (D3). */
export interface ReadInvoice {
  invoiceNo: string;
  /** The number's first three characters; `OZK` and `DAU` are read, any other is `unknown_series`. */
  series: string;
  periodText: string | null;
  /** ISO dates, set only when the period is printed as two dates (B14). */
  periodFrom: string | null;
  periodTo: string | null;
  buyerName: string | null;
  buyerTaxId: string | null;
  /** One-based, inclusive, in the file read. */
  pageFrom: number;
  pageTo: number;
  unreadReason: InvoiceUnreadReason | null;
  lines: ReadInvoiceLine[];
}

export interface ReadInvoicesResult {
  invoices: ReadInvoice[];
  /** Per page (zero-based), the invoice number that owns it, or null. */
  pageOwner: (string | null)[];
  /**
   * Whether the document may be split and its parts routed: two or more
   * invoices, every page owned, each invoice's pages contiguous, no unknown or
   * ambiguous invoice header (D2).
   */
  routable: boolean;
}

// ── Rows ────────────────────────────────────────────────────────────────────

interface RowChar {
  /** Folded character (`foldChar`). */
  f: string;
  /** The character as printed. */
  c: string;
  /** Estimated horizontal centre. */
  x: number;
}

interface Row {
  y: number;
  chars: RowChar[];
  /** Folded text, one character per entry of `chars`. */
  folded: string;
}

function toRow(items: ReaderItem[]): Row {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const chars: RowChar[] = [];
  let end = -Infinity;
  for (const item of sorted) {
    const glyphs = [...item.s];
    const step = glyphs.length > 0 ? item.w / glyphs.length : 0;
    // pdf.js may merge two close cells into one item or split one word into
    // several: the row is read as one string of positioned characters.
    if (chars.length > 0 && item.x - end > Math.max(0.5, item.h * 0.15)) {
      chars.push({ f: ' ', c: ' ', x: (end + item.x) / 2 });
    }
    glyphs.forEach((ch, i) => {
      for (const part of ch.normalize('NFC')) {
        const f = foldChar(part);
        if (f === '') continue;
        chars.push({ f, c: part, x: item.x + step * (i + 0.5) });
      }
    });
    end = Math.max(end, item.x + item.w);
  }
  return { y: sorted[0]?.y ?? 0, chars, folded: chars.map((c) => c.f).join('') };
}

/** Items clustered on their baseline, top to bottom; a skewed item is ignored (D2). */
function rowsOf(page: ReaderPage): Row[] {
  const items = page.items.filter((i) => !i.k && i.s.trim() !== '').sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: ReaderItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    const tolerance = Math.max(1.5, item.h * 0.3);
    if (last && Math.abs(last[0]!.y - item.y) <= tolerance) last.push(item);
    else groups.push([item]);
  }
  return groups.map(toRow);
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The printed text of `row` from character `from` (inclusive) to `to` (exclusive). */
function slice(row: Row, from: number, to = row.chars.length): string {
  return squash(row.chars.slice(from, to).map((c) => c.c).join(''));
}

/** The index just past `label` in `row`, or -1. */
function after(row: Row, label: RegExp): number {
  const match = label.exec(row.folded);
  return match ? match.index + match[0].length : -1;
}

// ── Invoice headers ─────────────────────────────────────────────────────────

interface PageFacts {
  rows: Row[];
  /** Well-formed invoice numbers printed after `Fatura No` on the page. */
  numbers: string[];
  /** A `Fatura No` whose number is not of the e-invoice shape. */
  unknownHeader: boolean;
  /** `Sayfa k/n`. */
  pageMark: { k: number; n: number } | null;
  /** The `Miktar (lt)` header, if the page prints one. */
  header: { y: number; left: number; right: number } | null;
  /** More than one `Miktar (lt)` header: a second table whose column may differ. */
  headers: number;
}

function quantityHeader(row: Row): { y: number; left: number; right: number } | null {
  const match = LABELS.quantity.exec(row.folded);
  if (!match) return null;
  const start = match.index;
  const stop = start + match[0].length;
  let before = -1;
  for (let i = start - 1; i >= 0; i -= 1) if (row.chars[i]!.f !== ' ') { before = i; break; }
  let next = -1;
  for (let i = stop; i < row.chars.length; i += 1) if (row.chars[i]!.f !== ' ') { next = i; break; }
  const x0 = row.chars[start]!.x;
  const x1 = row.chars[stop - 1]!.x;
  const width = x1 - x0;
  // The column reaches left to half the header's width before it, or halfway to
  // the header on its left if that is nearer, and right halfway to the next one.
  const left = Math.max(before >= 0 ? (row.chars[before]!.x + x0) / 2 : -Infinity, x0 - width / 2);
  const right = next >= 0 ? (x1 + row.chars[next]!.x) / 2 : x1 + width;
  return { y: row.y, left, right };
}

/** Words of a row: runs of non-blank characters with their centre. */
function words(row: Row): Array<{ from: number; to: number; x: number }> {
  const out: Array<{ from: number; to: number; x: number }> = [];
  let from = -1;
  row.chars.forEach((ch, i) => {
    if (ch.f !== ' ' && from < 0) from = i;
    if ((ch.f === ' ' || i === row.chars.length - 1) && from >= 0) {
      const to = ch.f === ' ' ? i : i + 1;
      const chars = row.chars.slice(from, to);
      out.push({ from, to, x: chars.reduce((sum, c) => sum + c.x, 0) / chars.length });
      from = -1;
    }
  });
  return out;
}

function pageFacts(page: ReaderPage): PageFacts {
  const rows = rowsOf(page);
  const numbers: string[] = [];
  let unknownHeader = false;
  let pageMark: PageFacts['pageMark'] = null;
  let header: PageFacts['header'] = null;
  let headers = 0;
  for (const row of rows) {
    const at = after(row, LABELS.invoiceNo);
    if (at >= 0) {
      const token = slice(row, at).split(' ')[0] ?? '';
      const upper = token.replace(/[:.]$/, '');
      if (INVOICE_NUMBER.test(upper)) {
        if (!numbers.includes(upper)) numbers.push(upper);
      } else {
        unknownHeader = true;
      }
    }
    const mark = LABELS.page.exec(row.folded);
    if (mark && !pageMark) pageMark = { k: Number(mark[1]), n: Number(mark[2]) };
    const found = quantityHeader(row);
    if (found) headers += 1;
    header ??= found;
  }
  return { rows, numbers, unknownHeader, pageMark, header, headers };
}

// ── One invoice's figures ───────────────────────────────────────────────────

function isoDate(dd: string, mm: string, yyyy: string): string | null {
  const [d, m, y] = [Number(dd), Number(mm), Number(yyyy)];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${yyyy}-${mm}-${dd}` : null;
}

function readPeriod(text: string): { periodFrom: string | null; periodTo: string | null } {
  const match = PERIOD_RANGE.exec(text);
  if (!match) return { periodFrom: null, periodTo: null };
  const from = isoDate(match[1]!, match[2]!, match[3]!);
  const to = isoDate(match[4]!, match[5]!, match[6]!);
  return from && to && from <= to ? { periodFrom: from, periodTo: to } : { periodFrom: null, periodTo: null };
}

interface Details {
  periodText: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  buyerName: string | null;
  buyerTaxId: string | null;
}

function readDetails(pages: PageFacts[]): Details {
  const out: Details = { periodText: null, periodFrom: null, periodTo: null, buyerName: null, buyerTaxId: null };
  for (const page of pages) {
    page.rows.forEach((row, index) => {
      if (out.periodText === null) {
        const at = after(row, LABELS.period);
        const text = at >= 0 ? slice(row, at) : '';
        if (text !== '') Object.assign(out, { periodText: text }, readPeriod(text));
      }
      if (out.buyerName === null) {
        const at = after(row, LABELS.buyer);
        if (at >= 0) {
          // "Sayın" is a salutation, not data (INC-2.8 §3.1): the name follows it.
          const name = slice(row, at).replace(/^[,:]\s*/, '');
          out.buyerName = name !== '' ? name : (page.rows[index + 1] ? slice(page.rows[index + 1]!, 0) : '') || null;
          for (const below of page.rows.slice(index, index + 1 + TAX_ID_ROWS_BELOW_BUYER)) {
            const vkn = after(below, LABELS.taxId);
            const digits = vkn >= 0 ? TAX_ID.exec(slice(below, vkn)) : null;
            if (digits) {
              out.buyerTaxId = digits[1]!;
              break;
            }
          }
        }
      }
    });
  }
  return out;
}

type Figures = { lines: ReadInvoiceLine[] } | { unread: 'unreadable' | 'unreadable_row' };

/** The fuel rows of an invoice's pages: product and quantity from one table row only (D2, B13). */
function readFigures(pages: PageFacts[]): Figures {
  let column: PageFacts['header'] = null;
  const fuels = new Map<FileFuel, { names: string[]; litres: string[] }>();
  const others = new Map<string, { product: string; litres: string[] }>();
  let rows = 0;
  for (const [index, page] of pages.entries()) {
    // A second table on a page may have its column elsewhere: not read (qa-auditor re-review, P2).
    if (page.headers > 1) return { unread: 'unreadable' };
    // A page without its own header continues the column of the page before.
    const header = page.header ?? (column ? { ...column, y: Infinity } : null);
    if (!header) continue;
    column = header;
    let ended = false;
    for (const row of page.rows) {
      if (row.y >= header.y - 1) {
        // Above a later page's header, a figure in the column may be a row the
        // header was repeated below: not read rather than read short.
        if (index > 0 && words(row).some((w) => w.x >= header.left && w.x < header.right && readQuantity({ column: 0, kind: 'text', value: slice(row, w.from, w.to) }) !== null)) {
          return { unread: 'unreadable' };
        }
        continue;
      }
      // Product and quantity by word: a word left of the column is the
      // product's, a word in it the quantity's, one right of it money.
      let productEnd = 0;
      const quantityWords: string[] = [];
      for (const word of words(row)) {
        if (word.x < header.left) productEnd = word.to;
        else if (word.x < header.right) quantityWords.push(slice(row, word.from, word.to));
      }
      const product = slice(row, 0, productEnd);
      const quantity = quantityWords.join(' ');
      const qty = squash(quantity);
      // A total row is never a fuel row. Past it, a figure in the quantity
      // column means the total was a subtotal and the table goes on: the
      // invoice is not read rather than read short (qa-auditor review, P2).
      if (TABLE_END.test(row.folded.slice(0, productEnd).trim())) {
        ended = true;
        continue;
      }
      if (qty === '') continue;
      // Past a total, only a row shaped like a fuel row (a product and a
      // number) says the table went on; a footer's `Yalnız`, IBAN or tax line
      // does not (qa-auditor re-review, P2).
      if (ended) {
        if (product !== '' && readQuantity({ column: 0, kind: 'text', value: qty }) !== null) return { unread: 'unreadable_row' };
        continue;
      }
      // A quantity whose product is not on its own row: never borrowed from a neighbour.
      if (product === '') return { unread: 'unreadable_row' };
      const litres = readQuantity({ column: 0, kind: 'text', value: qty });
      if (litres === null) return { unread: 'unreadable_row' };
      rows += 1;
      const fuel = recogniseFuel(product);
      if (fuel) {
        const entry = fuels.get(fuel) ?? { names: [], litres: [] };
        if (!entry.names.includes(product)) entry.names.push(product);
        entry.litres.push(litres);
        fuels.set(fuel, entry);
      } else {
        const key = product.split('').map(foldChar).join('');
        const entry = others.get(key) ?? { product, litres: [] };
        entry.litres.push(litres);
        others.set(key, entry);
      }
    }
  }
  if (!column || rows === 0) return { unread: 'unreadable' };
  const lines: ReadInvoiceLine[] = [];
  for (const fuel of ['diesel', 'petrol'] as const) {
    const entry = fuels.get(fuel);
    if (entry) lines.push({ product: entry.names.join(' + '), fuel, litres: sumDecimals(entry.litres) });
  }
  for (const entry of others.values()) lines.push({ product: entry.product, fuel: null, litres: sumDecimals(entry.litres) });
  return { lines };
}

/**
 * Whether the unowned pages after an invoice's pages (up to the next page that
 * prints a number) may hold its rows: one prints a quantity header, or holds a
 * row shaped like a fuel row — a product and a number in the invoice's
 * quantity column. Either way the invoice is not read, never read short (D2;
 * qa-auditor review and re-review of PR B).
 */
function mayHoldRows(facts: PageFacts[], own: number[], next: number): boolean {
  const column = own.map((i) => facts[i]!.header).filter((h): h is NonNullable<PageFacts['header']> => h !== null).pop();
  for (let i = next; i < facts.length; i += 1) {
    const page = facts[i]!;
    if (page.numbers.length > 0) return false;
    if (page.header) return true;
    if (!column) continue;
    const rowShaped = page.rows.some((row) => {
      const all = words(row);
      const inColumn = all.filter((w) => w.x >= column.left && w.x < column.right);
      const before = all.some((w) => w.x < column.left);
      return before && inColumn.some((w) => readQuantity({ column: 0, kind: 'text', value: slice(row, w.from, w.to) }) !== null);
    });
    if (rowShaped) return true;
  }
  return false;
}

// ── The document ────────────────────────────────────────────────────────────

export function readInvoices(pages: ReaderPage[]): ReadInvoicesResult {
  const facts = pages.map(pageFacts);
  const pageOwner: (string | null)[] = [];
  let ambiguous = false;
  facts.forEach((page, i) => {
    if (page.unknownHeader) ambiguous = true;
    if (page.numbers.length > 1) {
      ambiguous = true;
      pageOwner.push(null);
      return;
    }
    if (page.numbers.length === 1) {
      pageOwner.push(page.numbers[0]!);
      return;
    }
    // A numberless page continues the invoice before it only on positive
    // evidence: it prints `Sayfa k/n` and the page before printed `Sayfa k-1/n`.
    const prev = facts[i - 1];
    const owner = pageOwner[i - 1] ?? null;
    const continues =
      owner !== null && page.pageMark !== null && prev?.pageMark != null &&
      page.pageMark.k >= 2 && page.pageMark.n === prev.pageMark.n && prev.pageMark.k === page.pageMark.k - 1;
    pageOwner.push(continues ? owner : null);
  });

  // Each number's pages, in order; a number that comes back after another is not contiguous.
  const order: string[] = [];
  const pagesOf = new Map<string, number[]>();
  pageOwner.forEach((owner, i) => {
    if (owner === null) return;
    if (!pagesOf.has(owner)) {
      order.push(owner);
      pagesOf.set(owner, []);
    }
    pagesOf.get(owner)!.push(i);
  });
  // Numbers printed on an ambiguous page are invoices too, though no page is theirs alone.
  facts.forEach((page) => page.numbers.forEach((n) => {
    if (!pagesOf.has(n)) {
      order.push(n);
      pagesOf.set(n, []);
    }
  }));

  let contiguous = true;
  const invoices: ReadInvoice[] = order.map((invoiceNo) => {
    const own = pagesOf.get(invoiceNo)!;
    const isContiguous = own.length > 0 && own[own.length - 1]! - own[0]! === own.length - 1;
    const onAmbiguousPage = facts.some((p) => p.numbers.length > 1 && p.numbers.includes(invoiceNo));
    // An unowned page right after this invoice's pages that prints a quantity
    // header may hold its rows: never read a partial total from it.
    const next = own.length > 0 ? own[own.length - 1]! + 1 : -1;
    const spill = next >= 0 && next < facts.length && pageOwner[next] === null && mayHoldRows(facts, own, next);
    if (!isContiguous) contiguous = false;
    const series = invoiceNo.slice(0, 3);
    const base = {
      invoiceNo,
      series,
      pageFrom: own.length > 0 ? own[0]! + 1 : 0,
      pageTo: own.length > 0 ? own[own.length - 1]! + 1 : 0,
    };
    const details = readDetails(own.map((i) => facts[i]!));
    if (!isInvoiceSeries(series)) return { ...base, ...details, unreadReason: 'unknown_series', lines: [] };
    if (!isContiguous || onAmbiguousPage || spill) return { ...base, ...details, unreadReason: 'unreadable', lines: [] };
    const figures = readFigures(own.map((i) => facts[i]!));
    if ('unread' in figures) return { ...base, ...details, unreadReason: figures.unread, lines: [] };
    return { ...base, ...details, unreadReason: null, lines: figures.lines };
  });

  const routable =
    invoices.length >= 2 && !ambiguous && contiguous && pageOwner.every((o) => o !== null) &&
    invoices.every((inv) => isInvoiceSeries(inv.series));
  return { invoices, pageOwner, routable };
}
