import { describe, expect, it, vi } from 'vitest';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { BadRequestException } from '@nestjs/common';
import { centralDirectoryOffset, zip } from '../../test/xlsx';
import { UnpackBudget, WORKBOOK_UNREADABLE, ZipArchive } from './zip-reader';

// The real zlib, watched: one test asserts the limit the reader hands it.
vi.mock('node:zlib', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return { ...actual, inflateRawSync: vi.fn(actual.inflateRawSync as never) };
});

const MIB = 1024 * 1024;
const budget = (bytes = MIB) => new UnpackBudget(bytes);

/**
 * The refusal a caller gets — the class as well as the words. Anything that is
 * not an HttpException reaches the user as a 500, which for an upload is the
 * difference between "fix your file" and "the product is broken".
 */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as Error).message;
  }
  throw new Error('Expected a refusal, and the call returned.');
}

describe('ZipArchive — reading', () => {
  it('reads stored and deflated parts, matching names case-insensitively', () => {
    const archive = ZipArchive.open(
      zip([
        { name: 'xl/workbook.xml', data: '<workbook/>' },
        { name: 'xl/styles.xml', data: '<styleSheet/>', method: 'store' },
      ]),
    );
    expect(archive.read('XL/Workbook.xml', budget())?.toString()).toBe('<workbook/>');
    expect(archive.read('xl/styles.xml', budget())?.toString()).toBe('<styleSheet/>');
  });

  it('answers undefined for a part the archive does not have', () => {
    const archive = ZipArchive.open(zip([{ name: 'a.xml', data: '<a/>' }]));
    expect(archive.read('b.xml', budget())).toBeUndefined();
  });

  it('refuses bytes that are not an archive at all', () => {
    expect(refusal(() => ZipArchive.open(Buffer.from('not a zip')))).toBe(
      WORKBOOK_UNREADABLE,
    );
    expect(refusal(() => ZipArchive.open(Buffer.alloc(0)))).toBe(WORKBOOK_UNREADABLE);
  });

  it('refuses a ZIP64 archive: its placeholder counts fail the bounds checks', () => {
    const archive = zip([{ name: 'a.xml', data: '<a/>' }]);
    archive.writeUInt16LE(0xffff, archive.length - 22 + 8);
    archive.writeUInt16LE(0xffff, archive.length - 22 + 10);
    expect(refusal(() => ZipArchive.open(archive))).toBe(WORKBOOK_UNREADABLE);
  });

  it('finds the directory past a comment that happens to contain its signature', () => {
    // The record is the one whose comment ends where the file does, not the
    // last four bytes that spell its signature.
    const base = zip([{ name: 'a.xml', data: '<a/>' }]);
    const comment = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.alloc(40, 0x41),
    ]);
    const archive = Buffer.concat([base, comment]);
    archive.writeUInt16LE(comment.length, base.length - 2);
    expect(ZipArchive.open(archive).read('a.xml', budget())?.toString()).toBe('<a/>');
  });

  it('refuses two parts whose names differ only by case', () => {
    const archive = zip([
      { name: 'xl/workbook.xml', data: '<workbook>one</workbook>' },
      { name: 'XL/WORKBOOK.XML', data: '<workbook>two</workbook>' },
    ]);
    expect(refusal(() => ZipArchive.open(archive))).toBe(WORKBOOK_UNREADABLE);
  });

  it('refuses an encrypted or unsupported part only when that part is read', () => {
    const archive = ZipArchive.open(
      zip([
        { name: 'docProps/thumbnail.jpeg', data: 'x', flags: 0x0801 },
        // Bytes that WOULD inflate, so only the method check can refuse them.
        {
          name: 'xl/media/image1.bin',
          data: deflateRawSync(Buffer.from('<y/>')),
          rawMethod: 12,
        },
        { name: 'xl/workbook.xml', data: '<workbook/>' },
      ]),
    );
    expect(archive.read('xl/workbook.xml', budget())?.toString()).toBe('<workbook/>');
    expect(refusal(() => archive.read('docProps/thumbnail.jpeg', budget()))).toBe(
      WORKBOOK_UNREADABLE,
    );
    expect(refusal(() => archive.read('xl/media/image1.bin', budget()))).toBe(
      WORKBOOK_UNREADABLE,
    );
  });

  it('refuses a local header that names a different part than the directory', () => {
    const archive = zip([{ name: 'xl/workbook.xml', data: '<workbook/>' }]);
    archive.write('X', 30); // first byte of the LOCAL header's copy of the name
    expect(
      refusal(() => ZipArchive.open(archive).read('xl/workbook.xml', budget())),
    ).toBe(WORKBOOK_UNREADABLE);
  });

  it('refuses a part whose data would run into the central directory', () => {
    // Stored, so the overrun cannot fail as bad deflate data instead.
    const archive = zip([{ name: 'a.xml', data: '<a/>', method: 'store' }]);
    archive.writeUInt32LE(0x7fffffff, centralDirectoryOffset(archive) + 20);
    expect(refusal(() => ZipArchive.open(archive).read('a.xml', budget()))).toBe(
      WORKBOOK_UNREADABLE,
    );
  });

  it('refuses a truncated deflate stream as unreadable, not as a crash', () => {
    const archive = zip([{ name: 'a.xml', data: '<a>'.repeat(1000) }]);
    const sizeAt = centralDirectoryOffset(archive) + 20;
    archive.writeUInt32LE(archive.readUInt32LE(sizeAt) - 4, sizeAt);
    expect(refusal(() => ZipArchive.open(archive).read('a.xml', budget()))).toBe(
      WORKBOOK_UNREADABLE,
    );
  });
});

