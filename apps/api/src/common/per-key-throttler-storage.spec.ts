import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';
import { PerKeyThrottlerStorage } from './per-key-throttler-storage';

const MINUTE = 60_000;
/** The import route's budget: five a minute, and a minute's block over it. */
const LIMIT = 5;
/**
 * A real date, not the epoch. At 0, `Date.now() + blockDuration` is just
 * `blockDuration`, so a block that forgot the clock passed every test here and
 * would never have blocked anyone in production (qa-auditor).
 */
const START = new Date('2026-09-15T09:00:00.000Z');

const request = (storage: ThrottlerStorage, user: string) =>
  storage.increment(`import-${user}`, MINUTE, LIMIT, MINUTE, 'default');

/**
 * E2E run 35010155226 as a timeline: an admin runs out of imports, the entry
 * user imports twice, the admin's block ends — and the entry user's two imports
 * must still expire a minute after they were made.
 */
async function afterAnotherUsersBlockEnds(storage: ThrottlerStorage) {
  for (let i = 0; i < LIMIT; i += 1) await request(storage, 'admin');
  expect(await request(storage, 'admin')).toMatchObject({ isBlocked: true });
  vi.advanceTimersByTime(30_000);
  await request(storage, 'entry');
  await request(storage, 'entry');
  // 61 s: the admin's block has run out, and this request is what ends it.
  vi.advanceTimersByTime(31_000);
  expect(await request(storage, 'admin')).toMatchObject({ isBlocked: false, totalHits: 1 });
  // 91 s: the entry user's two imports are over a minute old.
  vi.advanceTimersByTime(30_000);
  return request(storage, 'entry');
}

describe('PerKeyThrottlerStorage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets one key's hits expire when another key's block ends", async () => {
    const record = await afterAnotherUsersBlockEnds(new PerKeyThrottlerStorage());
    expect(record).toMatchObject({ totalHits: 1, isBlocked: false });
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

  it('reports the seconds the guard sends as headers: rounded up, and counted from the request that blocked', async () => {
    // `Retry-After` and `X-RateLimit-Reset` are built from these two numbers.
    const storage = new PerKeyThrottlerStorage();
    expect(await request(storage, 'entry')).toMatchObject({ totalHits: 1, timeToExpire: 60, isBlocked: false });
    vi.advanceTimersByTime(1_700); // 58.3 s of the window left
    expect(await request(storage, 'entry')).toMatchObject({ totalHits: 2, timeToExpire: 59, isBlocked: false });
    vi.advanceTimersByTime(28_300); // 30 s
    for (let hit = 3; hit <= LIMIT; hit += 1) await request(storage, 'entry');
    expect(await request(storage, 'entry')).toEqual({ totalHits: 6, timeToExpire: 30, isBlocked: true, timeToBlockExpire: 60 });
    vi.advanceTimersByTime(29_300); // 59.3 s
    expect(await request(storage, 'entry')).toEqual({ totalHits: 6, timeToExpire: 1, isBlocked: true, timeToBlockExpire: 31 });
    vi.advanceTimersByTime(1_000); // 60.3 s: the first hit has expired, and the window renews
    expect(await request(storage, 'entry')).toEqual({ totalHits: 5, timeToExpire: 60, isBlocked: true, timeToBlockExpire: 30 });
    vi.advanceTimersByTime(29_700); // 90 s: the block that began at 30 s ends exactly now
    expect(await request(storage, 'entry')).toEqual({ totalHits: 1, timeToExpire: 31, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('counts a hit until exactly one window after it was made', async () => {
    const storage = new PerKeyThrottlerStorage();
    await request(storage, 'entry');
    vi.advanceTimersByTime(MINUTE - 1);
    expect(await request(storage, 'entry')).toMatchObject({ totalHits: 2 });
    vi.advanceTimersByTime(1);
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

  it("starts a user again when a block shorter than the window ends, and clears that block's own expiries", async () => {
    // With a block as long as the window, which is this API's setting, every
    // hit has expired by the time the block ends, so resetting looks redundant.
    // `@Throttle` accepts a shorter block, and then the reset is all that keeps
    // an unblocked user from being refused again on the next request.
    const storage = new PerKeyThrottlerStorage();
    const shortBlock = () => storage.increment('import-entry', MINUTE, LIMIT, 10_000, 'default');
    for (let i = 0; i <= LIMIT; i += 1) await shortBlock();
    vi.advanceTimersByTime(11_000);
    expect(await shortBlock()).toMatchObject({ isBlocked: false, totalHits: 1 });
    // 61 s: had the six pre-block expiries survived the reset, they would have
    // fired by now and taken the count below zero.
    vi.advanceTimersByTime(50_000);
    expect(await shortBlock()).toMatchObject({ isBlocked: false, totalHits: 2 });
  });

  it('keeps no process alive for a pending expiry', async () => {
    const schedule = vi.spyOn(globalThis, 'setTimeout');
    await request(new PerKeyThrottlerStorage(), 'entry');
    const timer = schedule.mock.results[0]?.value as NodeJS.Timeout;
    schedule.mockRestore();
    expect(timer.hasRef()).toBe(false);
  });

  it('answers exactly as @nestjs/throttler does on a single key, where its defect cannot show', async () => {
    // The defect needs a second key; on one, the two must agree on every field
    // of every answer. Blocks shorter than, equal to and longer than the window.
    let seed = 20_260_915;
    const random = () => (seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0) / 2 ** 32;
    const steps = [0, 1, 700, 999, 1_000, 1_300, 5_000, 10_000, 29_999, 30_000, MINUTE];
    for (const blockDuration of [10_000, MINUTE, 90_000]) {
      vi.setSystemTime(START);
      const ours = new PerKeyThrottlerStorage();
      const library = new ThrottlerStorageService();
      for (let step = 0; step < 400; step += 1) {
        vi.advanceTimersByTime(steps[Math.floor(random() * steps.length)] ?? 0);
        const expected = await library.increment('key', MINUTE, 3, blockDuration, 'default');
        const actual = await ours.increment('key', MINUTE, 3, blockDuration, 'default');
        expect(actual, `block ${blockDuration} ms, step ${step}`).toEqual(expected);
      }
    }
  });

  it('works around a defect the installed @nestjs/throttler still has', async () => {
    // A tripwire. The day this fails, the release in node_modules keeps its
    // timers per key, and PerKeyThrottlerStorage should be deleted for it.
    const record = await afterAnotherUsersBlockEnds(new ThrottlerStorageService());
    expect(record.totalHits).toBe(3);
  });

  it("runs the tripwire on the library's own clock", async () => {
    // Without this, a fixed release whose timers escaped the fake clock would
    // read 3 as well, and the tripwire would never fire (security-rls).
    const library = new ThrottlerStorageService();
    await library.increment('import-entry', MINUTE, LIMIT, MINUTE, 'default');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(MINUTE + 1_000);
    expect(await library.increment('import-entry', MINUTE, LIMIT, MINUTE, 'default')).toMatchObject({
      totalHits: 1,
    });
  });
});
