// The evidence assistant's PDF reader (inc29-evidence-assistant, design D1).
//
// One job per process: the API spawns this file with an empty environment, a
// heap cap and Node's permission model (it may read only this file and the
// installed packages; no child process, worker, addon or WASI), writes one job
// on stdin, reads one JSON answer from stdout, and kills the process at its
// deadline or when its memory passes the cap. This file never sees a database
// URL, a service key or a managed identity, and it reaches no network: Node 22's
// permission model has no network switch, so `lockDownNetwork()` disables every
// network entry point before any parser code is loaded, and the API's start-up
// self-test (job `selftest`) proves each boundary in the running runtime before
// it reads a single file. Plain ESM because pdfjs-dist is ESM only.
//
// Jobs (the header line, then the PDF's bytes):
//  - `text`: per page its size and its text items (string, baseline x and y,
//    width, height, skewed or not). Nothing is rendered, nothing is fetched.
//  - `cut`: one PDF per page range, each holding only its pages' content and
//    the resources that content names; checked object by object before it is
//    answered.
//  - `selftest`: tries each forbidden thing and reports what happened.
//  - `allocate`: holds memory outside the heap (the memory cap's own test).

import { createRequire, syncBuiltinESMExports } from 'node:module';

const denied = (what) => () => {
  throw Object.assign(new Error(`network access is disabled in the PDF reader (${what})`), { code: 'ERR_READER_NETWORK' });
};

function lockDownNetwork(require) {
  const net = require('node:net');
  const tls = require('node:tls');
  const dgram = require('node:dgram');
  const dns = require('node:dns');
  const http = require('node:http');
  const https = require('node:https');
  const http2 = require('node:http2');
  const inspector = require('node:inspector');
  const replace = (target, key, what) => {
    Object.defineProperty(target, key, { value: denied(what), writable: false, configurable: false });
  };
  for (const key of ['connect', 'createConnection', 'createServer']) replace(net, key, `net.${key}`);
  replace(net.Socket.prototype, 'connect', 'net.Socket.connect');
  replace(net.Server.prototype, 'listen', 'net.Server.listen');
  // Its internal step too: reachable without `listen` (security-rls review of PR B, P3).
  if (typeof net.Server.prototype._listen2 === 'function') replace(net.Server.prototype, '_listen2', 'net.Server._listen2');
  replace(dgram.Socket.prototype, 'connect', 'dgram.connect');
  for (const key of ['connect', 'createServer', 'createSecureContext']) replace(tls, key, `tls.${key}`);
  replace(dgram, 'createSocket', 'dgram.createSocket');
  replace(dgram.Socket.prototype, 'bind', 'dgram.bind');
  replace(dgram.Socket.prototype, 'send', 'dgram.send');
  for (const key of Object.keys(dns)) if (typeof dns[key] === 'function' && key !== 'Resolver') replace(dns, key, `dns.${key}`);
  for (const key of Object.keys(dns.promises)) if (typeof dns.promises[key] === 'function' && key !== 'Resolver') replace(dns.promises, key, `dns.promises.${key}`);
  for (const proto of [dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const key of Object.getOwnPropertyNames(proto)) if (key !== 'constructor' && typeof proto[key] === 'function') replace(proto, key, `dns.Resolver.${key}`);
  }
  for (const mod of [http, https]) for (const key of ['request', 'get', 'createServer']) replace(mod, key, `http.${key}`);
  for (const key of ['connect', 'createServer', 'createSecureServer']) replace(http2, key, `http2.${key}`);
  replace(inspector, 'open', 'inspector.open');
  for (const key of ['fetch', 'WebSocket', 'EventSource']) {
    Object.defineProperty(globalThis, key, { value: denied(key), writable: false, configurable: false });
  }
  syncBuiltinESMExports();
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const all = Buffer.concat(chunks);
  const eol = all.indexOf(10);
  if (eol < 0) throw new Error('no job header');
  return { header: JSON.parse(all.subarray(0, eol).toString('utf8')), bytes: all.subarray(eol + 1) };
}

function answer(value) {
  process.stdout.write(JSON.stringify(value), () => process.exit(0));
}

// ── text ────────────────────────────────────────────────────────────────────

const classify = (error) => {
  const name = error && typeof error === 'object' ? error.name : '';
  if (name === 'PasswordException') return 'encrypted';
  return 'unreadable';
};

