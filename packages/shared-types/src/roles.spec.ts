import { describe, it, expect } from 'vitest';
import {
  ACCESS_ASSIGNABLE_ROLES,
  API_ERROR_PARAMS,
  API_ERROR_SENTENCE_SELECTORS,
  API_ERROR_STATUS,
  AUDIT_ACTIONS,
  CAPABILITIES,
  INVITABLE_ROLES,
  LEGACY_ROLES,
  RECORD_APPROVERS,
  ROLE_CAPABILITIES,
  ROLE_CHANGE_TARGETS,
  USER_ROLES,
  can,
  displayRole,
  isGrantedRole,
  isUserRole,
  mayDecideRecord,
  recordApprover,
  type Capability,
  type RecordApprover,
  type UserRole,
} from './index';

// inc26-roles-approval-chain: the role model of INC-2.6 §1 and §6.

describe('the four roles', () => {
  it('are the document\'s four roles', () => {
    expect(USER_ROLES).toEqual(['masterkey', 'super_admin', 'standard_user', 'auditor']);
  });

  it('know no retired name', () => {
    for (const retired of ['consultant', 'data_entry', 'executive_viewer', 'legacy_super_admin']) {
      expect(isUserRole(retired), retired).toBe(false);
    }
  });

  it('list the legacy display names separately', () => {
    expect(LEGACY_ROLES).toEqual(['legacy_super_admin', 'consultant', 'data_entry', 'executive_viewer']);
  });
});

describe('displayRole — history under the new names (design Decision 10)', () => {
  const cutOver = '2026-11-26T10:00:00.000Z';

  it('shows a super_admin stored before the cut-over as the earlier, organisation-wide role', () => {
    expect(displayRole('super_admin', '2026-11-20T09:00:00.000Z', cutOver)).toBe('legacy_super_admin');
    expect(displayRole('super_admin', new Date('2026-11-26T09:59:59.999Z'), new Date(cutOver))).toBe('legacy_super_admin');
  });

  it('shows a super_admin stored at or after the cut-over as today\'s scoped role', () => {
    expect(displayRole('super_admin', cutOver, cutOver)).toBe('super_admin');
    expect(displayRole('super_admin', '2026-11-27T00:00:00.000Z', cutOver)).toBe('super_admin');
  });

  it('shows every row of an organisation with no cut-over under today\'s names', () => {
    expect(displayRole('super_admin', '2020-01-01T00:00:00.000Z', null)).toBe('super_admin');
    expect(displayRole('super_admin', '2020-01-01T00:00:00.000Z', undefined)).toBe('super_admin');
  });

  it('passes the three retired names and today\'s names through', () => {
    for (const role of ['consultant', 'data_entry', 'executive_viewer', 'masterkey', 'standard_user', 'auditor']) {
      expect(displayRole(role, '2026-11-20T00:00:00.000Z', cutOver)).toBe(role);
    }
  });

  it('answers null for no role or unknown text — never a guess', () => {
    expect(displayRole(null, cutOver, cutOver)).toBeNull();
    expect(displayRole('legacy_super_admin', cutOver, cutOver)).toBeNull();
    expect(displayRole('SUPER_ADMIN', cutOver, cutOver)).toBeNull();
    expect(displayRole('owner', cutOver, cutOver)).toBeNull();
  });
});

// A literal copy of INC-2.6 §6's matrix as design Decision 3 reads it, plus
// ruling R4 (a power no document gives a super_admin stays with the
// masterkey). M = masterkey, S = super_admin, U = standard_user, A = auditor.
// A changed cell fails by name.
const MATRIX: Record<Capability, string> = {
  'scope.organisation': 'M..A',
  'scope.granted': '.SU.',
  'scope.categories': '..U.',
  'record.author': 'MSU.',
  'record.decide': 'MS..',
  'record.void': 'M...',
  'record.delete_any_draft': 'M...',
  'record.copy_any_voided': 'M...',
  'company.write': 'M...',
  'company.create_child': 'MS..',
  'consolidation.write': 'M...',
  'location.write': 'MS..',
  'period_lock.write': 'M...',
  'target.write': 'M...',
  'intensity.write': 'M...',
  'boundary.write': 'M...',
  'boundary.write_granted': 'MS..',
  'dataset.capture': 'M...',
  'report.issue': 'M...',
  'report.issue_final': 'M...',
  'dataset.capture_open_boundary': 'M...',
  'dataset.read': 'M..A',
  'report.generate': 'MS.A',
  'import_batch.read_all': 'M..A',
  'audit.read': 'M..A',
  'record_trail.read_any': 'MS.A',
  'users.list': 'MS..',
  'users.invite': 'MS..',
  'users.set_access': 'MS..',
  'users.set_role': 'M...',
  'users.disable': 'M...',
  'central_reporter.grant': 'M...',
  'onboarding.run': 'M...',
  // inc28-fuel-bulk D7, D14 (C5, C8).
  'fuel_account.write': 'M...',
  'fuel_account.confirm_granted': 'MS..',
  'fuel_account.read_all': 'M..A',
  'fuel_rows.take_over': 'M...',
};
const COLUMN: Record<UserRole, number> = { masterkey: 0, super_admin: 1, standard_user: 2, auditor: 3 };

