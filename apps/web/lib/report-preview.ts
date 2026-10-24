import { ApiError } from "@/lib/api";

/**
 * A live report preview's read, tried once more after a capacity refusal
 * (LP4-03): the API holds one preview snapshot per user, so a second one that
 * starts while the first still runs — a quick selection change, a dashboard
 * refresh beside an open Reports tab — answers 429 with `Retry-After`. One
 * retry after that wait; then the refusal stands, and the caller says the
 * coverage is unavailable rather than leaving it out (`security-rls` P3-1 on
 * PR B: a missing card reads as "no gaps"). `stillWanted` lets a superseded
 * caller stop instead of retrying.
 */
/** The longest server delay waited out in place; anything longer is not retried. */
export const MAX_RETRY_WAIT_SECONDS = 5;

export async function withPreviewRetry<T>(read: () => Promise<T>, stillWanted: () => boolean = () => true): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 429 || !stillWanted()) throw e;
    // The server's delay, honoured: a short one (the one-per-user preview
    // permit, `Retry-After: 1`) is waited out once; a longer one (a spent
    // per-minute quota, up to 60) is not retried early into the same block —
    // the refusal stands and the caller says the coverage is unavailable,
    // to be read again on reload (Codex B9 P3 on PR B). No header: 1 s.
    const header = e.retryAfter === undefined || e.retryAfter.trim() === '' ? 1 : Number(e.retryAfter);
    if (!Number.isFinite(header) || header < 0 || header > MAX_RETRY_WAIT_SECONDS) throw e;
    await new Promise((resolve) => setTimeout(resolve, Math.max(header, 0.25) * 1_000));
    if (!stillWanted()) throw e;
    return read();
  }
}
