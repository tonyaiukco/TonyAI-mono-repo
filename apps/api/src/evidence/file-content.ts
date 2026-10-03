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
 *    workbook, refused when it declares macros or a VBA project (a renamed
 *    .xlsm);
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

function xlsxVerdict(bytes: Buffer): XlsxVerdict {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== ZIP_LOCAL_HEADER) return 'other';
  let types: string;
  try {
    const part = ZipArchive.open(bytes).read(
      '[Content_Types].xml',
      new UnpackBudget(CONTENT_TYPES_BUDGET_BYTES),
    );
    if (!part) return 'other';
    types = part.toString('utf8');
  } catch {
    return 'other';
  }
  if (/macroEnabled|vbaProject/i.test(types)) return 'macro';
  return /spreadsheetml\.sheet\.main\+xml/i.test(types) ? 'workbook' : 'other';
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