describe('ROLE_CAPABILITIES — pinned cell by cell against the access matrix', () => {
  it('has exactly the matrix\'s rows', () => {
    expect([...CAPABILITIES].sort()).toEqual(Object.keys(MATRIX).sort());
  });

  for (const capability of Object.keys(MATRIX) as Capability[]) {
    for (const role of USER_ROLES) {
      const expected = MATRIX[capability][COLUMN[role]] !== '.';
      it(`${capability} × ${role} → ${expected}`, () => {
        expect(can(role, capability)).toBe(expected);
      });
    }
  }

  it('gives every role exactly one scope', () => {
    for (const role of USER_ROLES) {
      expect(Number(can(role, 'scope.organisation')) + Number(can(role, 'scope.granted')), role).toBe(1);
    }
  });

  it('grants nothing to a retired, unknown, mis-cased or missing role', () => {
    for (const capability of CAPABILITIES) {
      for (const role of ['consultant', 'data_entry', 'executive_viewer', 'MASTERKEY', '', null, undefined]) {
        expect(can(role, capability), `${capability} × ${String(role)}`).toBe(false);
      }
    }
  });

  it('answers false for a capability it does not know, inherited names included', () => {
    expect(can('masterkey', 'constructor' as Capability)).toBe(false);
    expect(can('masterkey', 'toString' as Capability)).toBe(false);
  });

  it('is frozen, so no caller widens a power at runtime', () => {
    expect(Object.isFrozen(ROLE_CAPABILITIES)).toBe(true);
  });

  it('knows the granted roles', () => {
    expect(isGrantedRole('super_admin')).toBe(true);
    expect(isGrantedRole('standard_user')).toBe(true);
    expect(isGrantedRole('masterkey')).toBe(false);
    expect(isGrantedRole('auditor')).toBe(false);
    expect(isGrantedRole('data_entry')).toBe(false);
  });
});

describe('account administration (design Decision 9)', () => {
  it('lets a masterkey invite super_admins and auditors, a super_admin standard users, and nobody a masterkey', () => {
    expect(INVITABLE_ROLES).toEqual({
      masterkey: ['super_admin', 'auditor'],
      super_admin: ['standard_user'],
      standard_user: [],
      auditor: [],
    });
    for (const roles of Object.values(INVITABLE_ROLES)) expect(roles).not.toContain('masterkey');
  });

  it('lets a masterkey set a super_admin\'s companies and a super_admin a standard user\'s (ruling R3)', () => {
    expect(ACCESS_ASSIGNABLE_ROLES).toEqual({
      masterkey: ['super_admin'],
      super_admin: ['standard_user'],
      standard_user: [],
      auditor: [],
    });
  });

  it('never changes an account to masterkey (ruling R1)', () => {
    expect(ROLE_CHANGE_TARGETS).toEqual(['super_admin', 'standard_user', 'auditor']);
  });
});

describe('recordApprover — who decides a pending record (INC-2.6 §1.1)', () => {
  const both = [true, false];

  it('a masterkey\'s record: its author, whatever the company', () => {
    for (const companyHasActiveSuperAdmin of both) {
      expect(recordApprover({ authorRole: 'masterkey', authorDisabled: false, companyHasActiveSuperAdmin })).toBe('author');
    }
  });

  it('a super_admin\'s record: a masterkey, whatever the company', () => {
    for (const companyHasActiveSuperAdmin of both) {
      expect(recordApprover({ authorRole: 'super_admin', authorDisabled: false, companyHasActiveSuperAdmin })).toBe('masterkey');
    }
  });

  it.each(['standard_user', 'auditor', 'consultant', 'data_entry', null, undefined])(
    'a %s author\'s record: the company\'s super_admin, else the masterkey',
    (authorRole) => {
      expect(recordApprover({ authorRole, authorDisabled: false, companyHasActiveSuperAdmin: true })).toBe('super_admin');
      expect(recordApprover({ authorRole, authorDisabled: false, companyHasActiveSuperAdmin: false })).toBe('masterkey');
    },
  );

  it.each(USER_ROLES)('a disabled %s author\'s record routes like a standard user\'s', (authorRole) => {
    expect(recordApprover({ authorRole, authorDisabled: true, companyHasActiveSuperAdmin: true })).toBe('super_admin');
    expect(recordApprover({ authorRole, authorDisabled: true, companyHasActiveSuperAdmin: false })).toBe('masterkey');
  });

  it('answers one of the three approvers', () => {
    expect(RECORD_APPROVERS).toEqual(['author', 'masterkey', 'super_admin']);
  });
});