async function text(header, bytes) {
  const pdfjs = await import(header.modules.pdfjs);
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
    enableXfa: false,
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: true,
    verbosity: 0,
    cMapUrl: `${header.modules.pdfjsDir}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${header.modules.pdfjsDir}/standard_fonts/`,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    return { ok: false, status: classify(error), pageCount: 0 };
  }
  const pageCount = doc.numPages;
  if (pageCount > header.limits.maxPages) return { ok: false, status: 'limit_exceeded', pageCount };
  const pages = [];
  let items = 0;
  let chars = 0;
  try {
    for (let n = 1; n <= pageCount; n += 1) {
      const page = await doc.getPage(n);
      const [, , width, height] = page.view;
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const out = [];
      for (const item of content.items) {
        if (typeof item.str !== 'string' || item.str.trim() === '') continue;
        items += 1;
        chars += item.str.length;
        if (items > header.limits.maxItems || chars > header.limits.maxChars) {
          return { ok: false, status: 'limit_exceeded', pageCount };
        }
        const [a, b, c, d, e, f] = item.transform;
        out.push({ s: item.str, x: e, y: f, w: item.width, h: item.height || Math.hypot(c, d), k: b !== 0 || c !== 0 || a <= 0 });
      }
      pages.push({ w: width, h: height, items: out });
      page.cleanup();
    }
  } catch (error) {
    return { ok: false, status: classify(error), pageCount };
  }
  await task.destroy();
  return { ok: true, pageCount, pages };
}

// ── cut ─────────────────────────────────────────────────────────────────────

// What each kind of object may keep. Everything else — a stray key holding a
// reference, metadata, an annotation, optional content, a halftone — is
// dropped, so no edge the reader does not understand survives into a part
// (security-rls review of PR B, P1: a tiling pattern's, a soft mask's or a
// Type3 font's resources, or a stray key on a content stream, carried another
// invoice's objects).
const KEYS = {
  page: ['Type', 'MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox', 'Rotate', 'UserUnit', 'Resources', 'Contents', 'Parent', 'Group'],
  contents: ['Length', 'Filter', 'DecodeParms'],
  form: ['Type', 'Subtype', 'FormType', 'BBox', 'Matrix', 'Resources', 'Group', 'Length', 'Filter', 'DecodeParms'],
  group: ['Type', 'S', 'CS', 'I', 'K'],
  image: ['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Filter', 'DecodeParms', 'Length', 'Decode', 'Interpolate', 'ImageMask', 'Mask', 'SMask', 'Intent', 'SMaskInData'],
  tiling: ['Type', 'PatternType', 'PaintType', 'TilingType', 'BBox', 'XStep', 'YStep', 'Resources', 'Matrix', 'Length', 'Filter', 'DecodeParms'],
  shadingPattern: ['Type', 'PatternType', 'Shading', 'Matrix', 'ExtGState'],
  extGState: ['Type', 'LW', 'LC', 'LJ', 'ML', 'D', 'RI', 'OP', 'op', 'OPM', 'Font', 'FL', 'SM', 'SA', 'BM', 'SMask', 'CA', 'ca', 'AIS', 'TK'],
  softMask: ['Type', 'S', 'G', 'BC'],
  font: ['Type', 'Subtype', 'BaseFont', 'FirstChar', 'LastChar', 'Widths', 'FontDescriptor', 'Encoding', 'ToUnicode', 'DescendantFonts', 'CIDSystemInfo', 'W', 'W2', 'DW', 'DW2', 'CIDToGIDMap', 'FontBBox', 'FontMatrix', 'CharProcs', 'Resources', 'Name'],
  fontDescriptor: ['Type', 'FontName', 'FontFamily', 'FontStretch', 'FontWeight', 'Flags', 'FontBBox', 'ItalicAngle', 'Ascent', 'Descent', 'Leading', 'CapHeight', 'XHeight', 'StemV', 'StemH', 'AvgWidth', 'MaxWidth', 'MissingWidth', 'FontFile', 'FontFile2', 'FontFile3', 'CharSet', 'CIDSet', 'Style', 'Lang'],
  fontFile: ['Length', 'Length1', 'Length2', 'Length3', 'Subtype', 'Filter', 'DecodeParms'],
  encoding: ['Type', 'BaseEncoding', 'Differences'],
  cidSystemInfo: ['Registry', 'Ordering', 'Supplement'],
  shading: ['ShadingType', 'ColorSpace', 'Background', 'BBox', 'AntiAlias', 'Domain', 'Coords', 'Matrix', 'Function', 'Extend', 'Decode', 'BitsPerCoordinate', 'BitsPerComponent', 'BitsPerFlag', 'VerticesPerRow', 'Length', 'Filter', 'DecodeParms'],
  fn: ['FunctionType', 'Domain', 'Range', 'Size', 'BitsPerSample', 'Order', 'Encode', 'Decode', 'C0', 'C1', 'N', 'Functions', 'Bounds', 'Length', 'Filter', 'DecodeParms'],
  icc: ['N', 'Alternate', 'Range', 'Length', 'Filter', 'DecodeParms'],
};
// `Properties` (marked content) is not kept: it holds optional-content
// dictionaries, and a part needs none to show its text.
const RESOURCE_KINDS = ['Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading'];
const FORBIDDEN_TYPES = new Set(['EmbeddedFile', 'Filespec', 'Annot', 'Metadata', 'Action', 'OCG', 'OCMD', 'Sig', 'XRef', 'ObjStm']);
const FORBIDDEN_KEYS = ['EF', 'EmbeddedFiles', 'JS', 'JavaScript', 'AA', 'OpenAction', 'URI', 'Launch', 'AcroForm', 'Names', 'Outlines', 'Metadata', 'PieceInfo', 'Annots', 'StructTreeRoot', 'Threads', 'B', 'OC'];

