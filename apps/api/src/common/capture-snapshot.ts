import type { Prisma } from '@tonyai/db';

/**
 * The database as one capture's transaction sees it (LP3-04 PR B, W2; moved
 * here from `calculations/factor-lookup.ts` in PR C, PR B follow-up (3)) — a
 * leaf both the factor lookup and the dataset producer import, so neither
 * module reaches into the other. A dataset reads the boundary
 * (`readInventoryBoundary`), its records, evidence, locks and releases through
 * one; the factor lookup reads the library through one when a caller hands it
 * one (`lookupFactorPath`).
 *
 * Opened only from a transaction at REPEATABLE READ or SERIALIZABLE: every
 * statement in it reads the same snapshot, so a capture's boundary, records,
 * releases and factor candidates agree — at READ COMMITTED an erratum
 * committed between two of its reads would price the old factor with the new
 * conversion (Codex's B9 review of LP4-02 PR B1, F2). Never a record writer's
 * transaction: their triggers require READ COMMITTED (TA003), so the engine
 * itself is never handed one (LP4-02 (26)) — it reads in a snapshot of its own.
 */

/** A transaction handed to a capture's reader that cannot hold one snapshot. */
export class CaptureSnapshotError extends Error {}

/** Every snapshot `CaptureSnapshot.open` made — and nothing else. */
const OPENED = new WeakSet<object>();

export class CaptureSnapshot {
  // An ES private field, not TypeScript's `private`, read through `txOf` only:
  // a shape-alike (`Object.create(prototype)`, a Proxy, a spread) has no
  // `#tx`; and a snapshot counts only if `open` made it — TypeScript's private
  // constructor is not JavaScript's, so `Reflect.construct` or a subclass
  // could otherwise skip the isolation check. Frozen, so a genuine one cannot
  // be re-pointed (security-rls P3-2 and its re-check).
  readonly #tx: Prisma.TransactionClient;

  private constructor(tx: Prisma.TransactionClient) {
    this.#tx = tx;
    Object.freeze(this);
  }

  /** Was this snapshot opened by `open` — not merely shaped or built like one? */
  static isOpened(value: unknown): value is CaptureSnapshot {
    return typeof value === 'object' && value !== null && OPENED.has(value);
  }

  /** The transaction an opened snapshot reads in. */
  static txOf(snapshot: CaptureSnapshot): Prisma.TransactionClient {
    if (!CaptureSnapshot.isOpened(snapshot)) {
      throw new CaptureSnapshotError('A capture reads in a snapshot opened by CaptureSnapshot.open only.');
    }
    return snapshot.#tx;
  }

  static async open(tx: Prisma.TransactionClient): Promise<CaptureSnapshot> {
    // The root client has `$transaction`; an interactive transaction's does
    // not. A root client's statements are each a transaction of their own.
    if ('$transaction' in tx) {
      throw new CaptureSnapshotError('A capture reads in a caller snapshot only inside an interactive transaction.');
    }
    const [row] = await tx.$queryRaw<Array<{ isolation: string }>>`
      SELECT pg_catalog.current_setting('transaction_isolation') AS isolation`;
    if (row?.isolation !== 'repeatable read' && row?.isolation !== 'serializable') {
      throw new CaptureSnapshotError(
        `A capture reads in a caller snapshot only at REPEATABLE READ or SERIALIZABLE, not ${row?.isolation ?? 'an unknown level'}.`,
      );
    }
    const snapshot = new CaptureSnapshot(tx);
    OPENED.add(snapshot);
    return snapshot;
  }
}
