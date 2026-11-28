/**
 * Synthetic fuel invoice PDFs (inc29-evidence-assistant, design D11). No real
 * company, account code, tax number or invoice: every value is made up for the
 * tests. Buyers are `ÖRNEK … A.Ş.` with an all-zero VKN; numbers are
 * `OZK000…` and `DAU000…`.
 *
 * **The layout itself is this change's assumption.** No real invoice was read to
 * build it (owner, K1 = B, Decisions 2026-11-28): the labels are the documents'
 * (INC-2.9 §4.2 and §5, INC-2.8 §7) — `Fatura No`, `Dönem`, the salutation
 * `Sayın`, `VKN`, the table column `Miktar (lt)` — and their positions are this
 * generator's. QA's run on the real invoices is the first real proof; a
 * difference is a change to `src/evidence-assistant/invoice-layout.ts`.
 *
 * What they hold, so the reader's specs can name it:
 *  - `ozk-single.pdf`: one Petrol Ofisi invoice of one account
 *    (`OZK0000000000002`, WP9's period-shift sale: 1.168,00 L `Motorin Med`),
 *    its period printed as a code that looks like a date (`2025-03-02`), and a
 *    money total under the table;
 *  - `ozk-shared.pdf`: WP9's shared invoice (`OZK0000000000001`): 312,80 L
 *    diesel and 456,21 L petrol, 769,01 L across three accounts in the fuel
 *    fixture, so the two fixture sets agree;
 *  - `ozk-mixed.pdf`: two petrol names and one diesel (`Kurşunsuz 95` 100,00,
 *    `Kurşunsuz 95 Benzin` 50,00, `Motorin Med` 200,00);
 *  - `ozk-adblue.pdf`: `Motorin` 200,00 and `AdBlue` 20,00;
 *  - `ozk-row-above.pdf`: a product name on the row above its quantity;
 *  - `ozk-difference.pdf`: `OZK0000000000002` printing 1.100,00 L where the
 *    fuel fixture's package holds 1.168,00 L — a possible difference (e2e);
 *  - `ozk-three.pdf`: three invoices, one page each: the shared invoice,
 *    `OZK0000000000002` and `OZK0000000000006` (no batch bears it);
 *  - `duman-23.pdf`: 23 `DAU` invoices of one Shell account, one per
 *    half-month from January's first to December's first; February's first
 *    half is INC-2.9 §5's example (7.502,66 L motorin), June's first half runs
 *    over two pages, and March's two halves are a period-shift pair against the
 *    fuel fixture's Shell account `0071234` (the 31,86 L fill of 15 March on the
 *    second half's invoice: 80,00 and 119,22 L against packages of 111,86 and
 *    87,36 L); April's first half is its 1.168,00 L of petrol;
 *  - `no-text.pdf`: a page of drawn shapes and no text (a scan's stand-in);
 *  - `encrypted.pdf`: an invoice behind a user password. Encryption is random,
 *    so it is written once (`--encrypted`) and checked by the reader's outcome,
 *    not by its bytes.
 *
 * Deterministic: no dates, a fixed producer, a named font subset (pdf-lib
 * otherwise adds a random suffix), no object streams — two runs write the same
 * bytes (`invoice-fixtures.spec.ts`). The font is read at generation time from
 * `pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf` (it has ı İ ş ğ;
 * nothing is copied into the repository; its licence allows embedding).
 * Run with `node apps/api/test/fixtures/invoices/generate.ts` (Node 22) to
 * rewrite them.
 */
import fontkit from '@cantoo/fontkit';
import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  beginText,
  drawObject,
  endText,
  moveText,
  setFontAndSize,
  showText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFPage,
} from '@cantoo/pdf-lib';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const FIXTURE_PRODUCER = 'TonyAI synthetic test fixture (not a real invoice)';
export const FIXTURE_TITLE = 'Synthetic fuel invoice for tests; the layout is an assumption';
export const ENCRYPTED_FIXTURE = 'encrypted.pdf';
export const ENCRYPTED_PASSWORD = 'synthetic-fixture';

