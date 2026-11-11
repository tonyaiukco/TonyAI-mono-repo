/**
 * Files chosen on Data Entry before the record exists (UAT round 2, BUG-R2-05).
 *
 * The evidence API needs a record id, so a file chosen on a new record is held
 * in the browser until the save that creates the record, then uploaded to that
 * record and no other. These helpers are the parts of that sequence a test can
 * pin without a browser: which file may be held, and the upload loop that stops
 * as soon as the form has moved on to another record.
 *
 * The server stays the final word on every file: its own type, size and gate
 * checks run on each upload exactly as they do for the vault.
 */
import { EVIDENCE_ALLOWED_MIME_TYPES, EVIDENCE_MAX_SIZE_BYTES } from "@/lib/types";

/** What a held file is checked on: the same two things the bucket refuses. */
export interface HeldFileLike {
  name: string;
  type: string;
  size: number;
  lastModified?: number;
}

export type HeldFileVerdict = "ok" | "unsupported_type" | "too_large";

export function validateHeldFile(file: HeldFileLike): HeldFileVerdict {
  if (!(EVIDENCE_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) return "unsupported_type";
  if (file.size > EVIDENCE_MAX_SIZE_BYTES) return "too_large";
  return "ok";
}

/** Same file chosen twice (name, size and modification time all equal). */
function sameFile(a: HeldFileLike, b: HeldFileLike): boolean {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

export interface HeldAddition<F extends HeldFileLike> {
  /** The held list after the addition, in the order chosen. */
  held: F[];
  /** Files refused, each with its reason. A file chosen twice is not refused, just kept once. */
  refused: { file: F; reason: Exclude<HeldFileVerdict, "ok"> }[];
}

/** Add newly chosen files to the held list: refuse the invalid, keep each file once. */
export function addHeldFiles<F extends HeldFileLike>(held: readonly F[], chosen: readonly F[]): HeldAddition<F> {
  const next = [...held];
  const refused: HeldAddition<F>["refused"] = [];
  for (const file of chosen) {
    const verdict = validateHeldFile(file);
    if (verdict !== "ok") {
      refused.push({ file, reason: verdict });
      continue;
    }
    if (!next.some((h) => sameFile(h, file))) next.push(file);
  }
  return { held: next, refused };
}

export interface HeldUploadResult<F> {
  uploaded: F[];
  failed: { file: F; error: unknown }[];
  /** Files never tried because the form moved on to another record first. */
  abandoned: F[];
}

/**
 * Upload held files to the record the same save created, one at a time and in
 * the order chosen. A failure does not stop the rest. Once `isCurrent()` turns
 * false — the user started another record, switched subsidiary or opened
 * another record — nothing more is uploaded, so a file can never land on a
 * record other than the one its own form created.
 */
export async function uploadHeldFiles<F>(
  recordId: string,
  files: readonly F[],
  upload: (recordId: string, file: F) => Promise<unknown>,
  isCurrent: () => boolean,
): Promise<HeldUploadResult<F>> {
  const result: HeldUploadResult<F> = { uploaded: [], failed: [], abandoned: [] };
  for (let i = 0; i < files.length; i += 1) {
    if (!isCurrent()) {
      result.abandoned.push(...files.slice(i));
      break;
    }
    const file = files[i];
    try {
      await upload(recordId, file);
      result.uploaded.push(file);
    } catch (error) {
      result.failed.push({ file, error });
    }
  }
  return result;
}
