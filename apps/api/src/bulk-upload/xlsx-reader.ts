import { checkParserDeadline } from '../common/work-deadline';
import { isUtf8 } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import { BadRequestException } from '@nestjs/common';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { UnpackBudget, ZipArchive, unreadableWorkbook } from './zip-reader';

/**
 * Reads the FIRST worksheet of an `.xlsx` and nothing else, with every cost
 * bounded by the bytes it agreed to unpack.
 *
 * Why not exceljs, which still writes the template (`template-workbook.ts`):
 * `workbook.xlsx.load` expands a declared range cell by cell while it loads —
 * a data validation, a merge, a defined name or a `<col>` span across the
 * whole sheet. A ~2 KB file with any one of the four killed the process with a
 * V8 out-of-memory abort (measured under a 256 MB heap), which no try/catch
 * sees: the replica dies with every tenant's in-flight request. exceljs's
 * streaming reader avoids those four and stays open to the rest. It inflates
 * the whole archive with no limit, caches every shared string before the first
 * row, spools the sheet to a temp file that outlives a caller who stops early,
 * and cannot see merged cells at all.
 *
 * So this opens exactly what the first sheet needs — the package and workbook
 * relationships, the workbook, the shared strings, the styles and that one
 * sheet — under ONE unpack budget, and never materialises a range: a merge is
 * reported as its corners, and validations, `<col>` spans and defined names
 * are never parsed at all. Whatever it does to text from the file is linear
 * and done once — two backtracking patterns and a per-format evaluation held
 * the event loop for seconds to minutes before they were fixed.
 */

/**
 * What one workbook may unpack, across every part it opens. A 1,000-row import
 * is well under a megabyte of XML, so this leaves room for the bloated styles
 * and shared strings real files carry. It is also the CPU bound: saxes reads
 * ~75 MiB/s here (measured), and parsing yields between slices.
 */
export const XLSX_MAX_UNPACKED_BYTES = 16 * 1024 * 1024;

/** Excel's own grid: 1,048,576 rows by 16,384 columns (A to XFD). */
const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;
/** Excel's own limit on the characters in one cell. */
const MAX_CELL_TEXT = 32_767;
/** Above Excel's own ceilings on number formats and cell formats. */
const MAX_NUMBER_FORMATS = 4_096;
const MAX_CELL_FORMATS = 65_536;
/**
 * A number format code is a short pattern — Excel's own dialog stops at 255
 * characters — so a far longer one is not a spreadsheet's.
 */
const MAX_FORMAT_CODE_LENGTH = 1_024;
/** A relationship target is a part name; nothing legitimate is this long. */
const MAX_TARGET_LENGTH = 1_024;
/**
 * Nesting and attributes are how a small, well-formed file makes the PARSER
 * allocate: saxes holds every open tag, and every attribute of the tag being
 * read. One tag with three million attributes aborted a 256 MB process
 * (measured). saxes reports each attribute as it reads it, so counting in the
 * handler stops a tag at the first attribute over, before the rest is read.
 * OOXML nests about a dozen deep, and the most attributes any element carries
 * are a worksheet root's namespace declarations.
 */
const MAX_DEPTH = 64;
const MAX_ATTRIBUTES = 256;
/** Parsed in slices, yielding between them, so no part holds the event loop. */
const SLICE_BYTES = 256 * 1024;

export const WORKBOOK_HAS_NO_SHEETS = 'The workbook has no sheets.';
export const WORKBOOK_NOT_UTF8 =
  "The workbook's XML is not UTF-8 text. Open it in Excel and save it again.";
export const FIRST_SHEET_NOT_A_WORKSHEET =
  "The workbook's first sheet is not a worksheet. Move the sheet with the records to the front.";

export function dateOutOfRange(row: number, column: number): BadRequestException {
  return new BadRequestException(
    `Row ${row} has a date in column ${column} that is out of range. Check the cell's value and its format.`,
  );
}

export interface SheetCell {
  /** 1-based: column A is 1. */
  column: number;
  /** The cell as the user sees it; never empty. See `cellValue`. */
  value: string;
}