export const SHARED_INVOICE = 'OZK0000000000001';
export const SINGLE_INVOICE = 'OZK0000000000002';
export const MIXED_INVOICE = 'OZK0000000000003';
export const ADBLUE_INVOICE = 'OZK0000000000004';
export const ROW_ABOVE_INVOICE = 'OZK0000000000005';
export const UNBATCHED_INVOICE = 'OZK0000000000006';
/** The Shell account the `DAU` invoices are written for (the fuel fixture's account A). */
export const DUMAN_ACCOUNT = '0071234';
export const DUMAN_INVOICES = 23;
/** One-based position of the two-page invoice in `duman-23.pdf`: June's first half. */
export const DUMAN_TWO_PAGE_INDEX = 11;

/** One invoice line as printed: the product and its `Miktar (lt)` in Turkish format. */
export interface FixtureLine {
  product: string | null;
  /** Decimal string with a dot (`7502.66`); printed in Turkish format. */
  litres: string | null;
}

export interface FixtureInvoice {
  invoiceNo: string;
  issued: string;
  period: string;
  buyer: string;
  lines: FixtureLine[];
  /** Lines per page; an invoice longer than one page repeats its head on each page. */
  pageBreakAfter?: number;
}

/** `7502.66` → `7.502,66`, the Turkish number format the documents print. */
export function trNumber(decimal: string): string {
  const [whole, fraction] = decimal.split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return fraction === undefined ? grouped : `${grouped},${fraction}`;
}

const UNIT_PRICE = '42.10';
const amount = (litres: string) => (Math.round(Number(litres) * Number(UNIT_PRICE) * 100) / 100).toFixed(2);

// ── Layout (A4, points from the bottom left) ────────────────────────────────

const X_LABEL = 40;
const X_VALUE = 110;
const X_PRODUCT = 40;
const X_QUANTITY = 260;
const X_PRICE = 360;
const X_AMOUNT = 460;
const Y_TABLE = 620;
const ROW = 16;

function drawHead(page: PDFPage, font: PDFFont, inv: FixtureInvoice, pageNo: number, pages: number): void {
  const text = (s: string, x: number, y: number, size = 10) => page.drawText(s, { x, y, size, font });
  text('SYNTHETIC TEST FIXTURE - NOT A REAL INVOICE', X_LABEL, 810, 8);
  text('e-FATURA', X_LABEL, 780, 14);
  text('Fatura No:', X_LABEL, 750);
  text(inv.invoiceNo, X_VALUE, 750);
  text('Fatura Tarihi:', X_LABEL, 735);
  text(inv.issued, X_VALUE, 735);
  text('Dönem:', X_LABEL, 720);
  text(inv.period, X_VALUE, 720);
  text('Sayın', X_LABEL, 690);
  text(inv.buyer, X_LABEL + 32, 690);
  text('Örnek Mah. Test Sok. No: 0, Örnek İlçe', X_LABEL, 676);
  text('VKN:', X_LABEL, 662);
  text('0000000000', X_LABEL + 28, 662);
  text('Ürün', X_PRODUCT, Y_TABLE);
  text('Miktar (lt)', X_QUANTITY, Y_TABLE);
  text('Birim Fiyat', X_PRICE, Y_TABLE);
  text('Tutar (TL)', X_AMOUNT, Y_TABLE);
  text(`Sayfa ${pageNo}/${pages}`, X_LABEL, 60, 8);
}

function drawInvoice(doc: PDFDocument, font: PDFFont, inv: FixtureInvoice): void {
  const perPage = inv.pageBreakAfter ?? inv.lines.length;
  const chunks: FixtureLine[][] = [];
  for (let i = 0; i < inv.lines.length; i += perPage) chunks.push(inv.lines.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);
  chunks.forEach((lines, index) => {
    const page = doc.addPage([595.28, 841.89]);
    drawHead(page, font, inv, index + 1, chunks.length);
    let y = Y_TABLE - 20;
    for (const line of lines) {
      if (line.product !== null) page.drawText(line.product, { x: X_PRODUCT, y, size: 10, font });
      if (line.litres !== null) {
        page.drawText(trNumber(line.litres), { x: X_QUANTITY, y, size: 10, font });
        page.drawText(trNumber(UNIT_PRICE), { x: X_PRICE, y, size: 10, font });
        page.drawText(trNumber(amount(line.litres)), { x: X_AMOUNT, y, size: 10, font });
      }
      y -= ROW;
    }
    if (index === chunks.length - 1) {
      // The money total under the table: never litres.
      const total = inv.lines.reduce((sum, l) => sum + (l.litres === null ? 0 : Math.round(Number(amount(l.litres)) * 100)), 0);
      page.drawText('Genel Toplam', { x: X_PRODUCT, y: y - 4, size: 10, font });
      page.drawText(trNumber((total / 100).toFixed(2)), { x: X_AMOUNT, y: y - 4, size: 10, font });
    }
  });
}