function decodeName(raw) {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * The resources a content stream uses, by kind, read from its operators:
 * `/X Do` an XObject, `/F 12 Tf` a font, `/G gs` a graphics state, `/C cs` a
 * colour space, `/P scn` a pattern, `/S sh` a shading, and an inline image's
 * `/CS`. A name anywhere else — a marked-content tag (`/Span … BDC`), a
 * property list, text, a comment, inline image data — keeps nothing
 * (security-rls re-review of PR B, P2: names were matched without their kind).
 */
const OPERATOR_KINDS = { Do: 'XObject', Tf: 'Font', gs: 'ExtGState', cs: 'ColorSpace', CS: 'ColorSpace', scn: 'Pattern', SCN: 'Pattern', sh: 'Shading' };

function usedNames(text, into) {
  const add = (kind, name) => {
    if (!into.has(kind)) into.set(kind, new Set());
    into.get(kind).add(name);
  };
  let operands = [];
  let i = 0;
  const n = text.length;
  const isWhite = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  const isDelim = (c) => '()<>[]{}/%'.includes(c);
  while (i < n) {
    const ch = text[i];
    if (isWhite(ch)) { i += 1; continue; }
    if (ch === '%') { while (i < n && text[i] !== '\n' && text[i] !== '\r') i += 1; continue; }
    if (ch === '(') {
      let depth = 1;
      i += 1;
      while (i < n && depth > 0) {
        if (text[i] === '\\') i += 2;
        else { if (text[i] === '(') depth += 1; else if (text[i] === ')') depth -= 1; i += 1; }
      }
      operands.push({ t: 'other' });
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') { i += 2; operands.push({ t: 'other' }); continue; }
    if (ch === '>' && text[i + 1] === '>') { i += 2; continue; }
    if (ch === '<') { const close = text.indexOf('>', i + 1); i = close < 0 ? n : close + 1; operands.push({ t: 'other' }); continue; }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}') { i += 1; continue; }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && !isWhite(text[j]) && !isDelim(text[j])) j += 1;
      operands.push({ t: 'name', v: decodeName(text.slice(i + 1, j)) });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !isWhite(text[j]) && !isDelim(text[j])) j += 1;
    if (j === i) { i += 1; continue; }
    const word = text.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word) || word === 'true' || word === 'false' || word === 'null') { operands.push({ t: 'other' }); continue; }
    if (word === 'BI') {
      // An inline image: its dictionary may name a colour space; its data runs
      // from `ID` to the last `EI` before the next operator we can see.
      const idAt = text.slice(i).search(/\sID[\s]/);
      if (idAt < 0) return;
      const dict = text.slice(i, i + idAt);
      const cs = /\/(?:CS|ColorSpace)\s*\/([^\s/[\]()<>{}%]+)/.exec(dict);
      if (cs) add('ColorSpace', decodeName(cs[1]));
      const after = i + idAt + 4;
      const ei = text.slice(after).search(/\sEI(?=\s|$)/);
      i = ei < 0 ? n : after + ei + 3;
      operands = [];
      continue;
    }
    const kind = OPERATOR_KINDS[word];
    if (kind) {
      const names = operands.filter((o) => o.t === 'name');
      const name = word === 'Tf' ? names[0] : names[names.length - 1];
      if (name) add(kind, name.v);
    }
    operands = [];
  }
}

/** The resources an object's content streams use, by kind. */
function namesIn(lib, streams) {
  const names = new Map();
  for (const stream of streams) {
    const bytes = stream instanceof lib.PDFRawStream ? lib.decodePDFRawStream(stream).decode() : stream.getContents();
    usedNames(Buffer.from(bytes).toString('latin1'), names);
  }
  return names;
}

function contentStreams(lib, context, contents) {
  const resolved = context.lookup(contents);
  if (resolved instanceof lib.PDFArray) return resolved.asArray().map((ref) => context.lookup(ref)).filter((s) => s instanceof lib.PDFStream);
  return resolved instanceof lib.PDFStream ? [resolved] : [];
}