describe('UnpackBudget — the limit zlib enforces, not the one the archive claims', () => {
  const tooLarge =
    'The workbook is larger than 1 MB once unpacked. Remove unused formatting, or split it into smaller files.';

  it('stops inflating at the limit when the archive declares a tiny size', () => {
    // The lie a zip bomb tells: 16 MiB of XML, packed small, declared as 10 bytes.
    const bomb = zip([
      { name: 'sheet.xml', data: Buffer.alloc(16 * MIB, 0x61), declaredSize: 10 },
    ]);
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(refusal(() => ZipArchive.open(bomb).read('sheet.xml', budget()))).toBe(
      tooLarge,
    );
  });

  it('counts a stored part against the limit too', () => {
    const archive = zip([
      {
        name: 'sheet.xml',
        data: Buffer.alloc(2 * MIB, 0x61),
        method: 'store',
        declaredSize: 10,
      },
    ]);
    expect(refusal(() => ZipArchive.open(archive).read('sheet.xml', budget()))).toBe(
      tooLarge,
    );
  });

  it('is ONE budget for every part a workbook opens', () => {
    const archive = ZipArchive.open(
      zip([
        { name: 'a.xml', data: Buffer.alloc(600 * 1024, 0x61) },
        { name: 'b.xml', data: Buffer.alloc(600 * 1024, 0x62) },
      ]),
    );
    const shared = budget();
    expect(archive.read('a.xml', shared)).toHaveLength(600 * 1024);
    expect(refusal(() => archive.read('b.xml', shared))).toBe(tooLarge);
    // Each part alone fits, so a budget per part would have read both.
    expect(archive.read('b.xml', budget())).toHaveLength(600 * 1024);
  });

  it('refuses early from a declared size that is already over', () => {
    const archive = ZipArchive.open(
      zip([{ name: 'a.xml', data: '<a/>', declaredSize: 2 * MIB }]),
    );
    expect(refusal(() => archive.read('a.xml', budget()))).toBe(tooLarge);
  });

  it('asks zlib itself to stop at what the budget has left', () => {
    // The one limit an archive cannot lie its way past. No refusal message can
    // show it — inflating everything and refusing afterwards reads the same,
    // at the cost of the memory this exists to save — so the call is asserted.
    const archive = ZipArchive.open(
      zip([
        { name: 'a.xml', data: '<a>'.repeat(100) },
        { name: 'b.xml', data: '<b/>' },
      ]),
    );
    const inflate = vi.mocked(inflateRawSync);
    inflate.mockClear();
    const shared = budget();
    archive.read('a.xml', shared);
    archive.read('b.xml', shared);
    expect(inflate.mock.calls.map(([, options]) => options?.maxOutputLength)).toEqual([
      MIB,
      MIB - 300,
    ]);
  });
});
