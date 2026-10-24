import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { MAX_RETRY_WAIT_SECONDS, withPreviewRetry } from './report-preview';

vi.mock('./supabase', () => ({ getSupabaseBrowserClient: () => ({ auth: {} }) }));

const refused = (retryAfter?: string) => new ApiError('busy', 429, 'rate_limited', undefined, retryAfter);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('withPreviewRetry', () => {
  it("waits out a short Retry-After once, then reads again", async () => {
    const read = vi.fn().mockRejectedValueOnce(refused('2')).mockResolvedValueOnce('meta');
    const result = withPreviewRetry(read);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('meta');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not retry early into a longer block: a spent quota (Retry-After: 60) stands at once', async () => {
    const read = vi.fn().mockRejectedValue(refused('60'));
    await expect(withPreviewRetry(read)).rejects.toMatchObject({ status: 429 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(MAX_RETRY_WAIT_SECONDS).toBeLessThan(60);
  });

  it('waits one second when no header is exposed, and an unreadable header is not guessed', async () => {
    const read = vi.fn().mockRejectedValueOnce(refused()).mockResolvedValueOnce('meta');
    const result = withPreviewRetry(read);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe('meta');

    const garbled = vi.fn().mockRejectedValue(refused('soon'));
    await expect(withPreviewRetry(garbled)).rejects.toMatchObject({ status: 429 });
    expect(garbled).toHaveBeenCalledTimes(1);
  });

  it('retries only a 429, and never for a caller that moved on', async () => {
    const forbidden = vi.fn().mockRejectedValue(new ApiError('no', 403));
    await expect(withPreviewRetry(forbidden)).rejects.toMatchObject({ status: 403 });
    expect(forbidden).toHaveBeenCalledTimes(1);

    let wanted = true;
    const read = vi.fn().mockRejectedValue(refused('1'));
    const result = withPreviewRetry(read, () => wanted);
    const settled = expect(result).rejects.toMatchObject({ status: 429 });
    wanted = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    expect(read).toHaveBeenCalledTimes(1);
  });
});