/** A stream subtype only a drawn object has: never a data stream's (a font file, a lookup, a CMap). */
const DRAWN_SUBTYPES = new Set(['Form', 'Image', 'PS']);
const CAL_KEYS = ['WhitePoint', 'BlackPoint', 'Gamma', 'Matrix', 'Range'];

/**
 * Walks what a page draws, by kind, keeping each object's allowed keys and
 * pruning each resource dictionary to what its own content uses by kind. An
 * object enters the allowed set only once its type fits the edge that reached
 * it, and only under one kind; a page's content stream outside the part is
 * foreign. Anything else makes the part refused (security-rls review and
 * re-review of PR B: shared resources, stray keys, wrong-typed objects).
 */
class Sanitizer {
  constructor(lib, context, foreign) {
    this.lib = lib;
    this.context = context;
    this.foreign = foreign;
    this.allowed = new Set();
    this.kindOf = new Map();
    this.refused = null;
  }

  refuse(why) {
    this.refused ??= why;
    return null;
  }

  name(value) {
    return value instanceof this.lib.PDFName ? value.decodeText() : null;
  }

  isStream(obj) {
    return obj instanceof this.lib.PDFStream;
  }

  isDict(obj) {
    return obj instanceof this.lib.PDFDict;
  }

  dictOf(obj) {
    if (obj instanceof this.lib.PDFStream) return obj.dict;
    return obj instanceof this.lib.PDFDict ? obj : null;
  }

  /** A data stream: no drawn subtype and no resources of its own. */
  isData(obj) {
    if (!this.isStream(obj)) return false;
    return !DRAWN_SUBTYPES.has(this.name(obj.dict.get(this.lib.PDFName.of('Subtype')))) && !obj.dict.has(this.lib.PDFName.of('Resources'));
  }

  keep(obj, kind) {
    const dict = this.dictOf(obj);
    if (!dict) return;
    for (const key of [...dict.keys()]) if (!KEYS[kind].includes(key.decodeText())) dict.delete(key);
  }

  /**
   * The object `value` names, if it has the type `accept` wants: allowed under
   * `kind`, and answered once (null when walked before under the same kind).
   * A direct object is answered as it is, nothing to allow.
   */
  enter(value, kind, accept) {
    if (value === undefined || value === null) return null;
    const obj = this.context.lookup(value);
    if (obj === undefined || obj === null) return null;
    if (!accept(obj)) return this.refuse(`${kind}: unexpected object`);
    if (this.foreign.has(obj)) return this.refuse(`${kind}: another page's content`);
    if (!(value instanceof this.lib.PDFRef)) return obj;
    const seen = this.kindOf.get(obj);
    if (seen !== undefined) return seen === kind ? null : this.refuse(`${kind}: also a ${seen}`);
    this.kindOf.set(obj, kind);
    this.allowed.add(obj);
    return obj;
  }

  get(obj, key) {
    return this.dictOf(obj)?.get(this.lib.PDFName.of(key));
  }

  set(dict, key, value) {
    dict.set(this.lib.PDFName.of(key), value);
  }

  /** A value of numbers, names, strings and arrays of them only (a `Widths` array, a `BBox`); anything else refuses. */
  plain(value) {
    if (value === undefined) return;
    const obj = this.context.lookup(value);
    const isPlain = (v) => {
      const o = v instanceof this.lib.PDFRef ? undefined : v;
      if (o instanceof this.lib.PDFArray) return o.asArray().every(isPlain);
      return !(v instanceof this.lib.PDFRef) && !(o instanceof this.lib.PDFDict) && !(o instanceof this.lib.PDFStream);
    };
    if (!(obj instanceof this.lib.PDFArray ? obj.asArray().every(isPlain) : isPlain(obj))) return this.refuse('a value that is not plain');
    if (value instanceof this.lib.PDFRef) this.enter(value, 'plain', () => true);
  }

