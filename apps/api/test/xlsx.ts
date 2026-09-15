import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Hand-built `.xlsx` files for the bulk-upload parser specs.
 *
 * The ordinary fixtures use exceljs's writer, and they should: a real writer's
 * output is what users upload. These are the files a writer cannot produce.
 * exceljs expands a declared merge or defined name while AUTHORING it, the same
 * way its loader did, and no writer emits an archive that lies about its sizes
 * or XML nested a hundred deep. The defences under test are about exactly
 * those bytes, so they are laid out by hand here.
 */

export interface ZipPart {
  name: string;
  data: string | Buffer;
  /** `deflate` unless told otherwise. */
  method?: 'deflate' | 'store';
  /** A compression method number written as-is, for "unsupported method". */
  rawMethod?: number;
  /** The size the archive CLAIMS — defaults to the truth. */
  declaredSize?: number;
  /** General-purpose flags; defaults to "names are UTF-8". */
  flags?: number;
}

export function zip(parts: readonly ZipPart[]): Buffer {
  const chunks: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const raw =
      typeof part.data === 'string' ? Buffer.from(part.data, 'utf8') : part.data;
    const method = part.rawMethod ?? (part.method === 'store' ? 0 : 8);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(part.name, 'utf8');
    const flags = part.flags ?? 0x0800;
    const crc = crc32(raw);
    const declared = part.declaredSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralDirectory, end]);
}

/** Where the central directory starts, for specs that corrupt it on purpose. */
export function centralDirectoryOffset(archive: Buffer): number {
  return archive.readUInt32LE(archive.length - 22 + 16);
}

export const SPREADSHEETML =
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const OFFICE_RELATIONSHIPS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const PACKAGE_RELATIONSHIPS =
  'http://schemas.openxmlformats.org/package/2006/relationships';

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 1 → A, 27 → AA, 16384 → XFD. */
export function columnLetters(column: number): string {
  let letters = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/**
 * One `<row>` of inline strings and numbers. `null` leaves the cell out
 * entirely, which is what Excel writes for a cleared cell.
 */
export function row(
  rowNumber: number,
  values: readonly (string | number | null)[],
): string {
  const cells = values.map((value, index) => {
    if (value === null) return '';
    const ref = `${columnLetters(index + 1)}${rowNumber}`;
    return typeof value === 'number'
      ? `<c r="${ref}"><v>${value}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  });
  return `<row r="${rowNumber}">${cells.join('')}</row>`;
}

export interface WorkbookSpec {
  /** Everything inside `<sheetData>`. */
  sheetData?: string;
  /** Inside `<worksheet>`, before `<sheetData>` — `<cols>`, say. */
  beforeSheetData?: string;
  /** Inside `<worksheet>`, after `</sheetData>` — merges, validations, links. */
  afterSheetData?: string;
  /** `<si>` bodies. Omitted: the workbook has no shared-strings part. */
  sharedStrings?: readonly string[];
  /** Everything inside `<styleSheet>`. Omitted: no styles part. */
  styles?: string;
  /** Attributes for `<workbookPr>`, e.g. `date1904="1"`. */
  workbookPr?: string;
  /** Inside `<workbook>`, after `<sheets>` — `<definedNames>`, say. */
  afterSheets?: string;
  /** Replaces the whole worksheet part: a prolog, a prefix, a byte-order mark. */
  sheetXml?: string | Buffer;
  /** Replaces the whole workbook part. */
  workbookXml?: string;
  /** Replaces the workbook's relationships part. */
  workbookRelsXml?: string;
  /** More archive entries: a second sheet, or a bomb in a part never read. */
  extraParts?: readonly ZipPart[];
  /** Parts to leave out of the archive entirely. */
  omit?: readonly string[];
}

/**
 * A minimal but complete workbook with ONE worksheet, laid out the way Excel
 * orders an archive (the sheet before the shared strings).
 */
export function xlsx(spec: WorkbookSpec): Buffer {
  const relationships = [
    `<Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/>`,
  ];
  const parts: ZipPart[] = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data:
        spec.workbookXml ??
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${SPREADSHEETML}" xmlns:r="${OFFICE_RELATIONSHIPS}">${
          spec.workbookPr ? `<workbookPr ${spec.workbookPr}/>` : ''
        }<sheets><sheet name="Records" sheetId="1" r:id="rId1"/></sheets>${spec.afterSheets ?? ''}</workbook>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        spec.sheetXml ??
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SPREADSHEETML}" xmlns:r="${OFFICE_RELATIONSHIPS}">${
          spec.beforeSheetData ?? ''
        }<sheetData>${spec.sheetData ?? ''}</sheetData>${spec.afterSheetData ?? ''}</worksheet>`,
    },
  ];
  if (spec.sharedStrings) {
    relationships.push(
      `<Relationship Id="rId2" Type="${OFFICE_RELATIONSHIPS}/sharedStrings" Target="sharedStrings.xml"/>`,
    );
    parts.push({
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${SPREADSHEETML}">${spec.sharedStrings
        .map((body) => `<si>${body}</si>`)
        .join('')}</sst>`,
    });
  }
  if (spec.styles !== undefined) {
    relationships.push(
      `<Relationship Id="rId3" Type="${OFFICE_RELATIONSHIPS}/styles" Target="styles.xml"/>`,
    );
    parts.push({
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${SPREADSHEETML}">${spec.styles}</styleSheet>`,
    });
  }
  parts.push({
    name: 'xl/_rels/workbook.xml.rels',
    data:
      spec.workbookRelsXml ??
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PACKAGE_RELATIONSHIPS}">${relationships.join('')}</Relationships>`,
  });
  const omitted = new Set(spec.omit ?? []);
  return zip(
    [...parts, ...(spec.extraParts ?? [])].filter((part) => !omitted.has(part.name)),
  );
}
