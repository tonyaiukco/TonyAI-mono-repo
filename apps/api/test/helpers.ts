import { vi } from 'vitest';
import type { Subsidiary } from '@tonyai/db';
import type { RequestUser } from '../src/auth/auth.types';

/**
 * A minimal mock of PrismaService that only implements the methods the
 * services under test actually call. Each method is a vi.fn() so individual
 * tests can stub return values and assert call arguments. No DB is touched.
 */
export function createPrismaMock() {
  return {
    subsidiary: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  };
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