describe('mayDecideRecord', () => {
  const mk = { id: 'mk', role: 'masterkey' };
  const mk2 = { id: 'mk2', role: 'masterkey' };
  const sa = { id: 'sa', role: 'super_admin' };
  const sa2 = { id: 'sa2', role: 'super_admin' };
  const su = { id: 'su', role: 'standard_user' };
  const au = { id: 'au', role: 'auditor' };
  const decide = (user: { id: string; role: string }, createdBy: string, approver: RecordApprover) =>
    mayDecideRecord(user, { createdBy }, approver);

  it('lets a masterkey decide their own record, and nobody else', () => {
    expect(decide(mk, 'mk', 'author')).toBe(true);
    expect(decide(mk2, 'mk', 'author')).toBe(false);
    expect(decide(sa, 'mk', 'author')).toBe(false);
    expect(decide(au, 'mk', 'author')).toBe(false);
  });

  it('never lets a non-masterkey author decide as `author`', () => {
    for (const user of [sa, su, au]) expect(decide(user, user.id, 'author')).toBe(false);
  });

  it('lets a masterkey decide a super_admin\'s record, not the super_admin or a colleague', () => {
    expect(decide(mk, 'sa', 'masterkey')).toBe(true);
    expect(decide(sa, 'sa', 'masterkey')).toBe(false);
    expect(decide(sa2, 'sa', 'masterkey')).toBe(false);
  });

  it('a masterkey decides a standard user\'s record only on the fallback', () => {
    expect(decide(mk, 'su', 'masterkey')).toBe(true);
    expect(decide(mk, 'su', 'super_admin')).toBe(false);
  });

  it('a super_admin decides a standard user\'s record, never their own', () => {
    expect(decide(sa, 'su', 'super_admin')).toBe(true);
    expect(decide(sa, 'sa', 'super_admin')).toBe(false);
  });

  it('a masterkey never decides a record they created as `masterkey` (they are the author)', () => {
    expect(decide(mk, 'mk', 'masterkey')).toBe(false);
  });

  it('refuses standard users, auditors, retired roles and missing input', () => {
    for (const approver of RECORD_APPROVERS) {
      expect(decide(su, 'other', approver)).toBe(false);
      expect(decide(au, 'other', approver)).toBe(false);
      expect(decide({ id: 'c', role: 'consultant' }, 'other', approver)).toBe(false);
    }
    expect(mayDecideRecord(null, { createdBy: 'su' }, 'super_admin')).toBe(false);
    expect(mayDecideRecord(sa, null, 'super_admin')).toBe(false);
    expect(mayDecideRecord(sa, { createdBy: 'su' }, null)).toBe(false);
  });
});

describe('the contract\'s new codes and actions', () => {
  it('registers not_record_approver (403, approver as a sentence selector)', () => {
    expect(API_ERROR_STATUS.not_record_approver).toBe(403);
    expect(API_ERROR_PARAMS.not_record_approver).toEqual(['approver']);
    expect(API_ERROR_SENTENCE_SELECTORS.not_record_approver).toBe('approver');
  });

  it('registers category_not_granted (403, naming the category)', () => {
    expect(API_ERROR_STATUS.category_not_granted).toBe(403);
    expect(API_ERROR_PARAMS.category_not_granted).toEqual(['category']);
  });

  it('registers standard_user_single_company (409, no params)', () => {
    expect(API_ERROR_STATUS.standard_user_single_company).toBe(409);
    expect(Object.keys(API_ERROR_PARAMS)).not.toContain('standard_user_single_company');
  });

  it('knows the self-approval and the carry-over as audit actions', () => {
    expect(AUDIT_ACTIONS).toContain('self_approve');
    expect(AUDIT_ACTIONS).toContain('role_model_change');
    expect(AUDIT_ACTIONS).toContain('approve');
  });
});
