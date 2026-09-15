import type { ThrottlerStorage } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

interface KeyRecord {
  /** Live hits per throttler name. Keys already carry the name, so one entry. */
  hits: Map<string, number>;
  expiresAt: number;
  blockExpiresAt: number;
  isBlocked: boolean;
  /** The pending expiry of each hit on THIS key, and on no other. */
  timers: NodeJS.Timeout[];
}

const secondsUntil = (at: number) => Math.ceil((at - Date.now()) / 1000);

/**
 * `@nestjs/throttler`'s in-memory storage with one defect removed: its expiry
 * timers are kept per KEY.
 *
 * 6.5.0, the latest release, files every pending expiry under the throttler's
 * NAME. When any one key's block runs out, it clears the timers of every key
 * under that name, so the hits those keys had recorded never expire. In E2E run
 * 35010155226 an admin's import block ran out, the entry user's two earlier
 * imports stayed counted, and the entry user was refused on their fourth import
 * of a minute with a limit of five. In production, any one block ending freezes
 * the hits of every key under that name — every throttled route and every
 * user, the blocked user's own other routes included — and those requests are
 * refused below their limit until each key is blocked and reset in turn.
 *
 * Upstream master already keys the timers this way. This is the same algorithm
 * with that change, to be deleted once a release carries it: the spec's
 * tripwire fails on the day the installed storage stops showing the defect.
 */
export class PerKeyThrottlerStorage implements ThrottlerStorage {
  private readonly records = new Map<string, KeyRecord>();

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    let record = this.records.get(key);
    if (!record) {
      record = {
        hits: new Map(),
        expiresAt: Date.now() + ttl,
        blockExpiresAt: 0,
        isBlocked: false,
        timers: [],
      };
      this.records.set(key, record);
    }
    if (secondsUntil(record.expiresAt) <= 0) record.expiresAt = Date.now() + ttl;
    const timeToExpire = secondsUntil(record.expiresAt);

    if (!record.isBlocked) this.hit(record, throttlerName, ttl);
    if (this.hitsOf(record, throttlerName) > limit && !record.isBlocked) {
      record.isBlocked = true;
      record.blockExpiresAt = Date.now() + blockDuration;
    }

    const timeToBlockExpire = secondsUntil(record.blockExpiresAt);
    if (timeToBlockExpire <= 0 && record.isBlocked) {
      // The block has run out, so this key starts again: its own count and its
      // own timers. Clearing every key's timers here was the defect.
      record.isBlocked = false;
      record.hits.set(throttlerName, 0);
      for (const timer of record.timers) clearTimeout(timer);
      record.timers = [];
      this.hit(record, throttlerName, ttl);
    }

    return {
      totalHits: this.hitsOf(record, throttlerName),
      timeToExpire,
      isBlocked: record.isBlocked,
      timeToBlockExpire,
    };
  }

  private hitsOf(record: KeyRecord, throttlerName: string): number {
    return record.hits.get(throttlerName) ?? 0;
  }

  private hit(record: KeyRecord, throttlerName: string, ttl: number): void {
    record.hits.set(throttlerName, this.hitsOf(record, throttlerName) + 1);
    const timer = setTimeout(() => {
      record.hits.set(throttlerName, this.hitsOf(record, throttlerName) - 1);
      record.timers = record.timers.filter((pending) => pending !== timer);
    }, ttl);
    // An expiry is bookkeeping, not work: it must not keep the process alive.
    timer.unref();
    record.timers.push(timer);
  }
}