  page(leaf) {
    this.allowed.add(leaf);
    this.keep(leaf, 'page');
    for (const key of ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox']) this.plain(this.get(leaf, key));
    const contents = this.get(leaf, 'Contents');
    const resolved = this.context.lookup(contents);
    const refs = resolved instanceof this.lib.PDFArray ? resolved.asArray() : contents === undefined ? [] : [contents];
    if (resolved instanceof this.lib.PDFArray && contents instanceof this.lib.PDFRef) this.enter(contents, 'contentsArray', () => true);
    const streams = [];
    for (const ref of refs) {
      const stream = this.enter(ref, 'contents', (o) => this.isData(o));
      if (stream) {
        this.keep(stream, 'contents');
        streams.push(stream);
      }
    }
    const group = this.get(leaf, 'Group');
    if (group) this.group(group);
    this.set(leaf, 'Resources', this.resources(this.context.lookup(this.get(leaf, 'Resources')), namesIn(this.lib, streams)));
  }

  /** A new resource dictionary: only what `names` uses of each kind, each entry walked by its kind. */
  resources(resources, names) {
    const out = this.context.obj({});
    if (!(resources instanceof this.lib.PDFDict)) return out;
    for (const kind of RESOURCE_KINDS) {
      const used = names.get(kind);
      if (!used) continue;
      const dict = this.context.lookup(this.get(resources, kind));
      if (!(dict instanceof this.lib.PDFDict)) continue;
      const kept = this.context.obj({});
      for (const [key, value] of dict.entries()) {
        if (!used.has(key.decodeText())) continue;
        kept.set(key, value);
        if (kind === 'Font') this.font(value);
        else if (kind === 'XObject') this.xobject(value);
        else if (kind === 'ExtGState') this.extGState(value);
        else if (kind === 'ColorSpace') this.colorSpace(value);
        else if (kind === 'Pattern') this.pattern(value);
        else if (kind === 'Shading') this.shading(value);
      }
      if (kept.keys().length > 0) this.set(out, kind, kept);
    }
    return out;
  }

  /** A form-like stream (a form XObject, a tiling pattern, a soft mask's group): its resources pruned by its own content. */
  drawn(obj, kind) {
    this.keep(obj, kind);
    for (const key of ['BBox', 'Matrix']) this.plain(this.get(obj, key));
    const group = this.get(obj, 'Group');
    if (group) this.group(group);
    this.set(obj.dict, 'Resources', this.resources(this.context.lookup(this.get(obj, 'Resources')), namesIn(this.lib, [obj])));
  }

  group(value) {
    const obj = this.enter(value, 'group', (o) => this.isDict(o));
    if (!obj) return;
    this.keep(obj, 'group');
    const cs = this.get(obj, 'CS');
    if (cs) this.colorSpace(cs);
  }

  xobject(value) {
    const obj = this.enter(value, 'xobject', (o) => this.isStream(o) && ['Form', 'Image'].includes(this.name(o.dict.get(this.lib.PDFName.of('Subtype')))));
    if (!obj) return;
    if (this.name(this.get(obj, 'Subtype')) === 'Form') return this.drawn(obj, 'form');
    this.keep(obj, 'image');
    const cs = this.get(obj, 'ColorSpace');
    if (cs) this.colorSpace(cs);
    const smask = this.get(obj, 'SMask');
    if (smask) this.imageMask(smask);
    const mask = this.get(obj, 'Mask');
    if (mask instanceof this.lib.PDFRef) this.imageMask(mask);
    else if (mask) this.plain(mask);
    this.plain(this.get(obj, 'Decode'));
  }

  imageMask(value) {
    const obj = this.enter(value, 'xobject', (o) => this.isStream(o) && this.name(o.dict.get(this.lib.PDFName.of('Subtype'))) === 'Image');
    if (!obj) return;
    this.keep(obj, 'image');
    if (this.get(obj, 'SMask') || (this.get(obj, 'Mask') instanceof this.lib.PDFRef)) return this.refuse('a mask with a mask');
    const cs = this.get(obj, 'ColorSpace');
    if (cs) this.colorSpace(cs);
    this.plain(this.get(obj, 'Decode'));
  }

  pattern(value) {
    const obj = this.enter(value, 'pattern', (o) => this.isStream(o) || this.isDict(o));
    if (!obj) return;
    const type = this.get(obj, 'PatternType')?.asNumber?.();
    if (this.isStream(obj) && type === 1) return this.drawn(obj, 'tiling');
    if (!this.isDict(obj) || type !== 2) return this.refuse('pattern: unexpected type');
    this.keep(obj, 'shadingPattern');
    this.plain(this.get(obj, 'Matrix'));
    const shading = this.get(obj, 'Shading');
    if (shading) this.shading(shading);
    const gs = this.get(obj, 'ExtGState');
    if (gs) this.extGState(gs);
  }

  extGState(value) {
    const obj = this.enter(value, 'extGState', (o) => this.isDict(o));
    if (!obj) return;
    this.keep(obj, 'extGState');
    for (const key of ['D', 'BM']) this.plain(this.get(obj, key));
    const smaskValue = this.get(obj, 'SMask');
    if (smaskValue && !(smaskValue instanceof this.lib.PDFName)) {
      const smask = this.enter(smaskValue, 'softMask', (o) => this.isDict(o));
      if (smask) {
        this.keep(smask, 'softMask');
        this.plain(this.get(smask, 'BC'));
        const g = this.enter(this.get(smask, 'G'), 'xobject', (o) => this.isStream(o) && this.name(o.dict.get(this.lib.PDFName.of('Subtype'))) === 'Form');
        if (g) this.drawn(g, 'form');
      }
    }
    const font = this.context.lookup(this.get(obj, 'Font'));
    if (font instanceof this.lib.PDFArray && font.asArray()[0]) this.font(font.asArray()[0]);
  }

  dataStream(value, kind, keys = 'contents') {
    const obj = this.enter(value, kind, (o) => this.isData(o));
    if (obj) this.keep(obj, keys);
    return obj;
  }

  font(value) {
    const obj = this.enter(value, 'font', (o) => this.isDict(o));
    if (!obj) return;
    this.keep(obj, 'font');
    for (const key of ['Widths', 'W', 'W2', 'FontBBox', 'FontMatrix', 'DW2']) this.plain(this.get(obj, key));
    const descriptor = this.enter(this.get(obj, 'FontDescriptor'), 'fontDescriptor', (o) => this.isDict(o));
    if (descriptor) {
      this.keep(descriptor, 'fontDescriptor');
      this.plain(this.get(descriptor, 'FontBBox'));
      for (const key of ['FontFile', 'FontFile2', 'FontFile3', 'CIDSet']) this.dataStream(this.get(descriptor, key), 'fontFile', 'fontFile');
    }
    const encoding = this.get(obj, 'Encoding');
    if (encoding && !(encoding instanceof this.lib.PDFName)) {
      const enc = this.enter(encoding, 'encoding', (o) => this.isDict(o) || this.isData(o));
      if (enc && this.isDict(enc)) {
        this.keep(enc, 'encoding');
        this.plain(this.get(enc, 'Differences'));
      } else if (enc) this.keep(enc, 'contents');
    }
    this.dataStream(this.get(obj, 'ToUnicode'), 'cmap');
    const cidToGid = this.get(obj, 'CIDToGIDMap');
    if (cidToGid && !(cidToGid instanceof this.lib.PDFName)) this.dataStream(cidToGid, 'cmap');
    const info = this.enter(this.get(obj, 'CIDSystemInfo'), 'cidSystemInfo', (o) => this.isDict(o));
    if (info) this.keep(info, 'cidSystemInfo');
    const descendants = this.get(obj, 'DescendantFonts');
    if (descendants) {
      const list = this.enter(descendants, 'fontArray', (o) => o instanceof this.lib.PDFArray) ?? this.context.lookup(descendants);
      if (list instanceof this.lib.PDFArray) for (const d of list.asArray()) this.font(d);
    }
    // A Type3 font draws its glyphs with content of its own: its resources are
    // pruned by what its glyph procedures use.
    const charProcsValue = this.get(obj, 'CharProcs');
    if (charProcsValue) {
      const charProcs = this.enter(charProcsValue, 'charProcs', (o) => this.isDict(o)) ?? this.context.lookup(charProcsValue);
      const procs = [];
      if (charProcs instanceof this.lib.PDFDict) {
        for (const [, ref] of charProcs.entries()) {
          const proc = this.dataStream(ref, 'glyph');
          if (proc) procs.push(proc);
        }
      }
      this.set(obj, 'Resources', this.resources(this.context.lookup(this.get(obj, 'Resources')), namesIn(this.lib, procs)));
    } else if (this.get(obj, 'Resources')) {
      obj.delete(this.lib.PDFName.of('Resources'));
    }
  }

  colorSpace(value) {
    if (value instanceof this.lib.PDFName) return;
    const obj = this.enter(value, 'colorSpace', (o) => o instanceof this.lib.PDFArray);
    if (!obj) return;
    const [family, ...params] = obj.asArray();
    switch (this.name(family)) {
      case 'ICCBased': {
        const icc = this.dataStream(params[0], 'icc', 'icc');
        if (icc) {
          const alt = this.get(icc, 'Alternate');
          if (alt) this.colorSpace(alt);
          this.plain(this.get(icc, 'Range'));
        }
        break;
      }
      case 'Indexed': {
        if (params[0]) this.colorSpace(params[0]);
        const lookup = this.context.lookup(params[2]);
        if (this.isStream(lookup)) this.dataStream(params[2], 'lookup');
        else this.plain(params[2]);
        break;
      }
      case 'Separation':
      case 'DeviceN': {
        const [names, alt, tint, attributes] = params;
        this.plain(names);
        if (alt) this.colorSpace(alt);
        if (tint) this.fn(tint);
        if (attributes) this.refuse('DeviceN attributes');
        break;
      }
      case 'Pattern': {
        if (params[0]) this.colorSpace(params[0]);
        break;
      }
      case 'CalGray':
      case 'CalRGB':
      case 'Lab': {
        const dict = this.enter(params[0], 'calibration', (o) => this.isDict(o));
        if (dict) {
          for (const key of [...dict.keys()]) if (!CAL_KEYS.includes(key.decodeText())) dict.delete(key);
          for (const key of CAL_KEYS) this.plain(this.get(dict, key));
        }
        break;
      }
      default:
        this.refuse('colour space: unexpected family');
    }
  }

  shading(value) {
    const obj = this.enter(value, 'shading', (o) => this.isDict(o) || this.isData(o));
    if (!obj) return;
    this.keep(obj, 'shading');
    const cs = this.get(obj, 'ColorSpace');
    if (cs) this.colorSpace(cs);
    const fn = this.get(obj, 'Function');
    if (fn) this.fn(fn);
    for (const key of ['Background', 'BBox', 'Domain', 'Coords', 'Matrix', 'Extend', 'Decode']) this.plain(this.get(obj, key));
  }

  fn(value, depth = 0) {
    if (depth > 8) return this.refuse('function: too deep');
    const resolved = this.context.lookup(value);
    if (resolved instanceof this.lib.PDFArray) {
      const list = value instanceof this.lib.PDFRef ? this.enter(value, 'fnArray', () => true) : resolved;
      if (list) for (const f of list.asArray()) this.fn(f, depth + 1);
      return;
    }
    const obj = this.enter(value, 'fn', (o) => this.isDict(o) || this.isData(o));
    if (!obj) return;
    this.keep(obj, 'fn');
    for (const key of ['Domain', 'Range', 'Size', 'Encode', 'Decode', 'C0', 'C1', 'Bounds']) this.plain(this.get(obj, key));
    const functions = this.get(obj, 'Functions');
    if (functions) this.fn(functions, depth + 1);
  }

  /** The first indirect object the page reaches that the walk did not allow, or null. */
  stray(leaf) {
    const seen = new Set();
    const walk = (value, top) => {
      if (value instanceof this.lib.PDFRef) {
        const obj = this.context.lookup(value);
        if (!this.allowed.has(obj)) return value.toString();
        if (seen.has(obj)) return null;
        seen.add(obj);
        return walk(obj, false);
      }
      if (value instanceof this.lib.PDFStream) return walk(value.dict, false);
      if (value instanceof this.lib.PDFDict) {
        for (const [key, v] of value.entries()) {
          // Only the page's own `Parent`, which the copy removes; anywhere else it is an edge like any.
          if (top && key.decodeText() === 'Parent') continue;
          const found = walk(v, false);
          if (found) return found;
        }
        return null;
      }
      if (value instanceof this.lib.PDFArray) {
        for (const v of value.asArray()) {
          const found = walk(v, false);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(leaf, true);
  }
}

/**
 * Leaves a page holding its own content and only the objects that content
 * draws; answers why the part must be refused, or null. `foreign` holds the
 * content streams of the pages outside the part.
 */
function isolatePage(lib, doc, index, foreign) {
  const page = doc.getPage(index);
  const leaf = page.node;
  const { context } = doc;
  const inherited = { MediaBox: leaf.MediaBox(), CropBox: leaf.CropBox(), Rotate: leaf.Rotate(), Resources: leaf.Resources() };
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined) leaf.set(lib.PDFName.of(key), value);
  }
  const sanitizer = new Sanitizer(lib, context, foreign);
  sanitizer.page(leaf);
  leaf.set(lib.PDFName.of('Parent'), doc.catalog.get(lib.PDFName.of('Pages')));
  return sanitizer.refused ?? sanitizer.stray(leaf);
}

/** Refuses a part that holds anything beyond its pages and what they draw. */
function census(lib, doc, pages) {
  if (doc.getPageCount() !== pages) return `page count ${doc.getPageCount()}`;
  const catalogKeys = doc.catalog.keys().map((k) => k.decodeText()).sort();
  if (catalogKeys.join(',') !== 'Pages,Type') return `catalog ${catalogKeys.join(',')}`;
  let pageObjects = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object instanceof lib.PDFDict ? object : object instanceof lib.PDFStream ? object.dict : null;
    if (!dict) continue;
    const type = dict.get(lib.PDFName.of('Type'))?.decodeText?.();
    if (type && FORBIDDEN_TYPES.has(type)) return `object of type ${type}`;
    if (type === 'Page') pageObjects += 1;
    const subtype = dict.get(lib.PDFName.of('Subtype'))?.decodeText?.();
    if (subtype === 'XML' || subtype === 'FileAttachment' || subtype === 'Link') return `object of subtype ${subtype}`;
    for (const key of FORBIDDEN_KEYS) {
      if (key === 'B' && type !== 'Page') continue;
      if (dict.has(lib.PDFName.of(key))) return `key ${key}`;
    }
  }
  return pageObjects === pages ? null : `page objects ${pageObjects}`;
}

async function cut(header, bytes) {
  const lib = createRequire(import.meta.url)(header.modules.pdfLib);
  const out = [];
  for (const [from, to] of header.ranges) {
    // A fresh source per part: isolating a page rewrites its source objects.
    const src = await lib.PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > src.getPageCount()) {
      return { ok: false, reason: 'range' };
    }
    const indices = [];
    let refusal = null;
    try {
      // Every other page's content streams: a part may reach none of them.
      const foreign = new Set();
      src.getPages().forEach((p, i) => {
        if (i >= from - 1 && i < to) return;
        for (const stream of contentStreams(lib, src.context, p.node.get(lib.PDFName.of('Contents')))) foreign.add(stream);
      });
      for (let i = from - 1; i < to; i += 1) {
        refusal ??= isolatePage(lib, src, i, foreign);
        indices.push(i);
      }
    } catch {
      // A malformed object refuses this part only (security-rls re-review, P3).
      refusal = 'malformed';
    }
    if (refusal) {
      out.push({ pageFrom: from, pageTo: to, refused: 'isolation' });
      continue;
    }
    const part = await lib.PDFDocument.create({ updateMetadata: false });
    part.setProducer(header.producer);
    const copied = await part.copyPages(src, indices);
    for (const page of copied) part.addPage(page);
    const saved = await part.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
    const check = await lib.PDFDocument.load(saved, { updateMetadata: false, throwOnInvalidObject: true });
    // A part holding anything beyond its pages and what they draw is withheld
    // on its own; the other parts are still answered (D5 step 1).
    const leftover = census(lib, check, indices.length);
    if (leftover) out.push({ pageFrom: from, pageTo: to, refused: 'isolation' });
    else out.push({ pageFrom: from, pageTo: to, pdf: Buffer.from(saved).toString('base64') });
  }
  return { ok: true, parts: out };
}

