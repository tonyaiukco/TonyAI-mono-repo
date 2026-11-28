import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildManyPagePdf, dumanInvoiceNo } from '../../test/fixtures/invoices/generate';
import { PdfReaderService, READER_WORKER_PATH, type ReaderPage, type TextOutcome } from './pdf-reader.service';

/**
 * inc29-evidence-assistant task 2.3: the reader forks the real worker on the
 * committed fixtures. These specs spawn processes, so they run one reader per
 * describe and keep their files small.
 */

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'invoices');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const joined = (pages: ReaderPage[]) => pages.map((p) => p.items.map((i) => i.s).join(' ')).join('\n');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const textOf = (outcome: TextOutcome | { refused: string }) => {
  if ('refused' in outcome) throw new Error(`refused: ${outcome.refused}`);
  if (outcome.kind !== 'text') throw new Error(`not text: ${JSON.stringify(outcome)}`);
  return outcome;
};

describe('PdfReaderService (the real worker)', () => {
  const pids: number[] = [];
  const reader = new PdfReaderService({ onSpawn: (pid) => pids.push(pid) });

  beforeAll(async () => {
    expect(await reader.start()).toBe('available');
  }, 30_000);

  afterAll(() => reader.onModuleDestroy());

  it('reads positioned text with Turkish letters from an OZK fixture', async () => {
    const out = textOf(await reader.withSession(20_000, (s) => s.text(fixture('ozk-shared.pdf'))));
    expect(out.pageCount).toBe(1);
    const text = joined(out.pages);
    expect(text).toContain('OZK0000000000001');
    expect(text).toContain('Kurşunsuz 95 V/Max');
    expect(text).toContain('ÖRNEK TAŞIMACILIK A.Ş.');
    expect(text).toContain('Miktar (lt)');
    const quantity = out.pages[0]!.items.find((i) => i.s === '312,80')!;
    expect(quantity).toMatchObject({ x: 260, y: 600, k: false });
    expect(quantity.w).toBeGreaterThan(0);
  }, 20_000);

  it('stores no_text for a page of shapes, encrypted for a password, unreadable for a truncated file', async () => {
    const outcomes = await reader.withSession(20_000, async (s) => [
      await s.text(fixture('no-text.pdf')),
      await s.text(fixture('encrypted.pdf')),
      await s.text(fixture('ozk-single.pdf').subarray(0, 900)),
    ]);
    expect(outcomes).toEqual([
      { kind: 'unread', status: 'no_text', pageCount: 1 },
      { kind: 'unread', status: 'encrypted', pageCount: 0 },
      { kind: 'unread', status: 'unreadable', pageCount: 0 },
    ]);
  }, 30_000);

  it('refuses a file over the page limit, unread', async () => {
    const small = new PdfReaderService({ limits: { maxPages: 3 } });
    expect(await small.start()).toBe('available');
    const outcome = await small.withSession(20_000, async (s) => s.text(await buildManyPagePdf(4)));
    expect(outcome).toEqual({ kind: 'unread', status: 'limit_exceeded', pageCount: 4 });
  }, 30_000);

  it('kills a read past its deadline and leaves no child running; a budget-shortened timeout is not stored', async () => {
    const quick = new PdfReaderService({ limits: { jobMs: 1 }, onSpawn: (pid) => pids.push(pid) });
    expect(await quick.start()).toBe('available');
    const before = pids.length;
    const full = await quick.withSession(20_000, (s) => s.text(fixture('duman-23.pdf')));
    expect(full).toEqual({ kind: 'unread', status: 'timed_out', pageCount: 0 });
    const spawned = pids.slice(before);
    expect(spawned).toHaveLength(1);
    expect(alive(spawned[0]!)).toBe(false);
    // The request's budget, not the file, cut this one short: tried again later.
    const shortened = await reader.withSession(1, (s) => s.text(fixture('duman-23.pdf')));
    expect(shortened).toEqual({ kind: 'transient', reason: 'timed_out' });
  }, 30_000);

  it('answers busy at once to a second request while one is reading', async () => {
    let second: unknown;
    const first = reader.withSession(20_000, async (s) => {
      second = await reader.withSession(20_000, async () => 'ran');
      return s.text(fixture('ozk-single.pdf'));
    });
    await first;
    expect(second).toEqual({ refused: 'reader_busy' });
  }, 20_000);

  it("cuts one invoice's pages: its text holds only that invoice, and the same cut twice is the same bytes", async () => {
    const source = fixture('duman-23.pdf');
    // Duman: invoice 11 (June, first half) is pages 11-12.
    const [a, b] = await reader.withSession(20_000, async (s) => [await s.cut(source, [[11, 12], [3, 3]]), await s.cut(source, [[11, 12], [3, 3]])]) as [
      Awaited<ReturnType<Parameters<Parameters<PdfReaderService['withSession']>[1]>[0]['cut']>>,
      Awaited<ReturnType<Parameters<Parameters<PdfReaderService['withSession']>[1]>[0]['cut']>>,
    ];
    if (a.kind !== 'parts' || b.kind !== 'parts') throw new Error(`cut failed: ${JSON.stringify([a, b])}`);
    const digest = (x: Buffer) => createHash('sha256').update(x).digest('hex');
    expect(a.parts.map((p) => digest(p.bytes!))).toEqual(b.parts.map((p) => digest(p.bytes!)));
    const back = await reader.withSession(20_000, async (s) => [await s.text(a.parts[0]!.bytes!), await s.text(a.parts[1]!.bytes!)]);
    const [june, feb] = (back as TextOutcome[]).map((o) => textOf(o));
    expect(june.pageCount).toBe(2);
    expect(joined(june.pages).match(/DAU\d{13}/g)).toEqual([dumanInvoiceNo(10), dumanInvoiceNo(10)]);
    expect(feb.pageCount).toBe(1);
    expect(joined(feb.pages).match(/DAU\d{13}/g)).toEqual([dumanInvoiceNo(2)]);
    expect(a.parts[0]!.bytes!.length).toBeLessThan(source.length);
  }, 30_000);
});