// ── Contents ────────────────────────────────────────────────────────────────

const BUYER_PO = 'ÖRNEK TAŞIMACILIK A.Ş.';
const BUYER_SHELL = 'ÖRNEK LOJİSTİK A.Ş.';

export const sharedInvoice = (): FixtureInvoice => ({
  invoiceNo: SHARED_INVOICE,
  issued: '16.03.2025',
  period: '01.03.2025 - 15.03.2025',
  buyer: BUYER_PO,
  lines: [
    { product: 'Motorin Diesel', litres: '312.80' },
    { product: 'Kurşunsuz 95 V/Max', litres: '456.21' },
  ],
});

export const singleInvoice = (): FixtureInvoice => ({
  invoiceNo: SINGLE_INVOICE,
  issued: '01.04.2025',
  // Petrol Ofisi's `Dönem` is a half-month code that reads like a date (INC-2.9 §3.4).
  period: '2025-03-02',
  buyer: BUYER_PO,
  lines: [{ product: 'Motorin Med', litres: '1168.00' }],
});

export const mixedInvoice = (): FixtureInvoice => ({
  invoiceNo: MIXED_INVOICE,
  issued: '01.04.2025',
  period: '16.03.2025 - 31.03.2025',
  buyer: 'ÖRNEK METAL A.Ş.',
  lines: [
    { product: 'Kurşunsuz 95', litres: '100.00' },
    { product: 'Kurşunsuz 95 Benzin', litres: '50.00' },
    { product: 'Motorin Med', litres: '200.00' },
  ],
});

const adblueInvoice = (): FixtureInvoice => ({
  invoiceNo: ADBLUE_INVOICE,
  issued: '01.04.2025',
  period: '16.03.2025 - 31.03.2025',
  buyer: 'ÖRNEK METAL A.Ş.',
  lines: [
    { product: 'Motorin', litres: '200.00' },
    { product: 'AdBlue', litres: '20.00' },
  ],
});

const rowAboveInvoice = (): FixtureInvoice => ({
  invoiceNo: ROW_ABOVE_INVOICE,
  issued: '01.04.2025',
  period: '16.03.2025 - 31.03.2025',
  buyer: 'ÖRNEK METAL A.Ş.',
  lines: [
    { product: 'Kurşunsuz 95', litres: '60.00' },
    // A product name with no quantity, and below it a quantity with no product.
    { product: 'Motorin Med', litres: null },
    { product: null, litres: '150.00' },
  ],
});

export const unbatchedInvoice = (): FixtureInvoice => ({
  invoiceNo: UNBATCHED_INVOICE,
  issued: '01.05.2025',
  period: '01.04.2025 - 15.04.2025',
  buyer: BUYER_PO,
  lines: [{ product: 'Motorin Med', litres: '75.25' }],
});

const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDay = (month: number) => new Date(Date.UTC(2025, month, 0)).getUTCDate();

/** Half-month `i` (0-based) from January's first: its period as two dates. */
function halfMonth(i: number): { from: string; to: string; ref: string } {
  const month = Math.floor(i / 2) + 1;
  const half = (i % 2) + 1;
  const fromDay = half === 1 ? 1 : 16;
  const toDay = half === 1 ? 15 : lastDay(month);
  return { from: `${pad2(fromDay)}.${pad2(month)}.2025`, to: `${pad2(toDay)}.${pad2(month)}.2025`, ref: `2025-${pad2(month)}-${half}` };
}

/** The Shell half-month reference each `DAU` invoice is for, in order. */
export const DUMAN_REFS: string[] = Array.from({ length: DUMAN_INVOICES }, (_, i) => halfMonth(i).ref);

/** The `DAU` invoice number of half-month `i` (0-based). */
export const dumanInvoiceNo = (i: number) => `DAU${String(i + 1).padStart(13, '0')}`;

