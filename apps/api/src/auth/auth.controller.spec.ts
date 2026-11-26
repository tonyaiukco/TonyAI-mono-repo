import 'reflect-metadata';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { makeAuditor, makeMasterkey, makeStandardUser, makeSuperAdmin } from '../../test/helpers';
import { AuthController } from './auth.controller';
import type { RequestUser } from './auth.types';
import type { PreferencesService } from './preferences.service';

const user = { id: 'u-1', role: 'standard_user' } as RequestUser;

describe('POST /me/password-set (pre-g5-security-hardening)', () => {
  it.each(['invite', 'recovery'] as const)('records the caller\'s own password set with the flow it was given (%s)', async (flow) => {
    const recordPasswordSet = vi.fn(async () => undefined);
    const controller = new AuthController({} as never, { recordPasswordSet } as unknown as PreferencesService);
    await expect(controller.recordPasswordSet(user, { flow, changeId: 'c-1' })).resolves.toBeUndefined();
    expect(recordPasswordSet).toHaveBeenCalledWith(user, flow, 'c-1');
  });

  it('answers 204', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, AuthController.prototype.recordPasswordSet)).toBe(204);
  });
});

/**
 * inc26-roles-approval-chain task 8.3: `GET /me` states the caller's own
 * grants — the two granted roles a list (a standard user's with its ticked
 * categories, a super_admin's with none), the organisation-wide roles an
 * empty one, whatever companies they read. That a standard user of another
 * organisation never appears is the guard's (`accessibleSubsidiaryIds`), and
 * is proven on PostgreSQL.
 */
describe('GET /me — the caller\'s access (INC-2.6 §1)', () => {
  function me(caller: RequestUser, onboardingCompletedAt: Date | null = new Date('2026-11-26T12:00:00Z')) {
    const findUnique = vi.fn(async () => ({ fullName: caller.fullName, language: 'en', theme: 'light', organisation: { onboardingCompletedAt } }));
    const controller = new AuthController({ profile: { findUnique } } as never, {} as PreferencesService);
    return controller.me(caller);
  }

  it('a standard user: each granted company with its ticked categories, as the guard read them', async () => {
    const caller = makeStandardUser({
      accessibleSubsidiaryIds: ['sub-1', 'sub-2'],
      categoryGrants: { 'sub-1': ['Electricity', 'Natural Gas'], 'sub-2': [] },
    });
    const body = await me(caller);
    expect(body.role).toBe('standard_user');
    expect(body.access).toEqual([
      { subsidiaryId: 'sub-1', categories: ['Electricity', 'Natural Gas'], kind: 'assigned' },
      { subsidiaryId: 'sub-2', categories: [], kind: 'assigned' },
    ]);
  });

  it('a central reporter: its main company and each grant company, with their kinds (task 3.1)', async () => {
    const caller = makeStandardUser({
      accessibleSubsidiaryIds: ['sub-t', 'sub-a'],
      categoryGrants: { 'sub-t': ['Water'], 'sub-a': ['Mobile Combustion'] },
      grantKinds: { 'sub-t': 'assigned', 'sub-a': 'central_reporter' },
    });
    expect((await me(caller)).access).toEqual([
      { subsidiaryId: 'sub-t', categories: ['Water'], kind: 'assigned' },
      { subsidiaryId: 'sub-a', categories: ['Mobile Combustion'], kind: 'central_reporter' },
    ]);
  });

  it('a standard user whose grant has no category entry reads an empty list there, never every category', async () => {
    const body = await me(makeStandardUser({ accessibleSubsidiaryIds: ['sub-1'], categoryGrants: {} }));
    expect(body.access).toEqual([{ subsidiaryId: 'sub-1', categories: [], kind: 'assigned' }]);
  });

  it('the list is a copy: mutating the answer does not reach the request user', async () => {
    const caller = makeStandardUser({ accessibleSubsidiaryIds: ['sub-1'], categoryGrants: { 'sub-1': ['Electricity'] } });
    const body = await me(caller);
    body.access[0].categories.push('Fuel');
    expect(caller.categoryGrants?.['sub-1']).toEqual(['Electricity']);
  });

  it('a super_admin: each granted company with no category list, even if the guard carried one', async () => {
    const body = await me(makeSuperAdmin({ accessibleSubsidiaryIds: ['sub-1', 'sub-2'], categoryGrants: { 'sub-1': ['Electricity'] } }));
    expect(body.access).toEqual([
      { subsidiaryId: 'sub-1', categories: [], kind: 'assigned' },
      { subsidiaryId: 'sub-2', categories: [], kind: 'assigned' },
    ]);
  });

  it('a super_admin with no grant: an empty list', async () => {
    const body = await me(makeSuperAdmin({ accessibleSubsidiaryIds: [] }));
    expect(body.access).toEqual([]);
    expect(body.accessibleSubsidiaryIds).toEqual([]);
  });

  it.each([
    ['masterkey', makeMasterkey()],
    ['auditor', makeAuditor()],
  ] as const)('a %s holds no grant: an empty list, though it reads every company', async (_role, caller) => {
    const body = await me(caller);
    expect(body.access).toEqual([]);
    expect(body.accessibleSubsidiaryIds).toEqual(caller.accessibleSubsidiaryIds);
    expect(body.accessibleSubsidiaryIds.length).toBeGreaterThan(0);
  });
});

describe('GET /me — onboardingPending (inc26-central-reporter-onboarding, task 7.3)', () => {
  function me(caller: RequestUser, onboardingCompletedAt: Date | null) {
    const findUnique = vi.fn(async () => ({ fullName: caller.fullName, language: 'en', theme: 'light', organisation: { onboardingCompletedAt } }));
    return new AuthController({ profile: { findUnique } } as never, {} as PreferencesService).me(caller);
  }

  it('a masterkey of an unfinished organisation is pending; of a finished one, not', async () => {
    expect((await me(makeMasterkey(), null)).onboardingPending).toBe(true);
    expect((await me(makeMasterkey(), new Date())).onboardingPending).toBe(false);
  });

  it.each([
    ['super_admin', makeSuperAdmin()],
    ['standard_user', makeStandardUser()],
    ['auditor', makeAuditor()],
  ] as const)('a %s is never pending, finished or not', async (_role, caller) => {
    expect((await me(caller, null)).onboardingPending).toBe(false);
    expect((await me(caller, new Date())).onboardingPending).toBe(false);
  });
});
