import { vi } from 'vitest';
import type { Subsidiary } from '@tonyai/db';
import type { RequestUser } from '../src/auth/auth.types';

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
    // Runs the callback against the SAME mock, so a mutation performed inside a
    // transaction is still observable as `prisma.<model>.delete(...)`, while the
    // audit spy receives this object as its third argument — which is what
    // proves the audit row commits with the mutation rather than after it.
    // The subsidiary delete locks its row (`SELECT … FOR UPDATE`) before
    // counting children, so the guard cannot be raced by a concurrent insert.
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  mock.$transaction.mockImplementation(async (cb: (tx: typeof mock) => unknown) => cb(mock));
  // Counting is how the delete guards decide, and an unmocked `count` resolves
  // to `undefined` — which makes `count > 0` quietly false, i.e. a disarmed
  // guard that still looks green. Default every counter to "nothing there", so
  // a spec that means "there IS something" has to say so out loud.
  for (const model of [
    mock.location,
    mock.activityRecord,
    mock.periodLock,
    mock.target,
    mock.subsidiaryDenominator,
  ]) {
    model.count.mockResolvedValue(0);
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
