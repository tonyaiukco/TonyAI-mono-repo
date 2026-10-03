import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  EVIDENCE_ALLOWED_MIME_TYPES,
  EVIDENCE_MAX_SIZE_BYTES,
} from '@tonyai/shared-types';
import { UnpackBudget, ZipArchive } from '../bulk-upload/zip-reader';
import { sanitiseCallerText } from '../common/caller-text';

/*
 * What an evidence upload must be before it is stored (LP1-02; scanning policy
 * decided 2026-10-03: no malware scanning in the pilot — content validation,
 * attachment-only downloads from Storage's own origin, and no server-side
 * rendering of a file, with the residual risk re-assessed at the LP5-02
 * pen-test).
 *
 * The declared MIME type is the browser's guess from the file name, so it is
 * checked against the bytes: a file is stored only when its contents ARE the
 * type it claims. What each check accepts:
 *  - PDF: `%PDF-` within the first 1,024 bytes — where readers look for it;
 *  - PNG / JPEG: the format's signature;
 *  - XLSX: a ZIP whose `[Content_Types].xml` declares a spreadsheetml
 *    workbook, refused when it carries a VBA project in the forms an Office
 *    reader honours — a macro-enabled, VBA or Excel 4.0 macro-sheet content
 *    type or workbook
 *    relationship (XML character references decoded first), or any part
 *    whose name says vbaProject (a renamed .xlsm). Parts that could hide
 *    those words are refused outright: a DTD or an entity reference XML
 *    does not predefine (OPC forbids DTDs), a UTF-16 part, a second
 *    `[Content_Types].xml`. Embedded OLE objects and DDE links are NOT
 *    refused: they are the residual risk K1 accepts, named for the LP5-02
 *    pen-test;
 *  - CSV: text — no NUL or other C0 control byte besides tab, LF, CR and FF.
 *    The encoding is not judged: Turkish Excel saves CSV as Windows-1254.
 */

export type EvidenceMimeType = (typeof EVIDENCE_ALLOWED_MIME_TYPES)[number];

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Extensions a download of each type may keep; the first is the one added when the name has none of them. */
const EXTENSIONS: Record<EvidenceMimeType, readonly string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  [XLSX]: ['.xlsx'],
  'text/csv': ['.csv', '.txt'],
};

const LABELS: Record<EvidenceMimeType, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  [XLSX]: 'XLSX',
  'text/csv': 'CSV',
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP_LOCAL_HEADER = 0x04034b50;
/** `[Content_Types].xml` is a few kilobytes; a megabyte of it is not a workbook. */
const CONTENT_TYPES_BUDGET_BYTES = 1024 * 1024;
/** The stored name is bounded like every other caller text; the column is TEXT. */
const FILE_NAME_MAX_CODE_POINTS = 255;

export function isEvidenceMimeType(value: string): value is EvidenceMimeType {
  return (EVIDENCE_ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}

/** What `checkEvidenceFile` returns: the facts to store, all derived from the upload itself. */
export interface CheckedEvidenceFile {
  mimeType: EvidenceMimeType;
  /** The caller's name, made storable and safe to show (`sanitiseCallerText`). */
  fileName: string;
  /** Hex SHA-256 of the bytes — the file's content identity. */
  sha256: string;
}

type XlsxVerdict = 'workbook' | 'macro' | 'other';

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text with its character and entity references resolved: `macro&#69;nabled` must read as `macroEnabled`. */
function decodeXmlText(xml: string): string {
  return xml.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== '#') return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

// Excel 4.0 macro sheets (`macrosheet`, `intlmacrosheet`) run code too.
const MACRO = /macroEnabled|vbaProject|macrosheet/i;

/** An `&` that does not open a reference XML predefines — legal only with a DTD, which OPC forbids. */
const UNDECLARED_REFERENCE = /&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-f]+);)/i;

/**
 * A part's text, references decoded — or null for a part that could spell a
 * word without containing it: UTF-16 (a BOM, or the NULs of its ASCII), a
 * DTD, or a reference XML does not predefine.
 */
function partText(part: Buffer): string | null {
  if (part.includes(0) || (part.length >= 2 && ((part[0] === 0xfe && part[1] === 0xff) || (part[0] === 0xff && part[1] === 0xfe)))) {
    return null;
  }
  const raw = part.toString('utf8');
  if (/<!(?:DOCTYPE|ENTITY)/i.test(raw) || UNDECLARED_REFERENCE.test(raw)) return null;
  return decodeXmlText(raw);
}

