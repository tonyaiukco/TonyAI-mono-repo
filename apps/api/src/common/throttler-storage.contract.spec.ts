import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';

/**
 * What the import throttle needs from `@nestjs/throttler`'s in-memory storage.
 *
 * 6.5.0 filed every pending expiry under the throttler's NAME, so when one
 * key's block ran out it cleared the timers of every key under that name and
 * another user's hits never expired (E2E run 35010155226). The app carried its
 * own `PerKeyThrottlerStorage` until a release kept timers per key; 6.7.0
 * does, the workaround is deleted, and this pins the behaviour it existed for
 * — so a downgrade, or a regression upstream, fails here rather than in
 * production as a user refused for imports they made two minutes ago.
 */
const MINUTE = 60_000;
/** The import route's budget: five a minute, and a minute's block over it. */
const LIMIT = 5;
/** A real date, not the epoch: at 0 a block that forgot the clock still passes. */
const START = new Date('2026-09-15T09:00:00.000Z');

const request = (storage: ThrottlerStorage, user: string) =>
  storage.increment(`import-${user}`, MINUTE, LIMIT, MINUTE, 'default');

describe("@nestjs/throttler's storage — the contract the import throttle relies on", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets one key's hits expire when another key's block ends", async () => {
    const storage = new ThrottlerStorageService();
    for (let i = 0; i < LIMIT; i += 1) await request(storage, 'admin');
    expect(await request(storage, 'admin')).toMatchObject({ isBlocked: true });
    vi.advanceTimersByTime(30_000);
    await request(storage, 'entry');
    await request(storage, 'entry');
    // 61 s: the admin's block has run out, and this request is what ends it.
    vi.advanceTimersByTime(31_000);
    expect(await request(storage, 'admin')).toMatchObject({ isBlocked: false, totalHits: 1 });
    // 91 s: the entry user's two imports are over a minute old. The defect
    // read 3 here — the two stale hits plus this one.
    vi.advanceTimersByTime(30_000);
    expect(await request(storage, 'entry')).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('runs on the fake clock, so the test above can fail', async () => {
    // A release whose timers escaped the fake clock would make the first test
    // vacuous in the other direction.
    const storage = new ThrottlerStorageService();
    await request(storage, 'entry');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(MINUTE + 1_000);
    expect(await request(storage, 'entry')).toMatchObject({ totalHits: 1 });
  });

  it('counts each user within the window and blocks the request over the limit', async () => {
    const storage = new ThrottlerStorageService();
    for (let hit = 1; hit <= LIMIT; hit += 1) {
      expect(await request(storage, 'entry')).toMatchObject({ totalHits: hit, isBlocked: false });
    }
    expect(await request(storage, 'entry')).toMatchObject({ isBlocked: true });
    // …and the block lasts its whole duration: a storage that forgot it after
    // a second passed every other test here.
    vi.advanceTimersByTime(59_000);
    expect(await request(storage, 'entry')).toMatchObject({ isBlocked: true });
    // Another user's budget is their own.
    expect(await request(storage, 'admin')).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('counts a hit for the whole window, not half of it', async () => {
    const storage = new ThrottlerStorageService();
    await request(storage, 'entry');
    vi.advanceTimersByTime(MINUTE - 1);
    expect((await request(storage, 'entry')).totalHits).toBe(2);
  });

  it('resets a block shorter than the window cleanly — later hits do not go negative', async () => {
    // The reset clears the ENDING key's pending expiries; had the six
    // pre-block ones survived, they would fire later and take the count below
    // zero, handing the user extra budget.
    const storage = new ThrottlerStorageService();
    const shortBlock = () => storage.increment('import-entry', MINUTE, LIMIT, 10_000, 'default');
    for (let i = 0; i <= LIMIT; i += 1) await shortBlock();
    vi.advanceTimersByTime(11_000);
    expect(await shortBlock()).toMatchObject({ isBlocked: false, totalHits: 1 });
    vi.advanceTimersByTime(50_000);
    expect(await shortBlock()).toMatchObject({ isBlocked: false, totalHits: 2 });
  });

  it('does not let the idle sweep hand a blocked user their budget back', async () => {
    // 6.7.0 evicts idle records on an interval — the one new path that drops
    // state. A block longer than the window must outlive the window.
    const storage = new ThrottlerStorageService();
    const longBlock = () => storage.increment('import-entry', MINUTE, LIMIT, 5 * MINUTE, 'default');
    for (let i = 0; i <= LIMIT; i += 1) await longBlock();
    // Past the window and through several sweeps, still inside the block.
    vi.advanceTimersByTime(3 * MINUTE);
    expect(await longBlock()).toMatchObject({ isBlocked: true });
  });

  it('clears every pending timer on shutdown (hit timers are not unref()ed, so an app must be closed)', async () => {
    const storage = new ThrottlerStorageService();
    await request(storage, 'entry');
    storage.onApplicationShutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
});
