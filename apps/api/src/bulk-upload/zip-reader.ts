import { inflateRawSync } from 'node:zlib';
import { BadRequestException } from '@nestjs/common';

/**
 * Just enough of the ZIP container to read the parts of an `.xlsx` — with a
 * hard ceiling on how much it will ever unpack.
 *
 * The ceiling is the reason this exists. exceljs reads through unzipper, which
 * inflates with no output limit and believes the sizes an archive declares
 * about itself, while deflate packs repetitive XML at about 1,000:1 (measured:
 * 8 MiB of one byte packs into 8 KB). A file under the 2 MiB upload cap can
 * therefore unpack to ~2 GiB before a single cell is read. No zip library is
 * importable from this app, and the one control that matters here is enforced
 * by zlib itself: `maxOutputLength` stops inflating at the limit, whatever the
 * archive claims.
 *
 * Deliberately small. One disk, no ZIP64 (a 2 MiB upload never needs it, and
 * its placeholder counts and offsets fail the bounds checks below), stored or
 * deflated entries, no encryption. Anything else is refused as
 * unreadable rather than guessed at — and only when a part the reader actually
 * opens is affected, so an odd thumbnail cannot sink a good workbook. CRCs are
 * not checked: a corrupted part fails as XML, and a checksum is no defence
 * against a file built to be hostile.
 */

export const WORKBOOK_UNREADABLE = 'The file could not be read as a workbook.';

export function unreadableWorkbook(): BadRequestException {
  return new BadRequestException(WORKBOOK_UNREADABLE);
}

const MIB = 1024 * 1024;

export function unpackedTooLarge(limitBytes: number): BadRequestException {
  return new BadRequestException(
    `The workbook is larger than ${limitBytes / MIB} MB once unpacked. Remove unused formatting, or split it into smaller files.`,
  );
}

/**
 * The unpacked bytes one read of a workbook may still spend — ONE budget for
 * every part it opens, so a file cannot stay under a per-part limit five times
 * over.
 */
export class UnpackBudget {
  private spent = 0;

  constructor(readonly limitBytes: number) {}

  get remaining(): number {
    return this.limitBytes - this.spent;
  }

  spend(bytes: number): void {
    this.spent += bytes;
    if (this.spent > this.limitBytes) throw unpackedTooLarge(this.limitBytes);
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_LENGTH = 22;
const CENTRAL_HEADER_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;
const MAX_COMMENT_LENGTH = 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8_NAME = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

interface Entry {
  flags: number;
  method: number;
  compressedSize: number;
  declaredSize: number;
  localHeaderOffset: number;
  nameStart: number;
  nameLength: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const last = buffer.length - EOCD_LENGTH;
  const first = Math.max(0, last - MAX_COMMENT_LENGTH);
  for (let offset = last; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    // The record's comment must end exactly where the file does. A signature
    // that does not satisfy that is four bytes of somebody's comment.
    if (offset + EOCD_LENGTH + buffer.readUInt16LE(offset + 20) === buffer.length) {
      return offset;
    }
  }
  throw unreadableWorkbook();
}

export class ZipArchive {
  private constructor(
    private readonly buffer: Buffer,
    private readonly entries: ReadonlyMap<string, Entry>,
    private readonly centralDirectoryOffset: number,
  ) {}

  static open(buffer: Buffer): ZipArchive {
    const eocd = findEndOfCentralDirectory(buffer);
    const disk = buffer.readUInt16LE(eocd + 4);
    const centralDisk = buffer.readUInt16LE(eocd + 6);
    const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
    const entryCount = buffer.readUInt16LE(eocd + 10);
    const centralSize = buffer.readUInt32LE(eocd + 12);
    const centralOffset = buffer.readUInt32LE(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
      throw unreadableWorkbook();
    }
    const centralEnd = centralOffset + centralSize;
    if (centralEnd > eocd) throw unreadableWorkbook();

    const entries = new Map<string, Entry>();
    let offset = centralOffset;
    for (let i = 0; i < entryCount; i += 1) {
      if (offset + CENTRAL_HEADER_LENGTH > centralEnd) throw unreadableWorkbook();
      if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
        throw unreadableWorkbook();
      }
      const flags = buffer.readUInt16LE(offset + 8);
      const entry: Entry = {
        flags,
        method: buffer.readUInt16LE(offset + 10),
        compressedSize: buffer.readUInt32LE(offset + 20),
        declaredSize: buffer.readUInt32LE(offset + 24),
        localHeaderOffset: buffer.readUInt32LE(offset + 42),
        nameStart: offset + CENTRAL_HEADER_LENGTH,
        nameLength: buffer.readUInt16LE(offset + 28),
      };
      const next =
        entry.nameStart +
        entry.nameLength +
        buffer.readUInt16LE(offset + 30) +
        buffer.readUInt16LE(offset + 32);
      if (next > centralEnd) throw unreadableWorkbook();
      const name = buffer.toString(
        flags & FLAG_UTF8_NAME ? 'utf8' : 'latin1',
        entry.nameStart,
        entry.nameStart + entry.nameLength,
      );
      // OPC part names are case-insensitive, so two names that differ only by
      // case are two candidates for the same part — and whichever one this
      // reader picked, another reader could pick the other.
      const key = name.toLowerCase();
      if (entries.has(key)) throw unreadableWorkbook();
      entries.set(key, entry);
      offset = next;
    }
    return new ZipArchive(buffer, entries, centralOffset);
  }

  /** The unpacked bytes of a part, or `undefined` when the archive has none. */
  read(name: string, budget: UnpackBudget): Buffer | undefined {
    const entry = this.entries.get(name.toLowerCase());
    if (!entry) return undefined;
    if (entry.flags & FLAG_ENCRYPTED) throw unreadableWorkbook();
    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATED) {
      throw unreadableWorkbook();
    }

    const local = entry.localHeaderOffset;
    if (local + LOCAL_HEADER_LENGTH > this.centralDirectoryOffset) {
      throw unreadableWorkbook();
    }
    if (this.buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
      throw unreadableWorkbook();
    }
    const localNameLength = this.buffer.readUInt16LE(local + 26);
    const localName = local + LOCAL_HEADER_LENGTH;
    // The local header must name the part the directory does. Readers that
    // walk local headers (unzipper does) and readers that trust the directory
    // (this one) must not be able to see two different files.
    const sameName = this.buffer
      .subarray(localName, localName + localNameLength)
      .equals(
        this.buffer.subarray(entry.nameStart, entry.nameStart + entry.nameLength),
      );
    if (!sameName) throw unreadableWorkbook();
    const dataStart =
      localName + localNameLength + this.buffer.readUInt16LE(local + 28);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.centralDirectoryOffset) throw unreadableWorkbook();

    // A declared size is the archive's claim about itself, so it may only ever
    // refuse early. The limit that holds is the one zlib enforces below.
    if (entry.declaredSize > budget.remaining) {
      throw unpackedTooLarge(budget.limitBytes);
    }
    const data = this.buffer.subarray(dataStart, dataEnd);
    if (entry.method === METHOD_STORED) {
      budget.spend(data.length);
      return data;
    }
    let unpacked: Buffer;
    try {
      unpacked = inflateRawSync(data, {
        maxOutputLength: Math.max(1, budget.remaining),
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
        throw unpackedTooLarge(budget.limitBytes);
      }
      throw unreadableWorkbook();
    }
    budget.spend(unpacked.length);
    return unpacked;
  }
}