export interface MergedRange {
  /** As the file wrote it, e.g. `A2:A5`. */
  ref: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface SheetVisitor {
  /** Every row holding a value, in ascending order, with only those cells. */
  row(rowNumber: number, cells: readonly SheetCell[]): void;
  /** Every merged range of more than one cell — after all the rows. */
  merge(range: MergedRange): void;
}

export async function readFirstWorksheet(
  buffer: Buffer,
  visitor: SheetVisitor,
): Promise<void> {
  try {
    await readWorkbookFile(buffer, visitor);
  } catch (error) {
    // Refusals pass through, this reader's and the visitor's alike. Anything
    // else — saxes on malformed XML, above all — means the file is not a
    // workbook, and must not reach the user as a 500.
    if (error instanceof BadRequestException) throw error;
    throw unreadableWorkbook();
  }
}

function fail(): never {
  throw unreadableWorkbook();
}

async function readWorkbookFile(
  buffer: Buffer,
  visitor: SheetVisitor,
): Promise<void> {
  const zip = ZipArchive.open(buffer);
  const budget = new UnpackBudget(XLSX_MAX_UNPACKED_BYTES);
  const read = (part: string): Buffer => zip.read(part, budget) ?? fail();
  const found: {
    workbook?: string;
    sheet?: { type: string; target: string };
    sharedStrings?: string;
    styles?: string;
  } = {};

  await eachRelationship(read, '', ({ type, target }) => {
    if (type.endsWith('/officeDocument')) found.workbook ??= resolvePart('', target);
  });
  const workbookPart = found.workbook ?? fail();
  const workbook = await readWorkbook(read(workbookPart));
  if (workbook.firstSheet === undefined) {
    throw new BadRequestException(WORKBOOK_HAS_NO_SHEETS);
  }
  const firstSheet = workbook.firstSheet ?? fail();

  await eachRelationship(read, workbookPart, ({ id, type, target }) => {
    if (id === firstSheet) found.sheet ??= { type, target };
    else if (type.endsWith('/sharedStrings')) found.sharedStrings ??= target;
    else if (type.endsWith('/styles')) found.styles ??= target;
  });
  const sheet = found.sheet ?? fail();
  // A chart sheet sits in the same list; it has no cells to import.
  if (!sheet.type.endsWith('/worksheet')) {
    throw new BadRequestException(FIRST_SHEET_NOT_A_WORKSHEET);
  }

  const sharedStrings =
    found.sharedStrings === undefined
      ? []
      : await readSharedStrings(read(resolvePart(workbookPart, found.sharedStrings)));
  const dateStyles =
    found.styles === undefined
      ? []
      : await readDateStyles(read(resolvePart(workbookPart, found.styles)));
  await readSheet(
    read(resolvePart(workbookPart, sheet.target)),
    { sharedStrings, dateStyles, date1904: workbook.date1904 },
    visitor,
  );
}

const SPREADSHEET_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const PACKAGE_RELATIONSHIPS =
  'http://schemas.openxmlformats.org/package/2006/relationships';

/** The element's local name when it is SpreadsheetML; '' for anything else. */
function spreadsheetName(tag: SaxesTagNS): string {
  return SPREADSHEET_NAMESPACES.has(tag.uri) ? tag.local : '';
}

function plainAttribute(tag: SaxesTagNS, name: string): string | undefined {
  const attribute = tag.attributes[name];
  return attribute && attribute.uri === '' ? attribute.value : undefined;
}

/** `r:id`, under whatever prefix the file bound the namespace to. */
function relationshipId(tag: SaxesTagNS): string | undefined {
  for (const attribute of Object.values(tag.attributes)) {
    if (attribute.local === 'id' && RELATIONSHIP_NAMESPACES.has(attribute.uri)) {
      return attribute.value;
    }
  }
  return undefined;
}

interface XmlHandlers {
  open(tag: SaxesTagNS): void;
  close(): void;
  text?(text: string): void;
}

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

async function parseXml(part: Buffer, handlers: XmlHandlers): Promise<void> {
  // The same rule the CSV path applies to a whole file, applied to each XML
  // part — because `StringDecoder('utf8')` below is lossy in exactly the way
  // `Buffer#toString('utf8')` is, and saxes does not close the gap: it
  // syntax-checks the NAME in an `encoding="…"` declaration and then ignores
  // it, so a part declaring `windows-1254` is still read as UTF-8 and its
  // Turkish letters still become U+FFFD. Measured: a single `0xFC` in a
  // `varianceReason` cell reached the stored record as U+FFFD, and that
  // column is free text no vocabulary can catch on an immutable row.
  //
  // What it refuses, stated so it is provable rather than reassuring: every
  // byte failing this check is one the decoder below would have replaced with
  // U+FFFD, so no workbook whose imported VALUES were intact is refused —
  // EXCEPT one whose bad bytes sit entirely in elements this reader never
  // opens (`<headerFooter>`, `<definedName>`). That case was importable
  // before and is refused now. It needs a writer that encodes one element
  // differently from the rest, which no mainstream one does (Excel,
  // LibreOffice, Sheets, exceljs and this product's own template all
  // serialise the package through a single UTF-8 encoder), so the guard is
  // left part-level rather than narrowed to the elements that are read.
  //
  // A NUL joins it, for parity with the CSV rule and not because it is
  // reachable: saxes refuses a raw NUL everywhere today. That is a property
  // of this version of a dependency, not a rule of this reader — the same
  // ground the doctype refusal below is written on. XML 1.0 cannot carry
  // U+0000 at all, escaped or not, so it cannot false-positive.
  //
  // Cost: measured 0.7 ms for 9.9 MiB of Turkish text, and the unpack budget
  // is charged BEFORE a part is returned, so the total scanned over one read
  // can never exceed `XLSX_MAX_UNPACKED_BYTES`.
  if (!isUtf8(part) || part.includes(0)) {
    throw new BadRequestException(WORKBOOK_NOT_UTF8);
  }
  const parser = new SaxesParser<{ xmlns: true; position: false }>({
    xmlns: true,
    position: false,
  });
  let depth = 0;
  let attributes = 0;
  // OOXML never carries a DTD. Refusing one outright means no entity declared
  // in it can be expanded — saxes does not expand them today, but that is a
  // property of this version of a dependency, not a rule of this reader.
  parser.on('doctype', () => fail());
  parser.on('opentagstart', () => {
    attributes = 0;
  });
  parser.on('attribute', () => {
    attributes += 1;
    if (attributes > MAX_ATTRIBUTES) fail();
  });
  parser.on('opentag', (tag) => {
    depth += 1;
    if (depth > MAX_DEPTH) fail();
    handlers.open(tag);
  });
  parser.on('closetag', () => {
    depth -= 1;
    handlers.close();
  });
  const onText = handlers.text;
  if (onText) {
    parser.on('text', (text) => onText(text));
    parser.on('cdata', (text) => onText(text));
  }

  // A leading byte-order mark needs nothing here: saxes skips it.
  const decoder = new StringDecoder('utf8');
  for (let offset = 0; offset < part.length; offset += SLICE_BYTES) {
    checkParserDeadline();
    if (offset > 0) await yieldToEventLoop();
    parser.write(decoder.write(part.subarray(offset, offset + SLICE_BYTES)));
  }
  parser.write(decoder.end());
  parser.close();
}

interface Relationship {
  id: string;
  type: string;
  target: string;
}

/**
 * Visit a part's relationships one at a time. Nothing is collected here: a
 * relationships part is as attacker-shaped as any other, and the callers each
 * want two or three entries out of it.
 */
async function eachRelationship(
  read: (part: string) => Buffer,
  source: string,
  visit: (relationship: Relationship) => void,
): Promise<void> {
  const slash = source.lastIndexOf('/');
  const part = `${source.slice(0, slash + 1)}_rels/${source.slice(slash + 1)}.rels`;
  await parseXml(read(part), {
    open(tag) {
      if (tag.local !== 'Relationship' || tag.uri !== PACKAGE_RELATIONSHIPS) return;
      const id = plainAttribute(tag, 'Id');
      const type = plainAttribute(tag, 'Type');
      const target = plainAttribute(tag, 'Target');
      if (id === undefined || type === undefined || target === undefined) fail();
      // An external target is a URL, not a part of this file.
      if (plainAttribute(tag, 'TargetMode') === 'External') return;
      if (target.length > MAX_TARGET_LENGTH) fail();
      visit({ id, type, target });
    },
    close() {},
  });
}

/** A relationship target, resolved against the part that declared it. */
function resolvePart(source: string, target: string): string {
  const segments = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') segments.push(segment);
    else if (segments.pop() === undefined) fail();
  }
  return segments.join('/');
}