describe('the reader process boundary', () => {
  it('has an empty environment and is denied network, secret files, processes and code from strings', async () => {
    // The self-test is the proof the API runs at start; assert its parts here.
    const reader = new PdfReaderService();
    const failed = await (reader as unknown as { selfTest(): Promise<string[]> }).selfTest();
    expect(failed).toEqual([]);
  }, 30_000);

  it('kills a child whose memory outside the heap passes the cap', async () => {
    const reader = new PdfReaderService({ limits: { rssMb: 160 } });
    expect(await reader.allocateForTest(320, 3_000)).toBe('memory');
    expect(await reader.allocateForTest(16, 10)).toBe('answer');
  }, 30_000);

  it('is unavailable when the worker file is missing, and then refuses without spawning', async () => {
    const pids: number[] = [];
    const reader = new PdfReaderService({ workerPath: join(FIXTURES, 'missing.worker.mjs'), onSpawn: (pid) => pids.push(pid) });
    expect(await reader.start()).toBe('unavailable');
    expect(await reader.withSession(20_000, async () => 'ran')).toEqual({ refused: 'reader_unavailable' });
    expect(pids).toEqual([]);
  });

  it('keeps the worker file beside the module (the build copies it to dist)', () => {
    expect(existsSync(READER_WORKER_PATH)).toBe(true);
  });
});