export function dumanInvoices(): FixtureInvoice[] {
  return Array.from({ length: DUMAN_INVOICES }, (_, i) => {
    const hm = halfMonth(i);
    let lines: FixtureLine[] = [{ product: 'Motorin Med', litres: `${1000 + i * 37}.${pad2((i * 13) % 100)}` }];
    if (hm.ref === '2025-02-1') lines = [{ product: 'Motorin Med', litres: '7502.66' }];
    // The 31,86 L fill of 15 March (first half) is on the second half's invoice.
    if (hm.ref === '2025-03-1') lines = [{ product: 'Motorin Med', litres: '80.00' }];
    if (hm.ref === '2025-03-2') lines = [{ product: 'Motorin Med', litres: '119.22' }];
    if (hm.ref === '2025-04-1') lines = [{ product: 'Kurşunsuz 95 - Shell Vp', litres: '1168.00' }];
    const twoPages = i + 1 === DUMAN_TWO_PAGE_INDEX;
    if (twoPages) {
      lines = [
        { product: 'Motorin Med', litres: '410.00' },
        { product: 'Motorin Ultimate', litres: '120.50' },
        { product: 'Kurşunsuz 95 - Shell Vp', litres: '88.40' },
        { product: 'Motorin Med', litres: '33.10' },
      ];
    }
    const issuedMonth = hm.ref.endsWith('-1') ? Number(hm.ref.slice(5, 7)) : Number(hm.ref.slice(5, 7)) + 1;
    return {
      invoiceNo: dumanInvoiceNo(i),
      issued: hm.ref.endsWith('-1') ? `16.${pad2(issuedMonth)}.2025` : `01.${pad2(issuedMonth)}.2025`,
      period: `${hm.from} - ${hm.to}`,
      buyer: BUYER_SHELL,
      lines,
      pageBreakAfter: twoPages ? 2 : undefined,
    };
  });
}

// ── Documents ───────────────────────────────────────────────────────────────

// `__filename` under the test runner; the script's own path when Node runs it as a module.
const requireHere = createRequire(typeof __filename === 'string' ? __filename : (process.argv[1] ?? process.cwd()));

function fontBytes(): Uint8Array {
  const pkg = requireHere.resolve('pdfjs-dist/package.json');
  return readFileSync(join(dirname(pkg), 'standard_fonts', 'LiberationSans-Regular.ttf'));
}

async function newDocument(): Promise<{ doc: PDFDocument; font: PDFFont }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  doc.setProducer(FIXTURE_PRODUCER);
  doc.setCreator(FIXTURE_PRODUCER);
  doc.setTitle(FIXTURE_TITLE);
  const font = await doc.embedFont(fontBytes(), { subset: true, customName: 'FixtureSans' });
  return { doc, font };
}

