import { vi } from 'vitest';
import type { Subsidiary } from '@tonyai/db';
import type { RequestUser } from '../src/auth/auth.types';

/**
 * The client `$transaction` hands its callback — a separate object with its own
 * spies for every model.
 *
 * Two rounds of getting this wrong, both measured:
 *
 * 1. Originally the callback received the mock ITSELF, so `tx === prisma`. No
 *    assertion could tell "wrote on the transaction client" from "wrote on the
 *    default client", and every `toHaveBeenCalledWith(..., prisma)` third-arg
 *    check pinned ARITY and nothing else. Reverting a service to write outside
 *    its transaction passed the whole suite.
 * 2. The first fix gave the callback a distinct object that re-exported the
 *    SAME model spies. That fixed the audit-client question and left the row
 *    question open: `this.prisma.location.create(...)` and `db.location.create(...)`
 *    still landed on one spy, so a writer that mutated on the wrong client was
 *    invisible.
 *
 * Hence separate spies. A spec asserting an in-transaction mutation must now
 * name `prisma.txClient.<model>.<verb>`, and asserting the plain
 * `prisma.<model>.<verb>` for the same call fails — which is the point. Any
 * stubbed resolution has to be set on the client the code will actually use.
 */
function createTxClient(mock: Record<string, unknown>): never {
  const tx: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mock)) {
    if (key === 'txClient') continue;
    if (value && typeof value === 'object' && !('mock' in (value as object))) {
      // A model namespace: fresh spies, same verbs.
      const model: Record<string, unknown> = {};
      for (const verb of Object.keys(value as object)) model[verb] = vi.fn();
      tx[key] = model;
    } else {
      tx[key] = value;
    }
  }
  return tx as never;
}

/**
 * Stub a READ on both clients at once.
 *
 * Reads are client-agnostic — the same rows exist whichever connection asks —
 * so a spec that means "the database contains N of these" should not have to
 * know whether the code under test happens to be inside a transaction at that
 * moment. Mutations are the opposite: which client performed them is exactly
 * what the separate spies exist to expose, so those are asserted per-client and
 * deliberately have no helper.
 */
export function stubRead(
  prisma: PrismaMock,
  pick: (client: PrismaMock) => { mockResolvedValue: (v: unknown) => unknown },
  value: unknown,
): void {
  pick(prisma).mockResolvedValue(value);
  pick(prisma.txClient).mockResolvedValue(value);
}

/**
 * A minimal mock of PrismaService that only implements the methods the
 * services under test actually call. Each method is a vi.fn() so individual
 * tests can stub return values and assert call arguments. No DB is touched.
 */
export function createPrismaMock() {
  const mock = {
    subsidiary: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    location: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    // Present so specs can assert a service did NOT reach into records. Without
    // the namespace an accidental access throws a TypeError, which reads as a
    // broken test rather than the finding it actually is.
    activityRecord: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    // Everything hanging off a subsidiary is ON DELETE CASCADE, so the delete
    // guard has to count all of it. Present here for the same reason as
    // activityRecord above: an unmocked namespace throws a TypeError, which
    // reads as a broken test instead of the missing guard it actually is.
    periodLock: { count: vi.fn() },
    target: { count: vi.fn() },
    subsidiaryDenominator: { count: vi.fn() },
    // The object handed to `$transaction` callbacks, with its OWN spies for
    // every model — see `createTxClient` below.
    txClient: null as unknown as typeof mock,
    // The subsidiary delete locks its row (`SELECT … FOR UPDATE`) before
    // counting children, so the guard cannot be raced by a concurrent insert.
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  mock.txClient = createTxClient(mock);
  mock.$transaction.mockImplementation(
    async (cb: (tx: typeof mock) => unknown) => cb(mock.txClient),
  );
  // Counting is how the delete guards decide, and an unmocked `count` resolves
  // to `undefined` — which makes `count > 0` quietly false, i.e. a disarmed
  // guard that still looks green. Default every counter to "nothing there", so
  // a spec that means "there IS something" has to say so out loud.
  for (const client of [mock, mock.txClient]) {
    for (const model of [
      client.location,
      client.activityRecord,
      client.periodLock,
      client.target,
      client.subsidiaryDenominator,
    ]) {
      model.count.mockResolvedValue(0);
    }
    // Same reasoning one step further: an unstubbed `findMany` resolves to
    // `undefined`, and a service that iterates it dies with "not iterable" —
    // which reads as a broken test rather than the missing default it is.
    client.subsidiary.findMany.mockResolvedValue([]);
    client.location.findMany.mockResolvedValue([]);
    client.activityRecord.findMany.mockResolvedValue([]);
  }
  return mock;
}

export type PrismaMock = ReturnType<typeof createPrismaMock>;

let seq = 0;

/** Build a fully-shaped Subsidiary DB row, overridable per-field. */
export function makeSubsidiary(overrides: Partial<Subsidiary> = {}): Subsidiary {
  seq += 1;
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: `sub-${seq}`,
    organisationId: 'org-1',
    legalName: `Legal ${seq}`,
    tradingName: null,
    location: null,
    geographyCode: 'UK',
    businessArea: null,
    sector: null,
    designatedPerson: null,
    // Listed explicitly, not left to the `as Subsidiary` cast below: an omitted
    // column does NOT fail to compile there, it silently becomes `undefined`,
    // and `toDTO` then returns `undefined` where every DTO assertion expects
    // `null`. The failure surfaces far from the cause.
    contactEmail: null,
    contactPhone: null,
    reportingStatus: 'pending',
    includedScopes: [1, 2],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Subsidiary;
}

/** Build a fully-shaped Location DB row, overridable per-field. */
export function makeLocation(
  overrides: Partial<import('@tonyai/db').Location> = {},
): import('@tonyai/db').Location {
  seq += 1;
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: `loc-${seq}`,
    subsidiaryId: 'sub-1',
    name: `Location ${seq}`,
    geographyCode: 'UK',
    address: null,
    authorizedPerson: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as import('@tonyai/db').Location;
}

export function makeSuperAdmin(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-admin',
    email: 'admin@tonyai.local',
    role: 'super_admin',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2', 'sub-3', 'sub-4', 'sub-5'],
    ...overrides,
  };
}

export function makeDataEntry(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-entry',
    email: 'entry@tonyai.local',
    role: 'data_entry',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    ...overrides,
  };
}