describe('a cut part holds its own invoice and nothing else (task 7.2)', () => {
  it('leaves out the other invoices’ shared resources, links, attachments and metadata', async () => {
    const { PDFDocument, PDFDict, PDFName, PDFStream } = await import('@cantoo/pdf-lib');
    const { buildHostileSplitPdf } = await import('../../test/fixtures/invoices/generate');
    const reader = new PdfReaderService();
    expect(await reader.start()).toBe('available');
    const source = await buildHostileSplitPdf();
    // The source does leak: every page names all three stamps and carries the rest.
    expect(source.toString('latin1')).toContain('/EmbeddedFile');
    const cut = await reader.withSession(20_000, (s) => s.cut(source, [[1, 1], [3, 3]]));
    if ('refused' in cut || cut.kind !== 'parts') throw new Error(JSON.stringify(cut));
    for (const [i, part] of cut.parts.entries()) {
      expect(part.bytes, `part ${i}`).not.toBeNull();
      const doc = await PDFDocument.load(part.bytes!, { updateMetadata: false });
      const types: string[] = [];
      let forms = 0;
      for (const [, object] of doc.context.enumerateIndirectObjects()) {
        const dict = object instanceof PDFDict ? object : object instanceof PDFStream ? object.dict : null;
        const type = dict?.get(PDFName.of('Type'));
        if (type instanceof PDFName) types.push(type.decodeText());
        if (dict?.get(PDFName.of('Subtype')) === PDFName.of('Form')) forms += 1;
      }
      expect(forms, 'one stamp: its own').toBe(1);
      expect(types).not.toEqual(expect.arrayContaining(['EmbeddedFile']));
      expect(types.filter((t) => ['Annot', 'Filespec', 'EmbeddedFile', 'Metadata'].includes(t))).toEqual([]);
      expect(doc.catalog.keys().map((k) => k.decodeText()).sort()).toEqual(['Pages', 'Type']);
      const text = await reader.withSession(20_000, (s) => s.text(part.bytes!));
      if ('refused' in text || text.kind !== 'text') throw new Error(JSON.stringify(text));
      const all = text.pages[0]!.items.map((it) => it.s).join(' ');
      const own = i === 0 ? 'OZK0000000000001' : 'OZK0000000000006';
      expect(all.match(/OZK\d{13}/g)?.every((n) => n === own)).toBe(true);
      expect(all).toContain(`STAMP ${own}`);
    }
  }, 30_000);
});

