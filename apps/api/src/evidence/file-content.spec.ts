import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { zip } from '../../test/xlsx';
import { checkEvidenceFile, downloadName } from './file-content';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function file(mimetype: string, buffer: Buffer, originalname = 'evidence'): Express.Multer.File {
  return { originalname, mimetype, buffer, size: buffer.length } as Express.Multer.File;
}

function contentTypes(main: string, extra = ''): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    `<Override PartName="/xl/workbook.xml" ContentType="${main}"/>${extra}</Types>`
  );
}

const WORKBOOK = zip([
  { name: '[Content_Types].xml', data: contentTypes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') },
  { name: 'xl/workbook.xml', data: '<workbook/>' },
]);

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).message;
  }
  throw new Error('expected a refusal');
}

describe('checkEvidenceFile — the bytes must be what the upload claims', () => {
  it('accepts a PDF, an image, a workbook and a CSV whose bytes match their type', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    expect(checkEvidenceFile(file('application/pdf', Buffer.from('%PDF-1.7\n'))).mimeType).toBe('application/pdf');
    expect(checkEvidenceFile(file('image/png', png)).mimeType).toBe('image/png');
    expect(checkEvidenceFile(file('image/jpeg', jpeg)).mimeType).toBe('image/jpeg');
    expect(checkEvidenceFile(file(XLSX, WORKBOOK)).mimeType).toBe(XLSX);
    expect(checkEvidenceFile(file('text/csv', Buffer.from('a;b\r\n1,5;2\n'))).mimeType).toBe('text/csv');
  });

  it('finds a PDF header within the first 1,024 bytes, where readers look, and not after', () => {
    const late = (at: number) => Buffer.concat([Buffer.alloc(at, 0x20), Buffer.from('%PDF-1.4')]);
    // `%PDF-` is five bytes: the last start that fits is 1,019.
    expect(() => checkEvidenceFile(file('application/pdf', late(1019)))).not.toThrow();
    expect(refusal(() => checkEvidenceFile(file('application/pdf', late(1020))))).toMatch(/not a PDF file/);
  });

  it('refuses bytes of another type behind an allowed one — HTML as PDF, a PDF as PNG, an image as CSV', () => {
    expect(refusal(() => checkEvidenceFile(file('application/pdf', Buffer.from('<html><script>'))))).toMatch(
      /not a PDF file/,
    );
    expect(refusal(() => checkEvidenceFile(file('image/png', Buffer.from('%PDF-1.4'))))).toMatch(/not a PNG file/);
    expect(refusal(() => checkEvidenceFile(file('image/jpeg', Buffer.from('%PDF-1.4'))))).toMatch(/not a JPG file/);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(refusal(() => checkEvidenceFile(file('text/csv', png)))).toMatch(/not a CSV file/);
  });

  it('checks the WHOLE signature, not a prefix of it', () => {
    // The first four PNG bytes, then garbage where CR LF SUB LF belong.
    const halfPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(refusal(() => checkEvidenceFile(file('image/png', halfPng)))).toMatch(/not a PNG file/);
    // FF D8 is a JPEG start of image only with the FF that opens the next marker.
    expect(refusal(() => checkEvidenceFile(file('image/jpeg', Buffer.from([0xff, 0xd8, 0x00, 0x10]))))).toMatch(
      /not a JPG file/,
    );
  });

  it('keeps the whitespace text files really contain — tab, line feed, carriage return, form feed', () => {
    expect(() => checkEvidenceFile(file('text/csv', Buffer.from('a\tb\r\nc\fd\n')))).not.toThrow();
  });

  it('judges CSV as text without judging its encoding — Windows-1254 passes, a NUL byte does not', () => {
    // "Şubat;1,5" in Windows-1254: Ş = 0xDE.
    const cp1254 = Buffer.from([0xde, 0x75, 0x62, 0x61, 0x74, 0x3b, 0x31, 0x2c, 0x35, 0x0d, 0x0a]);
    expect(() => checkEvidenceFile(file('text/csv', cp1254))).not.toThrow();
    expect(refusal(() => checkEvidenceFile(file('text/csv', Buffer.from('a,b\u0000c'))))).toMatch(/not a CSV file/);
    expect(refusal(() => checkEvidenceFile(file('text/csv', Buffer.from('a,b\u001bc'))))).toMatch(/not a CSV file/);
  });

  it('refuses a workbook declaring macros or a VBA project — a renamed .xlsm', () => {
    const macro = zip([
      { name: '[Content_Types].xml', data: contentTypes('application/vnd.ms-excel.sheet.macroEnabled.main+xml') },
    ]);
    const vba = zip([
      {
        name: '[Content_Types].xml',
        data: contentTypes(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
          '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>',
        ),
      },
    ]);
    expect(refusal(() => checkEvidenceFile(file(XLSX, macro)))).toMatch(/macros/);
    expect(refusal(() => checkEvidenceFile(file(XLSX, vba)))).toMatch(/macros/);
  });

  it('refuses a VBA project however it is spelled or hidden (security-rls, LP1-02)', () => {
    const workbookTypes = contentTypes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
    // XML character references in the content type: still macro-enabled.
    const encoded = zip([
      { name: '[Content_Types].xml', data: contentTypes('application/vnd.ms-excel.sheet.macro&#69;nabled.main+xml') },
    ]);
    const encodedVba = zip([
      {
        name: '[Content_Types].xml',
        data: contentTypes(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
          '<Override PartName="/xl/vba&#x50;roject.bin" ContentType="application/vnd.ms-office.vba&#80;roject"/>',
        ),
      },
    ]);
    // Undeclared, but present where a reader looks for it.
    const undeclared = zip([
      { name: '[Content_Types].xml', data: workbookTypes },
      { name: 'xl/workbook.xml', data: '<workbook/>' },
      { name: 'XL/VBAPROJECT.BIN', data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) },
    ]);
    // Declared only in the workbook's relationships.
    const related = zip([
      { name: '[Content_Types].xml', data: workbookTypes },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: '<Relationships><Relationship Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="code.bin"/></Relationships>',
      },
    ]);
    for (const [label, archive] of Object.entries({ encoded, encodedVba, undeclared, related })) {
      expect(refusal(() => checkEvidenceFile(file(XLSX, archive))), label).toMatch(/macros/);
    }
    // A DTD splitting the token across entities; a part in UTF-16; a second
    // content-types part; a VBA part behind a backslash (security-rls, round 2).
    const dtd = zip([
      {
        name: '[Content_Types].xml',
        data:
          '<!DOCTYPE Types [<!ENTITY a "macro"><!ENTITY b "Enabled">]>' +
          contentTypes('application/vnd.ms-excel.sheet.&a;&b;.main+xml'),
      },
    ]);
    const undefinedEntity = zip([
      { name: '[Content_Types].xml', data: contentTypes('application/vnd.ms-excel.sheet.&macro;.main+xml') },
    ]);
    const utf16Rels = zip([
      { name: '[Content_Types].xml', data: workbookTypes },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from('<Relationships><Relationship Type="vbaProject"/></Relationships>', 'utf16le'),
        ]),
      },
    ]);
    const secondTypes = zip([
      { name: '[Content_Types].xml', data: workbookTypes },
      { name: '/[Content_Types].xml', data: contentTypes('application/vnd.ms-excel.sheet.macroEnabled.main+xml') },
    ]);
    const backslash = zip([
      { name: '[Content_Types].xml', data: workbookTypes },
      { name: 'xl\\vbaProject.bin', data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) },
    ]);
    expect(refusal(() => checkEvidenceFile(file(XLSX, dtd))), 'dtd').toMatch(/not a XLSX file/);
    expect(refusal(() => checkEvidenceFile(file(XLSX, undefinedEntity))), 'entity').toMatch(/not a XLSX file/);
    expect(refusal(() => checkEvidenceFile(file(XLSX, utf16Rels))), 'utf16').toMatch(/not a XLSX file|macros/);
    expect(refusal(() => checkEvidenceFile(file(XLSX, secondTypes))), 'second types').toMatch(/not a XLSX file|macros/);
    expect(refusal(() => checkEvidenceFile(file(XLSX, backslash))), 'backslash').toMatch(/macros/);
    // A named entity a real file may use is still read as text, not refused.
    const amp = zip([
      {
        name: '[Content_Types].xml',
        data: contentTypes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml', '<!-- R&amp;D -->'),
      },
    ]);
    expect(checkEvidenceFile(file(XLSX, amp)).mimeType).toBe(XLSX);
  });

  it('refuses a ZIP that is not a workbook, and bytes that are not a ZIP', () => {
    const docx = zip([
      {
        name: '[Content_Types].xml',
        data: contentTypes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),
      },
    ]);
    const noTypes = zip([{ name: 'xl/workbook.xml', data: '<workbook/>' }]);
    expect(refusal(() => checkEvidenceFile(file(XLSX, docx)))).toMatch(/not a XLSX file/);
    expect(refusal(() => checkEvidenceFile(file(XLSX, noTypes)))).toMatch(/not a XLSX file/);
    expect(refusal(() => checkEvidenceFile(file(XLSX, Buffer.from('PK\u0003\u0004 broken'))))).toMatch(/not a XLSX file/);
    expect(refusal(() => checkEvidenceFile(file(XLSX, Buffer.from('%PDF-1.4'))))).toMatch(/not a XLSX file/);
  });

  it('keeps the earlier refusals: no file, a type off the list, over 10 MB — and adds an empty file', () => {
    expect(refusal(() => checkEvidenceFile(undefined))).toBe('No file provided');
    expect(refusal(() => checkEvidenceFile(file('text/html', Buffer.from('<html>'))))).toMatch(/Unsupported file type/);
    const big = { ...file('application/pdf', Buffer.from('%PDF-')), size: 10 * 1024 * 1024 + 1 };
    expect(refusal(() => checkEvidenceFile(big))).toMatch(/10 MB/);
    expect(refusal(() => checkEvidenceFile(file('application/pdf', Buffer.alloc(0))))).toMatch(/empty/);
  });

  it('returns the SHA-256 of the bytes as the content identity', () => {
    const bytes = Buffer.from('%PDF-1.4 invoice');
    expect(checkEvidenceFile(file('application/pdf', bytes)).sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  it('cleans the stored name — no format or control characters — and keeps Turkish letters', () => {
    const rlo = String.fromCharCode(0x202e);
    const nul = String.fromCharCode(0);
    const pdf = Buffer.from('%PDF-1.4');
    expect(checkEvidenceFile(file('application/pdf', pdf, `fatura${rlo}fdp.exe`)).fileName).toBe('faturafdp.exe');
    expect(checkEvidenceFile(file('application/pdf', pdf, `a${nul}b.pdf`)).fileName).toBe('ab.pdf');
    expect(checkEvidenceFile(file('application/pdf', pdf, 'Şubat-Faturası-İĞÜÖÇ.pdf')).fileName).toBe(
      'Şubat-Faturası-İĞÜÖÇ.pdf',
    );
    // Nothing left to show: a name the user can still recognise by type.
    expect(checkEvidenceFile(file('application/pdf', pdf, rlo)).fileName).toBe('evidence.pdf');
    expect(checkEvidenceFile(file('application/pdf', pdf, '   ')).fileName).toBe('evidence.pdf');
    expect([...checkEvidenceFile(file('application/pdf', pdf, 'x'.repeat(400))).fileName]).toHaveLength(255);
  });
});

describe('downloadName — a download is saved under its checked type', () => {
  it('keeps a name that already carries one of the type\'s extensions, in any case', () => {
    expect(downloadName('fatura.pdf', 'application/pdf')).toBe('fatura.pdf');
    expect(downloadName('PHOTO.JPEG', 'image/jpeg')).toBe('PHOTO.JPEG');
    expect(downloadName('meter.txt', 'text/csv')).toBe('meter.txt');
  });

  it('adds the type\'s extension to a name without it, or with another one', () => {
    expect(downloadName('fatura', 'application/pdf')).toBe('fatura.pdf');
    // The type's FIRST extension — the usual one — is the one added.
    expect(downloadName('photo', 'image/jpeg')).toBe('photo.jpg');
    expect(downloadName('meter', 'text/csv')).toBe('meter.csv');
    expect(downloadName('fatura.html', 'application/pdf')).toBe('fatura.html.pdf');
    expect(downloadName('sheet.xlsm', XLSX)).toBe('sheet.xlsm.xlsx');
  });

  it('leaves a file stored under a type it does not know as it was', () => {
    expect(downloadName('legacy.bin', 'application/octet-stream')).toBe('legacy.bin');
  });
});