/** A PDF of `invoices`, one after another, in the fixtures' layout (specs build variants with it). */
export async function invoicesPdf(invoices: FixtureInvoice[]): Promise<Buffer> {
  const { doc, font } = await newDocument();
  for (const inv of invoices) drawInvoice(doc, font, inv);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function noTextPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setProducer(FIXTURE_PRODUCER);
  doc.setCreator(FIXTURE_PRODUCER);
  doc.setTitle(FIXTURE_TITLE);
  const page = doc.addPage([595.28, 841.89]);
  // A scanned page's stand-in: shapes where the text would be, and no text.
  page.drawRectangle({ x: 40, y: 740, width: 200, height: 14, color: rgb(0.2, 0.2, 0.2) });
  for (let row = 0; row < 8; row += 1) {
    page.drawRectangle({ x: 40, y: 600 - row * 16, width: 480, height: 8, color: rgb(0.6, 0.6, 0.6) });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

export async function buildInvoiceFixtures(): Promise<Record<string, Buffer>> {
  return {
    'ozk-single.pdf': await invoicesPdf([singleInvoice()]),
    'ozk-shared.pdf': await invoicesPdf([sharedInvoice()]),
    'ozk-mixed.pdf': await invoicesPdf([mixedInvoice()]),
    'ozk-adblue.pdf': await invoicesPdf([adblueInvoice()]),
    'ozk-row-above.pdf': await invoicesPdf([rowAboveInvoice()]),
    'ozk-difference.pdf': await invoicesPdf([{ ...singleInvoice(), lines: [{ product: 'Motorin Med', litres: '1100.00' }] }]),
    'ozk-three.pdf': await invoicesPdf([sharedInvoice(), singleInvoice(), unbatchedInvoice()]),
    'duman-23.pdf': await invoicesPdf(dumanInvoices()),
    'no-text.pdf': await noTextPdf(),
  };
}

/** A PDF of `pages` one-page invoices, for the reader's limits and measurement (task 2.4). */
export async function buildManyPagePdf(pages: number): Promise<Buffer> {
  const invoices = Array.from({ length: pages }, (_, i) => ({
    ...singleInvoice(),
    invoiceNo: `OZK${String(100000 + i).padStart(13, '0')}`,
  }));
  return invoicesPdf(invoices);
}

/**
 * A three-invoice PDF built to leak across a cut (task 7.2; built at test time,
 * never committed — its resource names are random): every page shares ONE
 * resource dictionary holding each invoice's own form XObject (a stamp printing
 * that invoice's number), each page draws only its own stamp, each page links to
 * the second page, the document carries an attached file, and the catalogue and
 * every page carry XMP metadata. A part must hold none of the others' objects.
 */
export async function buildHostileSplitPdf(): Promise<Buffer> {
  const { doc, font } = await newDocument();
  const invoices = [sharedInvoice(), singleInvoice(), unbatchedInvoice()];
  for (const inv of invoices) drawInvoice(doc, font, inv);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const { context } = doc;
  const pages = doc.getPages();
  const fonts = context.obj({});
  for (const page of pages) {
    const own = page.node.Resources()?.lookup(PDFName.of('Font'));
    if (own && 'entries' in own) for (const [key, value] of (own as unknown as { entries(): [PDFName, unknown][] }).entries()) fonts.set(key, value as never);
  }
  const stamps = context.obj({});
  invoices.forEach((inv, i) => {
    const stamp = context.formXObject(
      [
        pushGraphicsState(), beginText(), setFontAndSize('H', 9), moveText(300, 790),
        showText(helvetica.encodeText(`STAMP ${inv.invoiceNo}`)), endText(), popGraphicsState(),
      ],
      { BBox: [0, 0, 595, 842], Resources: { Font: { H: helvetica.ref } } },
    );
    stamps.set(PDFName.of(`Stamp${i}`), context.register(stamp));
  });
  const xmp = context.register(context.stream('<x:xmpmeta xmlns:x="adobe:ns:meta/">synthetic</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }));
  const shared = context.register(context.obj({ Font: fonts, XObject: stamps }));
  pages.forEach((page, i) => {
    page.pushOperators(pushGraphicsState(), drawObject(`Stamp${i}`), popGraphicsState());
    page.node.set(PDFName.of('Resources'), shared);
    const link = context.register(context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [40, 40, 140, 60], Border: [0, 0, 0],
      Dest: [pages[1]!.ref, PDFName.of('Fit')],
    }));
    page.node.set(PDFName.of('Annots'), context.obj([link]));
    page.node.set(PDFName.of('Metadata'), xmp);
  });
  doc.catalog.set(PDFName.of('Metadata'), xmp);
  await doc.attach(Buffer.from('another company’s data'), 'other-invoice.txt', { mimeType: 'text/plain', description: 'attached file' });
  doc.catalog.set(PDFName.of('OpenAction'), context.obj({ S: 'URI', URI: PDFString.of('https://example.invalid/') }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** The encrypted fixture: random by nature, so written only when asked for. */
export async function buildEncryptedFixture(): Promise<Buffer> {
  const { doc, font } = await newDocument();
  drawInvoice(doc, font, singleInvoice());
  doc.encrypt({ userPassword: ENCRYPTED_PASSWORD, ownerPassword: ENCRYPTED_PASSWORD });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Writes the fixtures beside this script: `node apps/api/test/fixtures/invoices/generate.ts` (Node 22). */
export async function writeInvoiceFixtures(dir: string, encrypted: boolean): Promise<string[]> {
  const files = await buildInvoiceFixtures();
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  const names = Object.keys(files);
  if (encrypted || !existsSync(join(dir, ENCRYPTED_FIXTURE))) {
    writeFileSync(join(dir, ENCRYPTED_FIXTURE), await buildEncryptedFixture());
    names.push(ENCRYPTED_FIXTURE);
  }
  return names;
}

const entry = process.argv[1] ?? '';
if (entry.endsWith(join('fixtures', 'invoices', 'generate.ts'))) {
  void writeInvoiceFixtures(dirname(entry), process.argv.includes('--encrypted')).then((names) => {
    process.stdout.write(`wrote ${names.length} fixtures to ${dirname(entry)}\n`);
  });
}