function occurrences(haystack: string, needle: RegExp): number {
  return haystack.match(needle)?.length ?? 0;
}

function xlsxVerdict(bytes: Buffer): XlsxVerdict {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== ZIP_LOCAL_HEADER) return 'other';
  // Entry names are stored uncompressed — in each local header and again in
  // the central directory — so the raw bytes name every part. Any part named
  // vbaProject, at any path or with any separator, is a macro project.
  const raw = bytes.toString('latin1');
  if (/vbaproject/i.test(raw)) return 'macro';
  // One content-types part has its name exactly twice; a second spelling of
  // it (`/[Content_Types].xml`) is a part some reader might pick instead.
  if (occurrences(raw, /\[content_types\]\.xml/gi) !== 2) return 'other';
  try {
    const archive = ZipArchive.open(bytes);
    // One budget for every part read here, as the importer's reader does.
    const budget = new UnpackBudget(CONTENT_TYPES_BUDGET_BYTES);
    const typesPart = archive.read('[Content_Types].xml', budget);
    if (!typesPart) return 'other';
    const types = partText(typesPart);
    if (types === null) return 'other';
    const relationshipsPart = archive.read('xl/_rels/workbook.xml.rels', budget);
    const relationships = relationshipsPart ? partText(relationshipsPart) : '';
    if (relationships === null) return 'other';
    if (MACRO.test(types) || MACRO.test(relationships)) return 'macro';
    return /spreadsheetml\.sheet\.main\+xml/i.test(types) ? 'workbook' : 'other';
  } catch {
    return 'other';
  }
}

function isText(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      return false;
    }
  }
  return true;
}

/** Whether the bytes are what `declared` says they are. */
function contentMatches(declared: EvidenceMimeType, bytes: Buffer): boolean | 'macro' {
  switch (declared) {
    case 'application/pdf':
      return bytes.subarray(0, 1024).includes('%PDF-');
    case 'image/png':
      return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case XLSX: {
      const verdict = xlsxVerdict(bytes);
      return verdict === 'macro' ? 'macro' : verdict === 'workbook';
    }
    case 'text/csv':
      return isText(bytes);
  }
}

/**
 * Refuse a file that is not an allowed type, too large, empty, or not what it
 * claims to be; otherwise return what to store about it. Every refusal is a
 * 400 the uploader can act on.
 */
export function checkEvidenceFile(file: Express.Multer.File | undefined): CheckedEvidenceFile {
  if (!file) throw new BadRequestException('No file provided');
  const declared = file.mimetype;
  if (!isEvidenceMimeType(declared)) {
    throw new BadRequestException(
      `Unsupported file type "${declared}". Allowed: PDF, JPG, PNG, XLSX, CSV.`,
    );
  }
  if (file.size > EVIDENCE_MAX_SIZE_BYTES) {
    throw new BadRequestException('File exceeds the 10 MB limit');
  }
  const bytes = file.buffer;
  if (!bytes || bytes.length === 0) throw new BadRequestException('The file is empty.');
  const matches = contentMatches(declared, bytes);
  if (matches === 'macro') {
    throw new BadRequestException(
      'Workbooks with macros cannot be evidence. Save a copy as an .xlsx workbook without macros and upload that.',
    );
  }
  if (!matches) {
    throw new BadRequestException(
      `The file's contents are not a ${LABELS[declared]} file, although its name or type says so. Upload the original document.`,
    );
  }
  return {
    mimeType: declared,
    fileName: storedFileName(file.originalname, declared),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function storedFileName(original: string | undefined, mimeType: EvidenceMimeType): string {
  const name = sanitiseCallerText(original, FILE_NAME_MAX_CODE_POINTS);
  return name.trim().length > 0 ? name : `evidence${EXTENSIONS[mimeType][0]}`;
}

/**
 * The name a download is saved under: the stored name, with the type's
 * extension added when it has none of the type's own — so `fatura` and
 * `fatura.html` holding a PDF are saved as `….pdf`, and a browser never opens
 * a download as something other than what was checked. Files stored before
 * LP1-02 keep their name when their type is not one this knows.
 */
export function downloadName(fileName: string, mimeType: string): string {
  if (!isEvidenceMimeType(mimeType)) return fileName;
  const allowed = EXTENSIONS[mimeType];
  return allowed.includes(extname(fileName).toLowerCase()) ? fileName : `${fileName}${allowed[0]}`;
}
