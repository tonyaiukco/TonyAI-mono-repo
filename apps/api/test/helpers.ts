import { vi } from 'vitest';
import type { Subsidiary } from '@tonyai/db';
import { CATEGORIES, type Category } from '@tonyai/shared-types';
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
      // inc26-group-tree: a parent or the root is looked up, and children counted.
      findFirst: vi.fn(),
      count: vi.fn(),
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
    // Everything hanging off a subsidiary but its records is ON DELETE CASCADE
    // (records are RESTRICT since LP4-01), so the delete guard has to count all
    // of it. Present here for the same reason as
    // activityRecord above: an unmocked namespace throws a TypeError, which
    // reads as a broken test instead of the missing guard it actually is.
    periodLock: { count: vi.fn() },
    target: { count: vi.fn() },
    subsidiaryDenominator: { count: vi.fn() },
    // LP3-04 PR B: a subsidiary or site declared in an inventory boundary
    // version is not deleted (W9) — the delete guards count these too.
    inventoryBoundarySubsidiary: { count: vi.fn(), findMany: vi.fn() },
    inventoryBoundarySite: { count: vi.fn() },
    // inc26-group-tree: ticking associate reads the grants and the newest
    // boundary version of each declared year; a delete reads the grants it
    // cascades, to audit each.
    userSubsidiaryAccess: { count: vi.fn(), findMany: vi.fn() },
    inventoryBoundary: { findFirst: vi.fn() },
    // The object handed to `$transaction` callbacks, with its OWN spies for
    // every model — see `createTxClient` below.
    txClient: null as unknown as typeof mock,
    // The subsidiary delete locks its row (`SELECT … FOR UPDATE`) before
    // counting children, so the guard cannot be raced by a concurrent insert.
    // A row lock reads back the row it locked, as Postgres answers one that exists.
    // A company's delete removes its grants with `DELETE … RETURNING` (WP7):
    // none unless a spec says so.
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) =>
      (Array.isArray(sql) && sql.join('?').includes('DELETE FROM user_subsidiary_access') ? [] : [{ id: 'locked' }])),
    // inc26-group-tree: a move or a control tick takes the organisation's tree
    // lock (`pg_advisory_xact_lock`) before it locks the node.
    $executeRaw: vi.fn().mockResolvedValue(1),
    // A company's update and delete re-read their actor under the
    // organisation's administrative lock (owner review of WP7): by default
    // the masterkey as authenticated.
    profile: { findUnique: vi.fn() },
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
      client.inventoryBoundarySubsidiary,
      client.inventoryBoundarySite,
      client.subsidiary,
      client.userSubsidiaryAccess,
    ]) {
      model.count.mockResolvedValue(0);
    }
    client.subsidiary.findFirst.mockResolvedValue(null);
    client.inventoryBoundarySubsidiary.findMany.mockResolvedValue([]);
    client.userSubsidiaryAccess.findMany.mockResolvedValue([]);
    client.profile.findUnique.mockResolvedValue({
      role: 'masterkey', organisationId: 'org-1', disabledAt: null, organisation: { offboardedAt: null }, subsidiaryAccess: [],
    });
    client.inventoryBoundary.findFirst.mockResolvedValue(null);
    // A subsidiary update reads its row again inside the transaction, after
    // locking it (owner review of WP7): the same row a spec stubs on the root
    // client, unless the spec stubs the transaction's own read.
    if (client === mock.txClient) {
      client.subsidiary.findUnique.mockImplementation((args: unknown) => mock.subsidiary.findUnique(args));
      // …and a location update reads its row the same way (owner review of WP7).
      client.location.findUnique.mockImplementation((args: unknown) => mock.location.findUnique(args));
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
    // Listed for the same reason as the contact columns above, and it was
    // missed once already: `SubsidiaryDTO` types this non-optional, but an
    // omitted column here becomes `undefined`, `toDTO` copies it, and
    // `toEqual` ignores undefined-valued keys — so every assertion over this
    // fixture passed while the DTO silently lacked the field.
    trackingGranularity: 'subsidiary',
    // inc26-group-tree, listed for the reason above: a controlled company
    // under the fixture organisation's root.
    parentId: 'sub-root',
    nodeType: 'company',
    control: 'controlled',
    sharePercent: null,
    naceCode: null,
    createdByRole: null,
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
    locationType: null,
    createdAt: now,
    updatedAt: now,
    // The company's organisation, as the facility's scoped read includes it
    // (owner's seventh review of WP7): the callers' 'org-1' by default.
    subsidiary: { organisationId: 'org-1' },
    ...overrides,
  } as import('@tonyai/db').Location;
}

export function makeMasterkey(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-admin',
    email: 'admin@tonyai.local',
    fullName: 'Admin User',
    role: 'masterkey',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2', 'sub-3', 'sub-4', 'sub-5'],
    categoryGrants: {},
    ...overrides,
  };
}

/** Every category ticked on each of `subsidiaryIds` (a carried-over grant). */
export function everyCategoryOn(subsidiaryIds: readonly string[]): Record<string, Category[]> {
  return Object.fromEntries(subsidiaryIds.map((id) => [id, [...CATEGORIES].sort()]));
}

/**
 * A standard user granted `sub-1` and `sub-2` (INC-2.6 §1). Unless the
 * overrides name `categoryGrants`, every category is ticked on every granted
 * company — the shape of a carried-over account — so a spec about something
 * else is not narrowed by categories by accident.
 */
export function makeStandardUser(overrides: Partial<RequestUser> = {}): RequestUser {
  const accessibleSubsidiaryIds = overrides.accessibleSubsidiaryIds ?? ['sub-1', 'sub-2'];
  return {
    id: 'user-entry',
    email: 'entry@tonyai.local',
    fullName: 'Entry User',
    role: 'standard_user',
    organisationId: 'org-1',
    accessibleSubsidiaryIds,
    categoryGrants: everyCategoryOn(accessibleSubsidiaryIds),
    ...overrides,
  };
}

/** A company-scoped super_admin granted `sub-1` and `sub-2`; categories never narrow it. */
export function makeSuperAdmin(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-super-admin',
    email: 'approver@tonyai.local',
    fullName: 'Super Admin User',
    role: 'super_admin',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
    categoryGrants: {},
    ...overrides,
  };
}

/** An auditor: reads the whole organisation, changes nothing. */
export function makeAuditor(overrides: Partial<RequestUser> = {}): RequestUser {
  return {
    id: 'user-auditor',
    email: 'review@tonyai.local',
    fullName: 'Auditor User',
    role: 'auditor',
    organisationId: 'org-1',
    accessibleSubsidiaryIds: ['sub-1', 'sub-2', 'sub-3', 'sub-4', 'sub-5'],
    categoryGrants: {},
    ...overrides,
  };
}