// ── selftest and allocate ───────────────────────────────────────────────────

async function selftest(header, require) {
  const attempt = async (fn) => {
    try {
      await fn();
      return 'allowed';
    } catch (error) {
      return error && error.code ? String(error.code) : 'denied';
    }
  };
  const net = require('node:net');
  const fs = require('node:fs');
  return {
    ok: true,
    checks: {
      connect: await attempt(() => new Promise((resolve, reject) => {
        const socket = net.connect(header.port, '127.0.0.1');
        socket.on('connect', () => { socket.destroy(); resolve(); });
        socket.on('error', reject);
      })),
      fetch: await attempt(() => fetch(`http://127.0.0.1:${header.port}/`)),
      dns: await attempt(() => require('node:dns').promises.lookup('localhost')),
      udp: await attempt(() => require('node:dgram').createSocket('udp4')),
      secretFile: await attempt(() => fs.readFileSync(header.secretPath)),
      // The API's own files, directly and through a workspace link (a symlink
      // the permission model would follow out of a granted directory).
      workspaceFiles: await attempt(() => {
        for (const path of header.forbidden ?? []) {
          let denied = false;
          try {
            fs.readFileSync(path);
          } catch {
            denied = true;
          }
          if (!denied) return;
        }
        if ((header.forbidden ?? []).length === 0) return;
        throw Object.assign(new Error('denied'), { code: 'ERR_ACCESS_DENIED' });
      }),
      listen: await attempt(() => new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { server.close(); resolve(); });
      })),
      childProcess: await attempt(() => require('node:child_process').spawnSync(process.execPath, ['--version'])),
      worker: await attempt(() => new (require('node:worker_threads').Worker)('0', { eval: true })),
      binding: await attempt(() => process.binding('tcp_wrap')),
      codeFromStrings: await attempt(() => new Function('return 1')()),
    },
    envKeys: Object.keys(process.env),
    permission: typeof process.permission?.has === 'function' && !process.permission.has('fs.read', header.secretPath),
  };
}

async function allocate(header) {
  const held = [];
  for (let mb = 0; mb < header.megabytes; mb += 16) held.push(Buffer.alloc(16 * 1024 * 1024, 1));
  await new Promise((resolve) => setTimeout(resolve, header.holdMs));
  return { ok: true, held: held.length };
}

// ── main ────────────────────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
lockDownNetwork(require);
try {
  const { header, bytes } = await readStdin();
  if (header.job === 'text') answer(await text(header, bytes));
  else if (header.job === 'cut') answer(await cut(header, bytes));
  else if (header.job === 'selftest') answer(await selftest(header, require));
  else if (header.job === 'allocate') answer(await allocate(header));
  else answer({ ok: false, reason: 'job' });
} catch (error) {
  answer({ ok: false, status: classify(error), error: error && error.name ? String(error.name) : 'Error' });
}
