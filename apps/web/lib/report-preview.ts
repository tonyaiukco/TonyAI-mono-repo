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
export async function withPreviewRetry<T>(read: () => Promise<T>, stillWanted: () => boolean = () => true): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 429 || !stillWanted()) throw e;
    const header = Number(e.retryAfter);
    const seconds = Number.isFinite(header) && header > 0 && header <= 5 ? header : 1;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
    if (!stillWanted()) throw e;
    return read();
  }
}
