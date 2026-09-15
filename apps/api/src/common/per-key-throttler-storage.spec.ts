import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';
import { PerKeyThrottlerStorage } from './per-key-throttler-storage';

const MINUTE = 60_000;
/** The import route's budget: five a minute, and a minute's block over it. */
const LIMIT = 5;

const request = (storage: ThrottlerStorage, user: string) =>
  storage.increment(`import-${user}`, MINUTE, LIMIT, MINUTE, 'default');

/**
 * E2E run 35010155226 as a timeline: an admin runs out of imports, the entry
 * user imports twice, the admin's block ends — and the entry user's two imports
 * must still expire a minute after they were made.
 */
async function afterAnotherUsersBlockEnds(storage: ThrottlerStorage) {
  for (let i = 0; i <= LIMIT; i += 1) await request(storage, 'admin'); // the sixth is blocked
  vi.advanceTimersByTime(30_000);
  await request(storage, 'entry');
  await request(storage, 'entry');
  vi.advanceTimersByTime(31_000); // 61 s: the admin's block has run out...
  await request(storage, 'admin'); // ...and this request ends it
  vi.advanceTimersByTime(30_000); // 91 s: the entry user's imports are a minute old
  return request(storage, 'entry');
}

describe('PerKeyThrottlerStorage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets one user's hits expire when another user's block ends", async () => {
    const record = await afterAnotherUsersBlockEnds(new PerKeyThrottlerStorage());
    expect(record).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('works around a defect the installed @nestjs/throttler still has', async () => {
    // A tripwire. The day this fails, the release in node_modules keeps its
    // timers per key, and PerKeyThrottlerStorage should be deleted for it.
    const record = await afterAnotherUsersBlockEnds(new ThrottlerStorageService());
    expect(record.totalHits).toBe(3);
  });

  it('counts each user within the window and blocks the request over the limit', async () => {
    const storage = new PerKeyThrottlerStorage();
    for (let hit = 1; hit <= LIMIT; hit += 1) {
      expect(await request(storage, 'entry')).toMatchObject({ totalHits: hit, isBlocked: false });
    }
    expect(await request(storage, 'entry')).toMatchObject({ isBlocked: true });
    // Another user's budget is their own.
    expect(await request(storage, 'admin')).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('expires each hit a window after it was made, not all at once', async () => {
    const storage = new PerKeyThrottlerStorage();
    await request(storage, 'entry');
    vi.advanceTimersByTime(30_000);
    await request(storage, 'entry');
    // 61 s: the first hit has expired, the second has not.
    vi.advanceTimersByTime(31_000);
    expect(await request(storage, 'entry')).toMatchObject({ totalHits: 2 });
  });

  it('keeps refusing a blocked user until the block ends, then starts them again', async () => {
    const storage = new PerKeyThrottlerStorage();
    for (let i = 0; i <= LIMIT; i += 1) await request(storage, 'entry');
    vi.advanceTimersByTime(59_000);
    expect(await request(storage, 'entry')).toMatchObject({ isBlocked: true });
    vi.advanceTimersByTime(2_000);
    expect(await request(storage, 'entry')).toMatchObject({ isBlocked: false, totalHits: 1 });
  });

  it('starts a user again when a block shorter than the window ends', async () => {
    // With a block as long as the window, which is this API's setting, every
    // hit has expired by the time the block ends, so resetting the count looks
    // redundant. `@Throttle` accepts a shorter block, and then the reset is all
    // that keeps an unblocked user from being refused again on the next request.
    const storage = new PerKeyThrottlerStorage();
    const shortBlock = () => storage.increment('import-entry', MINUTE, LIMIT, 10_000, 'default');
    for (let i = 0; i <= LIMIT; i += 1) await shortBlock();
    vi.advanceTimersByTime(11_000);
    expect(await shortBlock()).toMatchObject({ isBlocked: false, totalHits: 1 });
  });
});