/**
 * The relationship id of the first sheet in the workbook's own order — the tab
 * order, hidden sheets included, which is what exceljs's `worksheets[0]` was.
 * `undefined` when the workbook lists no sheets, `null` when the first one
 * names no relationship.
 */
async function readWorkbook(
  part: Buffer,
): Promise<{ firstSheet?: string | null; date1904: boolean }> {
  const path: string[] = [];
  const found: { firstSheet?: string | null; date1904: boolean } = {
    date1904: false,
  };
  await parseXml(part, {
    open(tag) {
      const name = spreadsheetName(tag);
      const parent = path[path.length - 1];
      path.push(name);
      if (name === 'workbookPr' && parent === 'workbook') {
        const value = plainAttribute(tag, 'date1904');
        found.date1904 = value === '1' || value === 'true';
      } else if (name === 'sheet' && parent === 'sheets') {
        if (found.firstSheet === undefined) found.firstSheet = relationshipId(tag) ?? null;
      }
    },
    close() {
      path.pop();
    },
  });
  return found;
}

function appendCellText(text: string, chunk: string): string {
  if (text.length + chunk.length > MAX_CELL_TEXT) fail();
  return text + chunk;
}

/**
 * OOXML writes characters XML cannot carry as `_xHHHH_`; Excel stores a line
 * break inside a cell as `_x000D_`. exceljs decoded them in every `<t>`, with
 * uppercase hex as Excel writes it, so a value reads as it always has.
 */