describe("a cut part never carries another page's objects (security-rls review and re-review of PR B)", () => {
  const VARIANTS = [
    'plain', 'pattern', 'softMask', 'type3', 'strayKey', 'nameInText',
    'nestedParent', 'boxDict', 'gsStream', 'fontStream', 'noSubtype', 'calStream', 'fontFile', 'spanTag', 'inlineEI', 'fnCycle',
  ] as const;
  type Variant = (typeof VARIANTS)[number];

  /**
   * Two pages sharing ONE resource dictionary `R`: `/Fa` (page 1's form),
   * `/Fb` (page 2's form, SECRET-B-FORM), and page 2's own content stream
   * (SECRET-B-PAGE). By variant, page 1 reaches one of them through an edge it
   * does not draw: a tiling pattern, a soft mask's group or a Type3 font whose
   * resources are `R`; a stray key; a name in text, in a marked-content tag or
   * in inline image data; a nested `Parent`; a dictionary in its MediaBox; an
   * ExtGState, a font, an XObject without a subtype, a calibrated colour space
   * or a font file that is page 2's content stream; a function that is its own
   * element. Nothing page 1 draws draws page 2's.
   */
  async function sharedResourcePdf(variant: Variant): Promise<Buffer> {
    const lib = await import('@cantoo/pdf-lib');
    type Dict = import('@cantoo/pdf-lib').PDFDict;
    const doc = await lib.PDFDocument.create({ updateMetadata: false });
    const { context } = doc;
    const helvetica = await doc.embedFont(lib.StandardFonts.Helvetica);
    const form = (text: string) => context.register(context.stream(`BT /H 12 Tf 20 20 Td (${text}) Tj ET`, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 300, 100], Resources: { Font: { H: helvetica.ref } },
    }));
    const fa = form('PAGE-A-CONTENT');
    const fb = form('SECRET-B-FORM');
    const pageTwo = context.register(context.stream('BT /H 12 Tf 20 60 Td (SECRET-B-PAGE) Tj ET /Fb Do', {}));
    const shared = context.obj({}) as Dict;
    const sharedRef = context.register(shared);
    shared.set(lib.PDFName.of('XObject'), context.obj({ Fa: fa, Fb: fb, X2: pageTwo, Span: fb }));
    const fonts = context.obj({ H: helvetica.ref, F2: pageTwo }) as Dict;
    shared.set(lib.PDFName.of('Font'), fonts);
    const pattern = context.register(context.stream('0 0 5 5 re f', {
      Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: sharedRef,
    }));
    const maskGroup = context.register(context.stream('0 0 5 5 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: sharedRef, Group: { S: 'Transparency' } }));
    const gs = context.register(context.obj({ Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: maskGroup } }));
    const glyph = context.register(context.stream('0 0 d0 0 0 5 5 re f', {}));
    const type3 = context.register(context.obj({
      Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 10, 10], FontMatrix: [0.001, 0, 0, 0.001, 0, 0], FirstChar: 65, LastChar: 65,
      Widths: [500], Encoding: { Type: 'Encoding', Differences: [65, 'g'] }, CharProcs: { g: glyph }, Resources: sharedRef,
    }));
    fonts.set(lib.PDFName.of('T3'), type3);
    const descriptor = context.register(context.obj({ Type: 'FontDescriptor', FontName: 'X', Flags: 32, FontBBox: [0, 0, 1, 1], ItalicAngle: 0, Ascent: 1, Descent: 0, CapHeight: 1, StemV: 1, FontFile2: pageTwo }));
    fonts.set(lib.PDFName.of('F3'), context.register(context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'X', FirstChar: 65, LastChar: 65, Widths: [500], FontDescriptor: descriptor })));
    const selfArray = context.nextRef();
    context.assign(selfArray, context.obj([selfArray]));
    shared.set(lib.PDFName.of('Shading'), context.obj({ Sh1: context.register(context.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [0, 0, 1, 1], Function: selfArray })) }));
    shared.set(lib.PDFName.of('Pattern'), context.obj({ P1: pattern }));
    shared.set(lib.PDFName.of('ExtGState'), context.obj({ G1: gs, G2: pageTwo }));
    shared.set(lib.PDFName.of('ColorSpace'), context.obj({
      C0: context.obj(['CalRGB', context.obj({ WhitePoint: [1, 1, 1], Parent: pageTwo })]),
      C1: context.obj(['CalRGB', pageTwo]),
    }));
    const pageOne: Record<Variant, string> = {
      plain: '/Fa Do',
      pattern: '/Fa Do /Pattern cs /P1 scn 0 0 10 10 re f',
      softMask: '/Fa Do /G1 gs 0 0 10 10 re f',
      type3: '/Fa Do BT /T3 12 Tf 30 30 Td (A) Tj ET',
      strayKey: '/Fa Do',
      nameInText: '/Fa Do BT /H 12 Tf 40 40 Td (/Fb Do) Tj ET',
      nestedParent: '/Fa Do /C0 cs',
      boxDict: '/Fa Do',
      gsStream: '/Fa Do /G2 gs',
      fontStream: '/Fa Do BT /F2 12 Tf ET',
      noSubtype: '/Fa Do /X2 Do',
      calStream: '/Fa Do /C1 cs',
      fontFile: '/Fa Do BT /F3 12 Tf 30 30 Td (A) Tj ET',
      spanTag: '/Span <</MCID 0>> BDC /Fa Do EMC',
      inlineEI: 'q BI /W 9 /H 1 /BPC 8 /CS /G ID a EI /Fb  EI Q /Fa Do',
      fnCycle: '/Fa Do /Sh1 sh',
    };
    const one = doc.addPage([300, 300]);
    one.node.set(lib.PDFName.of('Contents'), context.register(context.stream(pageOne[variant], variant === 'strayKey' ? { Foo: fb } : {})));
    one.node.set(lib.PDFName.of('Resources'), sharedRef);
    if (variant === 'boxDict') one.node.set(lib.PDFName.of('MediaBox'), context.obj([0, 0, 300, 300, context.obj({ Parent: pageTwo })]));
    const two = doc.addPage([300, 300]);
    two.node.set(lib.PDFName.of('Contents'), pageTwo);
    two.node.set(lib.PDFName.of('Resources'), sharedRef);
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  }

  /** Every stream of a PDF, decoded, as text. */
  async function streamsOf(bytes: Buffer): Promise<string> {
    const lib = await import('@cantoo/pdf-lib');
    const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false });
    let all = '';
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof lib.PDFRawStream) all += Buffer.from(lib.decodePDFRawStream(obj).decode()).toString('latin1');
      else if (obj instanceof lib.PDFStream) all += Buffer.from(obj.getContents()).toString('latin1');
    }
    return all;
  }

  const reader = new PdfReaderService();
  beforeAll(async () => {
    expect(await reader.start()).toBe('available');
  }, 30_000);

  for (const variant of VARIANTS) {
    it(`${variant}: page 1's part holds nothing of page 2's, and the job still answers its other parts`, async () => {
      const source = await sharedResourcePdf(variant);
      expect(await streamsOf(source)).toContain('SECRET-B');
      // Page 2 is cut too: one bad part never fails the job.
      const cut = await reader.withSession(20_000, (s) => s.cut(source, [[1, 1], [2, 2]]));
      if ('refused' in cut || cut.kind !== 'parts') throw new Error(JSON.stringify(cut));
      const part = cut.parts[0]!;
      // Refused (withheld) is safe; what must never happen is a part with page 2's content.
      if (part.bytes === null) return;
      const streams = await streamsOf(part.bytes);
      expect(streams).toContain('PAGE-A-CONTENT');
      expect(streams).not.toContain('SECRET-B');
    }, 30_000);
  }

  it('keeps every drawn resource of a plain shared dictionary (no over-refusal)', async () => {
    const cut = await reader.withSession(20_000, async (s) => s.cut(await sharedResourcePdf('plain'), [[1, 1]]));
    if ('refused' in cut || cut.kind !== 'parts') throw new Error(JSON.stringify(cut));
    expect(cut.parts[0]!.bytes).not.toBeNull();
  }, 30_000);
});

describe('what a failed job leaves (qa-auditor review of PR B: owner rules pinned)', () => {
  it('a job with no budget left is transient and spawns nothing; a crash that is not the heap is transient', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const pids: number[] = [];
    const crashing = join(mkdtempSync(join(tmpdir(), 'tonyai-crash-')), 'crash.worker.mjs');
    writeFileSync(crashing, 'process.exit(3);\n');
    const reader = new PdfReaderService({ workerPath: crashing, onSpawn: (pid) => pids.push(pid) });
    const text = (reader as unknown as { text(b: Buffer, remaining: number): Promise<TextOutcome> }).text.bind(reader);
    expect(await text(fixture('ozk-single.pdf'), 0)).toEqual({ kind: 'transient', reason: 'timed_out' });
    expect(pids).toEqual([]);
    expect(await text(fixture('ozk-single.pdf'), 10_000)).toEqual({ kind: 'transient', reason: 'reader_unavailable' });
    expect(pids).toHaveLength(1);
    // A heap-limit crash is the file's own outcome: stored as over the limit.
    writeFileSync(crashing, "process.stderr.write('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n', () => process.exit(134));\n");
    expect(await text(fixture('ozk-single.pdf'), 10_000)).toEqual({ kind: 'unread', status: 'limit_exceeded', pageCount: 0 });
    rmSync(dirname(crashing), { recursive: true, force: true });
  }, 30_000);
});