function decodeEscapes(text: string): string {
  return text.includes('_x')
    ? text.replace(/_x([0-9A-F]{4})_/g, (_escape, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
    : text;
}

/**
 * Every shared string, in order: the `<t>` directly inside its `<si>` plus the
 * `<t>` of each rich-text run. A phonetic run's `<t>` sits under `<rPh>` — a
 * reading guide shown above the text, never in the cell — so the parent check
 * leaves it out. A second direct `<t>` is refused: appended to the first, "12"
 * and "00" would read as one plausible 1200.
 */
async function readSharedStrings(part: Buffer): Promise<string[]> {
  const strings: string[] = [];
  const path: string[] = [];
  const at: { item: string | null; text: string | null; directTexts: number } = {
    item: null,
    text: null,
    directTexts: 0,
  };
  await parseXml(part, {
    open(tag) {
      const name = spreadsheetName(tag);
      const parent = path[path.length - 1];
      const grandparent = path[path.length - 2];
      path.push(name);
      if (name === 'si' && parent === 'sst') {
        at.item = '';
        at.directTexts = 0;
      } else if (name === 't' && at.item !== null) {
        if (parent === 'si') {
          at.directTexts += 1;
          if (at.directTexts > 1) fail();
          at.text = '';
        } else if (parent === 'r' && grandparent === 'si') {
          at.text = '';
        }
      }
    },
    close() {
      const name = path.pop();
      const parent = path[path.length - 1];
      if (name === 't' && at.item !== null && at.text !== null) {
        at.item = appendCellText(at.item, decodeEscapes(at.text));
        at.text = null;
      } else if (name === 'si' && parent === 'sst' && at.item !== null) {
        strings.push(at.item);
        at.item = null;
      }
    },
    text(chunk) {
      if (at.text !== null) at.text = appendCellText(at.text, chunk);
    },
  });
  return strings;
}

/**
 * Excel's built-in date and time formats. Their codes live in Excel, not in
 * the file, so the ids are all a reader gets: 14-22 everywhere, 27-36 and
 * 50-58 in the East Asian locales, 45-47 for minutes and elapsed time.
 */
const BUILT_IN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

const BACKSLASH = 92;
const UNDERSCORE = 95;
const ASTERISK = 42;
const QUOTE = 34;
const OPEN_BRACKET = 91;
/** y m d h s b — lowercase, which `code | 0x20` makes of either case. */
const DATE_LETTERS = new Set([121, 109, 100, 104, 115, 98]);

/**
 * Whether a custom number format shows a date or a time, in one left-to-right
 * pass.
 *
 * Excel reads these letters in either case, so this does too. exceljs matched
 * lowercase only (and `M`), so a year column formatted `YYYY` read as a plain
 * 2024 while Excel showed the date that serial number is, 1905. Everything
 * else is a literal: a backslash escapes the next character, `_` and `*` take
 * one for padding and fill, `"..."` is text, and `[...]` holds a colour, a
 * locale or a condition.
 *
 * A scan, not the patterns it replaced: stripping `[...]` with a regex
 * backtracked quadratically on an unclosed bracket (64 KB of `[` took 1.8 s,
 * measured), and a format code comes from the file like everything else.
 *
 * Exported for that last reason alone. The budget that guards it used to sit
 * on a whole workbook read, where 180 ms of XML parsing left it 1.6x from the
 * defect; measured directly it is 0.2 ms against 1,633 ms for a
 * behaviour-preserving regex rewrite, which is a margin no CI runner can
 * close. `xlsx-reader.spec.ts` holds it.
 */
export function isDateFormatCode(code: string): boolean {
  for (let i = 0; i < code.length; i += 1) {
    const char = code.charCodeAt(i);
    if (char === BACKSLASH || char === UNDERSCORE || char === ASTERISK) {
      i += 1;
    } else if (char === QUOTE) {
      const close = code.indexOf('"', i + 1);
      if (close < 0) return false;
      i = close;
    } else if (char === OPEN_BRACKET) {
      const close = code.indexOf(']', i + 1);
      if (close < 0) return false;
      i = close;
    } else if (DATE_LETTERS.has(char | 0x20)) {
      return true;
    }
  }
  return false;
}

function strictInteger(text: string): number | null {
  return /^\d{1,9}$/.test(text) ? Number(text) : null;
}

/**
 * For each cell format (`<xf>` in `<cellXfs>`, by index): is it a date?
 *
 * Each format code is judged ONCE, where it is read. Judging it per cell
 * format multiplied the work by every cell format sharing the id — up to
 * 65,536 — after parsing had finished, where nothing yields: a 7 KB file
 * sharing one 1 MB code held the event loop for 56 s (security-rls, measured).
 */
async function readDateStyles(part: Buffer): Promise<boolean[]> {
  const customDates = new Map<number, boolean>();
  const cellFormats: number[] = [];
  const path: string[] = [];
  const counted = { numberFormats: 0 };
  await parseXml(part, {
    open(tag) {
      const name = spreadsheetName(tag);
      const parent = path[path.length - 1];
      path.push(name);
      if (name === 'numFmt' && parent === 'numFmts') {
        counted.numberFormats += 1;
        const id = strictInteger(plainAttribute(tag, 'numFmtId') ?? '');
        const code = plainAttribute(tag, 'formatCode');
        if (
          counted.numberFormats > MAX_NUMBER_FORMATS ||
          id === null ||
          code === undefined ||
          code.length > MAX_FORMAT_CODE_LENGTH
        ) {
          fail();
        }
        customDates.set(id, isDateFormatCode(code));
      } else if (name === 'xf' && parent === 'cellXfs') {
        if (cellFormats.length >= MAX_CELL_FORMATS) fail();
        const id = plainAttribute(tag, 'numFmtId');
        cellFormats.push(id === undefined ? 0 : (strictInteger(id) ?? fail()));
      }
    },
    close() {
      path.pop();
    },
  });
  return cellFormats.map((id) => customDates.get(id) ?? BUILT_IN_DATE_FORMATS.has(id));
}

const CELL_REF = /^([A-Z]{1,3})([1-9]\d{0,6})$/i;

function parseCellRef(ref: string): { row: number; column: number } | null {
  const [, letters, digits] = CELL_REF.exec(ref) ?? [];
  if (!letters || !digits) return null;
  let column = 0;
  for (const letter of letters.toUpperCase()) {
    column = column * 26 + (letter.charCodeAt(0) - 64);
  }
  const row = Number(digits);
  return column <= MAX_COLUMN && row <= MAX_ROW ? { row, column } : null;
}

function parseRange(ref: string | undefined): MergedRange | null {
  if (ref === undefined || ref.length > 32) return null;
  const [first, second, extra] = ref.split(':');
  if (first === undefined || extra !== undefined) return null;
  const start = parseCellRef(first);
  const end = second === undefined ? start : parseCellRef(second);
  if (start === null || end === null) return null;
  return {
    ref,
    top: Math.min(start.row, end.row),
    bottom: Math.max(start.row, end.row),
    left: Math.min(start.column, end.column),
    right: Math.max(start.column, end.column),
  };
}

/**
 * exceljs's conversion, kept so a date reads as it always has — including
 * Excel's 1900 leap-year quirk, which exceljs does not correct either.
 */
function excelDate(serial: number, date1904: boolean): Date {
  return new Date(Math.round((serial - 25569 + (date1904 ? 1462 : 0)) * 86_400_000));
}

function isoDate(date: Date, row: number, column: number): string {
  // A serial beyond ~100 million days is not a Date at all. `toISOString()`
  // throws a RangeError on one, and that reached the user as a 500.
  if (Number.isNaN(date.getTime())) throw dateOutOfRange(row, column);
  return date.toISOString();
}

interface SheetContext {
  sharedStrings: readonly string[];
  dateStyles: readonly boolean[];
  date1904: boolean;
}

interface OpenCell {
  column: number;
  type: string;
  style: number;
  /** `<v>`, as written. */
  text: string;
  /** `<is>`, decoded run by run. */
  inline: string;
  /** The `<t>` being read inside `<is>`. */
  pending: string;
  /**
   * A second `<v>`, `<is>` or direct `<t>` would be appended to the first:
   * "12" then "00" reads as 1200.
   */
  seenValue: boolean;
  seenInline: boolean;
  directTexts: number;
}

/**
 * Unambiguous on purpose. The first version, `\d+\.?\d*`, backtracked
 * quadratically over a long run of digits that failed at its last character:
 * 32,767 digits and an `x` took 582 ms in one cell (measured).
 */
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * An ISO 8601 date, or date and time, with an optional zone. `new Date()`
 * parses much more than that, in ways the runtime chooses.
 */
const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * A cell as the string the user sees — the same strings exceljs produced, so a
 * row reads as it always has: a number as `String(n)`, a boolean as
 * `true`/`false`, an error as its code (`#REF!`), a date as an ISO timestamp.
 *
 * A formula cell reads as its cached RESULT. Refusing formulas would reject
 * the most ordinary spreadsheet there is, one with a SUM column. A formula
 * whose result is an error reads as the error, so the row is refused naming
 * what the user sees rather than as an empty cell.
 *
 * A date is still a date. A number in a date-formatted cell becomes a
 * timestamp, which every numeric column then refuses — reading the serial
 * behind it (what exceljs's streaming reader does by default) would import
 * "3/4" typed into a consumption column as 46,085 kWh.
 */
function cellValue(cell: OpenCell, row: number, context: SheetContext): string {
  const text = cell.text.trim();
  switch (cell.type) {
    case 's': {
      if (text === '') return '';
      const index = strictInteger(text);
      return (index === null ? undefined : context.sharedStrings[index]) ?? fail();
    }
    case 'inlineStr':
      return cell.inline;
    case 'str':
    case 'e':
      return cell.text;
    case 'b':
      if (text === '') return '';
      if (text === '1') return 'true';
      if (text === '0') return 'false';
      return fail();
    case 'd': {
      if (text === '') return '';
      // A time with no zone is UTC, as a serial date is — not the server's
      // local time, which read the same cell three hours early in Istanbul.
      const [, zone] = ISO_DATE.exec(text) ?? fail();
      const iso = text.includes('T') && zone === undefined ? `${text}Z` : text;
      return isoDate(new Date(iso), row, cell.column);
    }
    case 'n': {
      if (text === '') return '';
      const value = NUMBER.test(text) ? Number(text) : Number.NaN;
      if (!Number.isFinite(value)) fail();
      return context.dateStyles[cell.style]
        ? isoDate(excelDate(value, context.date1904), row, cell.column)
        : String(value);
    }
    default:
      return fail();
  }
}

async function readSheet(
  part: Buffer,
  context: SheetContext,
  visitor: SheetVisitor,
): Promise<void> {
  const path: string[] = [];
  const at = {
    rowOpen: false,
    row: 0,
    lastRow: 0,
    lastColumn: 0,
    sheetDataOpen: false,
    sheetDataClosed: false,
  };
  let cells: SheetCell[] = [];
  let cell: OpenCell | null = null;
  let capture: 'text' | 'inline' | null = null;

  await parseXml(part, {
    open(tag) {
      const name = spreadsheetName(tag);
      const parent = path[path.length - 1];
      const grandparent = path[path.length - 2];
      path.push(name);
      switch (name) {
        case 'sheetData':
          if (parent !== 'worksheet' || at.sheetDataOpen || at.sheetDataClosed) fail();
          at.sheetDataOpen = true;
          break;
        case 'row': {
          if (parent !== 'sheetData') break;
          // Rows and cells must ascend, as Excel writes them. A repeated or
          // backwards reference would let a later cell silently overwrite an
          // earlier one, so it is refused rather than resolved.
          const ref = plainAttribute(tag, 'r');
          const number = ref === undefined ? at.lastRow + 1 : strictInteger(ref);
          if (number === null || number <= at.lastRow || number > MAX_ROW) fail();
          at.rowOpen = true;
          at.row = number;
          at.lastColumn = 0;
          cells = [];
          break;
        }
        case 'c': {
          if (parent !== 'row' || !at.rowOpen) break;
          const ref = plainAttribute(tag, 'r');
          const position =
            ref === undefined
              ? { row: at.row, column: at.lastColumn + 1 }
              : parseCellRef(ref);
          if (
            position === null ||
            position.row !== at.row ||
            position.column <= at.lastColumn ||
            position.column > MAX_COLUMN
          ) {
            fail();
          }
          const style = plainAttribute(tag, 's');
          cell = {
            column: position.column,
            type: plainAttribute(tag, 't') ?? 'n',
            style: style === undefined ? 0 : (strictInteger(style) ?? fail()),
            text: '',
            inline: '',
            pending: '',
            seenValue: false,
            seenInline: false,
            directTexts: 0,
          };
          break;
        }
        case 'v':
          if (parent === 'c' && cell) {
            if (cell.seenValue) fail();
            cell.seenValue = true;
            capture = 'text';
          }
          break;
        case 'is':
          if (parent === 'c' && cell) {
            if (cell.seenInline) fail();
            cell.seenInline = true;
          }
          break;
        case 't':
          // An inline string's own text and its rich-text runs. A phonetic
          // run's text sits under `<rPh>` and is not in the cell.
          if (!cell) break;
          if (parent === 'is') {
            cell.directTexts += 1;
            if (cell.directTexts > 1) fail();
          } else if (parent !== 'r' || grandparent !== 'is') {
            break;
          }
          cell.pending = '';
          capture = 'inline';
          break;
        case 'mergeCell': {
          if (parent !== 'mergeCells') break;
          // Merges are checked against the rows already read, so they must come
          // after them, which is where the schema puts them.
          if (!at.sheetDataClosed) fail();
          const range = parseRange(plainAttribute(tag, 'ref')) ?? fail();
          if (range.top !== range.bottom || range.left !== range.right) {
            visitor.merge(range);
          }
          break;
        }
      }
    },
    close() {
      const name = path.pop();
      const parent = path[path.length - 1];
      switch (name) {
        case 'v':
          capture = null;
          break;
        case 't':
          if (capture === 'inline' && cell) {
            cell.inline = appendCellText(cell.inline, decodeEscapes(cell.pending));
          }
          capture = null;
          break;
        case 'c':
          if (parent === 'row' && cell) {
            const value = cellValue(cell, at.row, context);
            if (value !== '') cells.push({ column: cell.column, value });
            at.lastColumn = cell.column;
            cell = null;
          }
          break;
        case 'row':
          if (parent === 'sheetData' && at.rowOpen) {
            at.rowOpen = false;
            at.lastRow = at.row;
            if (cells.length > 0) visitor.row(at.row, cells);
          }
          break;
        case 'sheetData':
          if (parent === 'worksheet') {
            at.sheetDataOpen = false;
            at.sheetDataClosed = true;
          }
          break;
      }
    },
    text(chunk) {
      if (cell === null || capture === null) return;
      if (capture === 'text') cell.text = appendCellText(cell.text, chunk);
      else cell.pending = appendCellText(cell.pending, chunk);
    },
  });
  if (!at.sheetDataClosed) fail();
}
