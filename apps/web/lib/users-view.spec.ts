import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { copyFor } from '@/lib/i18n/testing';
import { CATEGORIES, type Category, type InvitationStateDTO, type UserRole, type UserSummaryDTO } from '@/lib/types';
import {
  accessPayload,
  accessSummary,
  accessWarnings,
  appendPage,
  assignableCompanies,
  canResend,
  categorySelection,
  chooseCompany,
  clearCategories,
  companySelection,
  initialDraft,
  initialRoleChoice,
  invitableRoles,
  invitationNote,
  invitePayload,
  isCarriedOver,
  mayEditAccess,
  pickerKind,
  replaceUser,
  restoreCompany,
  roleChangeFollowUp,
  roleChangeOptions,
  rowActions,
  selectAllCategories,
  selectAllCompanies,
  toggleCategory,
  toggleCompany,
  usersErrorKey,
  withdrawCompany,
  type InviteForm,
  type Reader,
  reloadAfterAccessSave,
} from './users-view';

const invitation = (over: Partial<InvitationStateDTO> = {}): InvitationStateDTO => ({
  status: 'sent', language: 'en', attempts: 1, lastErrorStep: null, lastErrorCode: null,
  lastAttemptAt: '2026-10-10T10:00:00.000Z', sentAt: '2026-10-10T10:00:00.000Z', acceptedAt: null, ...over,
});
const member = (over: Partial<UserSummaryDTO> = {}): UserSummaryDTO => ({
  id: 'u1', email: 'a@b.test', fullName: 'A', role: 'standard_user', language: 'en', status: 'invited',
  access: [], disabledAt: null, authSyncPending: false, invitation: invitation(), createdAt: '2026-10-10T09:00:00.000Z',
  ...over,
});
const grant = (subsidiaryId: string, categories: Category[] = []) => ({ subsidiaryId, categories });
const companies = (...ids: string[]) => ids.map((id) => ({ id, legalName: id.toUpperCase() }));

const masterkey: Reader = { id: 'mk', role: 'masterkey', accessibleSubsidiaryIds: ['a', 'b', 'c'] };
const superAdmin = (...ids: string[]): Reader => ({ id: 'sa', role: 'super_admin', accessibleSubsidiaryIds: ids });
const reader = (role: UserRole): Reader => ({ id: 'r', role, accessibleSubsidiaryIds: [] });

const en = copyFor('users', 'en').t;
const tr = copyFor('users', 'tr').t;
const singleCompanyRefusal = () => new ApiError('one company', 409, 'standard_user_single_company');
const form = (over: Partial<InviteForm>): InviteForm => ({
  email: ' new@b.test ', fullName: ' New ', role: 'super_admin', language: 'en', drafts: {}, ...over,
});

describe('invitationNote', () => {
  it('says when it was sent, that it is on its way, or that it failed', () => {
    expect(invitationNote(member())).toEqual({ key: 'invitationSent', values: { date: '2026-10-10T10:00:00.000Z' } });
    expect(invitationNote(member({ invitation: invitation({ status: 'pending', sentAt: null }) }))).toEqual({ key: 'invitationPending' });
    expect(
      invitationNote(member({ invitation: invitation({ status: 'pending', lastErrorStep: 'email', lastErrorCode: 'smtp_failed' }) })),
    ).toEqual({ key: 'deliveryFailed' });
  });

  it('says nothing once accepted, for a disabled account, or with no invitation', () => {
    expect(invitationNote(member({ status: 'active', invitation: invitation({ status: 'accepted', acceptedAt: 'x' }) }))).toBeNull();
    expect(invitationNote(member({ status: 'disabled', invitation: invitation({ status: 'revoked' }) }))).toBeNull();
    expect(invitationNote(member({ status: 'active', invitation: null }))).toBeNull();
  });
});

describe('canResend', () => {
  it('only an invitation not yet accepted, on an enabled account', () => {
    expect(canResend(member())).toBe(true);
    expect(canResend(member({ invitation: invitation({ status: 'pending' }) }))).toBe(true);
    expect(canResend(member({ status: 'active', invitation: invitation({ status: 'accepted' }) }))).toBe(false);
    expect(canResend(member({ status: 'disabled', invitation: invitation({ status: 'revoked' }) }))).toBe(false);
    expect(canResend(member({ status: 'active', invitation: null }))).toBe(false);
  });
});

describe('The users list states each account\'s access', () => {
  const names = new Map([
    ['den', 'Denizli Dağıtım'],
    ['cor', 'Çorum Dağıtım'],
    ['ank', 'Ankara Dağıtım'],
    ['izm', 'İzmir Dağıtım'],
    ['bur', 'Bursa Dağıtım'],
  ]);

  it('A super_admin with five companies: three names in name order, "+2 more", the full five on the row', () => {
    const row = member({ role: 'super_admin', access: ['izm', 'den', 'cor', 'bur', 'ank'].map((id) => grant(id)) });
    expect(accessSummary(row, names, 'tr-TR')).toEqual({
      key: 'named',
      names: ['Ankara Dağıtım', 'Bursa Dağıtım', 'Çorum Dağıtım'],
      overflow: 2,
      all: ['Ankara Dağıtım', 'Bursa Dağıtım', 'Çorum Dağıtım', 'Denizli Dağıtım', 'İzmir Dağıtım'],
    });
    expect(en('accessMore', { count: '2' })).toBe('+2 more');
    expect(tr('accessMore', { count: '2' })).toBe('+2 daha');
  });

  it('A standard user with no grant: "None granted" as a warning, beside the edit access action', () => {
    const row = member({ id: 'su', role: 'standard_user', access: [] });
    expect(accessSummary(row, names, 'tr-TR')).toEqual({ key: 'noAccess' });
    expect(rowActions(superAdmin('den'), row).editAccess).toBe(true);
    expect(en('noAccess')).toBe('None granted');
    expect(tr('noAccess')).toBe('Erişim verilmedi');
    // A super_admin with no grant is marked the same way.
    expect(accessSummary(member({ role: 'super_admin' }), names, 'en-GB')).toEqual({ key: 'noAccess' });
  });

  it('An auditor row: "Whole parent company" and no edit access action', () => {
    for (const role of ['auditor', 'masterkey'] as const) {
      const row = member({ id: 'x', role, access: [grant('den')] });
      expect(accessSummary(row, names, 'tr-TR')).toEqual({ key: 'wholeOrganisation' });
      expect(rowActions(masterkey, row).editAccess).toBe(false);
    }
    expect(en('wholeOrganisation')).toBe('Whole parent company');
    expect(tr('wholeOrganisation')).toBe('Ana şirketin tamamı');
  });

  it('counts a grant whose subsidiary is not loaded instead of showing its id', () => {
    const summary = accessSummary(member({ access: [grant('den'), grant('unknown-id')] }), names, 'tr-TR');
    expect(summary).toEqual({ key: 'named', names: ['Denizli Dağıtım'], overflow: 1, all: ['Denizli Dağıtım'] });
    expect(JSON.stringify(summary)).not.toContain('unknown-id');
  });
});

describe('Access is edited from the row', () => {
  it('A masterkey edits a super_admin\'s companies: the action is on the row, a further company is sent', () => {
    const row = member({ id: 's1', role: 'super_admin', access: [grant('a'), grant('b')] });
    expect(rowActions(masterkey, row)).toMatchObject({ editAccess: true, menu: true });
    const draft = toggleCompany(initialDraft(row), 'c', true);
    expect(accessPayload('super_admin', draft)).toEqual([grant('a'), grant('b'), grant('c')]);
  });

  it('A masterkey on a standard user row: names the companies, no edit access action', () => {
    const row = member({ id: 'su', role: 'standard_user', access: [grant('a', ['Electricity'])] });
    expect(accessSummary(row, new Map([['a', 'Alpha']]), 'en-GB')).toMatchObject({ key: 'named', names: ['Alpha'] });
    expect(mayEditAccess(masterkey, row)).toBe(false);
    expect(rowActions(masterkey, row).editAccess).toBe(false);
  });

  it('nobody edits their own access', () => {
    expect(mayEditAccess(superAdmin('a'), member({ id: 'sa', role: 'super_admin' }))).toBe(false);
  });
});

describe('The access picker shows and changes the whole selection', () => {
  it('Select all companies: ten ticked, "10 of 10 selected"', () => {
    const ten = companies(...'abcdefghij'.split(''));
    const listed = assignableCompanies(masterkey, ten);
    expect(listed).toHaveLength(10);
    const draft = selectAllCompanies([], listed);
    const state = companySelection(draft, listed);
    expect(state).toEqual({ count: 10, total: 10, allSelected: true, noneSelected: false });
    expect(tr('picker.selectedCount', { count: '10', total: '10' })).toBe('10 / 10 seçili');
    expect(en('picker.selectedCount', { count: '10', total: '10' })).toBe('10 of 10 selected');
  });

  it('select all keeps a grant the list does not show, and counts only listed companies', () => {
    const listed = companies('a', 'b', 'c');
    expect(selectAllCompanies([grant('added-later'), grant('a')], listed).map((g) => g.subsidiaryId)).toEqual(['added-later', 'a', 'b', 'c']);
    expect(companySelection([grant('a'), grant('gone')], listed)).toEqual({ count: 1, total: 3, allSelected: false, noneSelected: false });
    expect(toggleCompany([grant('a'), grant('b')], 'b', true).map((g) => g.subsidiaryId)).toEqual(['a', 'b']);
    expect(toggleCompany([grant('a'), grant('b')], 'a', false).map((g) => g.subsidiaryId)).toEqual(['b']);
  });

  it('A super_admin\'s picker: lists its two companies only, and choosing one unselects the other', () => {
    const ten = companies(...'abcdefghij'.split(''));
    const listed = assignableCompanies(superAdmin('c', 'f'), ten);
    expect(listed.map((s) => s.id)).toEqual(['c', 'f']);
    expect(pickerKind('standard_user')).toBe('singleCompany');
    const first = chooseCompany([], 'c');
    expect(chooseCompany(first, 'f')).toEqual([grant('f')]);
    // Neither an auditor nor a standard user assigns anything.
    expect(assignableCompanies(reader('auditor'), ten)).toEqual([]);
    expect(assignableCompanies(reader('standard_user'), ten)).toEqual([]);
  });

  it('Categories for the chosen company: nothing ticked, select all ticks every category, clear empties it', () => {
    const draft = chooseCompany([], 'a');
    expect(draft).toEqual([grant('a', [])]);
    expect(categorySelection(draft[0])).toMatchObject({ count: 0, total: CATEGORIES.length, noneSelected: true });
    const all = selectAllCategories(draft, 'a');
    expect(all[0].categories).toEqual([...CATEGORIES]);
    expect(categorySelection(all[0])).toMatchObject({ allSelected: true, count: CATEGORIES.length });
    expect(clearCategories(all, 'a')[0].categories).toEqual([]);
    // Choosing the company already chosen keeps its categories.
    expect(chooseCompany(all, 'a')).toEqual(all);
  });

  it('A carried-over account with two companies: both held with their categories, each withdrawable or editable, none addable', () => {
    const row = member({ id: 'co', role: 'standard_user', access: [grant('a', ['Fuel', 'Electricity']), grant('c', ['Waste'])] });
    const initial = initialDraft(row);
    expect(isCarriedOver('standard_user', initial)).toBe(true);
    expect(initial).toEqual([grant('a', ['Electricity', 'Fuel']), grant('c', ['Waste'])]);
    const edited = toggleCategory(initial, 'c', 'Water', true);
    expect(edited).toEqual([grant('a', ['Electricity', 'Fuel']), grant('c', ['Waste', 'Water'])]);
    const withdrawn = withdrawCompany(edited, 'a');
    expect(withdrawn).toEqual([grant('c', ['Waste', 'Water'])]);
    expect(restoreCompany(withdrawn, initial, 'a')).toEqual([grant('a', ['Electricity', 'Fuel']), grant('c', ['Waste', 'Water'])]);
    // The held list is the only one: a company it never held cannot be put in.
    expect(restoreCompany(withdrawn, initial, 'b')).toEqual(withdrawn);
    // A single-company account, a super_admin and an invitation are not carried over.
    expect(isCarriedOver('standard_user', [grant('a')])).toBe(false);
    expect(isCarriedOver('super_admin', [grant('a'), grant('c')])).toBe(false);
    expect(isCarriedOver('standard_user', [])).toBe(false);
  });
});

describe('An empty selection is warned, not refused', () => {
  it('Inviting with no company ticked: the warning shows and the invitation is still built, with no grant', () => {
    const listed = companies('a', 'b');
    expect(accessWarnings('super_admin', [], listed)).toEqual({ noCompany: true, noneAssignable: false, companiesWithoutCategory: [] });
    expect(invitePayload(form({ role: 'super_admin' }))).toEqual({
      email: 'new@b.test', fullName: 'New', role: 'super_admin', language: 'en', access: [],
    });
    expect(accessSummary(member({ role: 'super_admin', access: [] }), new Map(), 'en-GB')).toEqual({ key: 'noAccess' });
  });

  it('A company with no category: the picker warns and the grant is sent with no category', () => {
    const draft = chooseCompany([], 'a');
    expect(accessWarnings('standard_user', draft, companies('a'))).toEqual({
      noCompany: false, noneAssignable: false, companiesWithoutCategory: ['a'],
    });
    expect(accessPayload('standard_user', draft)).toEqual([grant('a', [])]);
    expect(en('picker.noCategoryWarning', { name: 'Alpha' })).toContain('Alpha');
  });

  it('No company exists yet: "0 of 0 selected", the none-yet line and the warning, and inviting still works', () => {
    const listed = assignableCompanies(masterkey, []);
    expect(companySelection([], listed)).toEqual({ count: 0, total: 0, allSelected: false, noneSelected: true });
    expect(accessWarnings('super_admin', [], listed)).toEqual({ noCompany: true, noneAssignable: true, companiesWithoutCategory: [] });
    expect(accessWarnings('standard_user', [], assignableCompanies(superAdmin(), companies('a')))).toMatchObject({
      noCompany: true, noneAssignable: true,
    });
    expect(tr('picker.selectedCount', { count: '0', total: '0' })).toBe('0 / 0 seçili');
    expect(en('picker.selectedCount', { count: '0', total: '0' })).toBe('0 of 0 selected');
    expect(invitePayload(form({ role: 'standard_user' })).access).toEqual([]);
  });

  it('an auditor has no picker and so nothing to warn about', () => {
    expect(accessWarnings('auditor', [], [])).toEqual({ noCompany: false, noneAssignable: false, companiesWithoutCategory: [] });
  });
});

describe('The invitation offers the roles its sender may assign', () => {
  it('a masterkey is offered Super Admin and Auditor, never Masterkey; a standard user and an auditor nothing', () => {
    expect(invitableRoles(masterkey)).toEqual(['super_admin', 'auditor']);
    expect(invitableRoles(reader('standard_user'))).toEqual([]);
    expect(invitableRoles(reader('auditor'))).toEqual([]);
    expect(invitableRoles(null)).toEqual([]);
    for (const role of ['masterkey', 'super_admin', 'standard_user', 'auditor'] as const) {
      expect(invitableRoles(reader(role))).not.toContain('masterkey');
    }
  });

  it('Choosing Auditor: the whole-parent-company note in place of the picker, and no access sent', () => {
    expect(pickerKind('auditor')).toBe('wholeOrganisation');
    expect(invitePayload(form({ role: 'auditor', drafts: { super_admin: [grant('a')] } }))).toEqual({
      email: 'new@b.test', fullName: 'New', role: 'auditor', language: 'en',
    });
    expect(en('roleAccessNote.auditor')).toContain('every subsidiary of the parent company');
  });

  it('Back to Super Admin: the picker reappears with the selection made before', () => {
    const drafts = { super_admin: [grant('a'), grant('b')] };
    expect(pickerKind('super_admin')).toBe('companies');
    // The dialog keeps one selection per role; switching to Auditor touches none of it.
    expect(invitePayload(form({ role: 'super_admin', drafts })).access).toEqual([grant('a'), grant('b')]);
  });

  it('A super_admin opens the dialog: Standard User alone', () => {
    expect(invitableRoles(superAdmin('a'))).toEqual(['standard_user']);
  });

  it('A masterkey opens the role change: Super Admin, Standard User and Auditor, not Masterkey', () => {
    expect(roleChangeOptions(masterkey)).toEqual(['super_admin', 'standard_user', 'auditor']);
    expect(roleChangeOptions(superAdmin('a'))).toEqual([]);
    // A masterkey's own role is not offered, so the select starts empty.
    expect(initialRoleChoice(member({ role: 'masterkey' }), roleChangeOptions(masterkey))).toBeNull();
    expect(initialRoleChoice(member({ role: 'auditor' }), roleChangeOptions(masterkey))).toBe('auditor');
  });

  it('the role lists are stable between renders (a dialog depending on them does not reset)', () => {
    expect(invitableRoles(reader('auditor'))).toBe(invitableRoles(reader('standard_user')));
    expect(roleChangeOptions(masterkey)).toBe(roleChangeOptions(masterkey));
  });
});

describe('A role change to a granted role leads to the access choice', () => {
  it('An auditor becomes a super_admin: the access editor opens with no company ticked and the warning', () => {
    const after = member({ id: 'x', role: 'super_admin', access: [] });
    expect(roleChangeFollowUp(masterkey, 'auditor', after)).toBe('openAccessEditor');
    const draft = initialDraft(after);
    expect(draft).toEqual([]);
    expect(accessWarnings('super_admin', draft, companies('a')).noCompany).toBe(true);
  });

  it('Closing without choosing: the role stays Super Admin and the list marks no access', () => {
    const before = member({ id: 'x', role: 'auditor' });
    const after = member({ id: 'x', role: 'super_admin', access: [] });
    const [row] = replaceUser([before], after);
    expect(row.role).toBe('super_admin');
    expect(accessSummary(row, new Map(), 'en-GB')).toEqual({ key: 'noAccess' });
  });

  it('An auditor becomes a standard user: no editor, the note that a super_admin assigns', () => {
    expect(roleChangeFollowUp(masterkey, 'auditor', member({ id: 'x', role: 'standard_user' }))).toBe('superAdminAssigns');
    expect(en('roleChangedStandardUser')).toMatch(/super admin/i);
    expect(tr('roleChangedStandardUser')).toMatch(/süper yönetici/i);
    // A change to auditor needs nothing more.
    expect(roleChangeFollowUp(masterkey, 'super_admin', member({ id: 'x', role: 'auditor' }))).toBe('none');
  });
});

describe('A standard user is assigned one company', () => {
  it('An invitation for two companies: the picker holds one, and a refusal is worded on screen', () => {
    const draft = chooseCompany(chooseCompany([], 'a'), 'b');
    expect(invitePayload(form({ role: 'standard_user', drafts: { standard_user: draft } })).access).toEqual([grant('b')]);
    expect(usersErrorKey(singleCompanyRefusal())).toBe('errors.standardUserSingleCompany');
    expect(en('errors.standardUserSingleCompany')).toContain('one subsidiary');
    expect(tr('errors.standardUserSingleCompany')).toContain('bir bağlı şirkette');
  });

  it('A second company for an assigned user: choosing B replaces A, never adds to it', () => {
    const row = member({ id: 'su', role: 'standard_user', access: [grant('a', ['Electricity'])] });
    expect(isCarriedOver('standard_user', initialDraft(row))).toBe(false);
    expect(accessPayload('standard_user', chooseCompany(initialDraft(row), 'b'))).toEqual([grant('b')]);
  });

  it('Moving a user to another company: A unticked, B ticked, sent as B alone', () => {
    const moved = chooseCompany([grant('a', ['Electricity'])], 'b');
    expect(accessPayload('standard_user', toggleCategory(moved, 'b', 'Fuel', true))).toEqual([grant('b', ['Fuel'])]);
  });

  it('A carried-over account keeps its companies: a category change on A sends A and C', () => {
    const initial = initialDraft(member({ role: 'standard_user', access: [grant('a', [...CATEGORIES]), grant('c', [...CATEGORIES])] }));
    const edited = toggleCategory(initial, 'a', 'Waste', false);
    expect(accessPayload('standard_user', edited).map((g) => g.subsidiaryId)).toEqual(['a', 'c']);
    expect(edited[0].categories).not.toContain('Waste');
    expect(edited[1].categories).toEqual([...CATEGORIES]);
  });

  it('A carried-over account gets no third company: the held list adds none, and the refusal is worded', () => {
    const initial = [grant('a'), grant('c')];
    expect(restoreCompany(initial, initial, 'b')).toEqual(initial);
    expect(usersErrorKey(singleCompanyRefusal())).toBe('errors.standardUserSingleCompany');
    // Any other refusal is the shared toast's, a 403 included.
    expect(usersErrorKey(new ApiError('no', 403, 'forbidden'))).toBeNull();
    expect(usersErrorKey(new Error('x'))).toBeNull();
  });
});

describe('A standard user\'s grant names categories', () => {
  it('Two categories ticked: exactly those two, in the product\'s order', () => {
    let draft = chooseCompany([], 'a');
    draft = toggleCategory(draft, 'a', 'Natural Gas', true);
    draft = toggleCategory(draft, 'a', 'Electricity', true);
    draft = toggleCategory(draft, 'a', 'Electricity', true);
    expect(accessPayload('standard_user', draft)).toEqual([grant('a', ['Electricity', 'Natural Gas'])]);
  });

  it('An unknown category: the checklist offers only the product\'s categories, and a stray name is never sent', () => {
    const stray = initialDraft(member({ access: [grant('a', ['Steam' as Category, 'Fuel'])] }));
    expect(stray).toEqual([grant('a', ['Fuel'])]);
    expect(CATEGORIES).not.toContain('Steam');
  });

  it('No category ticked: the grant is sent with an empty list', () => {
    expect(accessPayload('standard_user', [grant('a')])).toEqual([grant('a', [])]);
  });

  it('Categories sent for a super_admin: the request carries none (never access_role_mismatch)', () => {
    const row = member({ role: 'super_admin', access: [grant('a', ['Fuel'])] });
    expect(initialDraft(row)).toEqual([grant('a')]);
    expect(accessPayload('super_admin', [grant('a', ['Fuel']), grant('a')])).toEqual([grant('a')]);
  });
});

describe('The masterkey administers super_admins and auditors', () => {
  it('A super_admin is invited for two companies', () => {
    const drafts = { super_admin: selectAllCompanies([], companies('a', 'b')) };
    expect(invitePayload(form({ role: 'super_admin', drafts }))).toEqual({
      email: 'new@b.test', fullName: 'New', role: 'super_admin', language: 'en', access: [grant('a'), grant('b')],
    });
  });

  it('A super_admin\'s companies are changed: C added to A and B', () => {
    expect(accessPayload('super_admin', toggleCompany([grant('a'), grant('b')], 'c', true))).toEqual([grant('a'), grant('b'), grant('c')]);
  });

  it('A masterkey invites a standard user: not offered', () => {
    expect(invitableRoles(masterkey)).not.toContain('standard_user');
  });

  it('A masterkey changes their own role: their own row offers nothing', () => {
    expect(rowActions(masterkey, member({ id: 'mk', role: 'masterkey' }))).toEqual({
      editAccess: false, changeRole: false, toggleEnabled: false, resend: false, menu: false,
    });
    expect(rowActions(masterkey, member({ id: 'other', role: 'masterkey' }))).toMatchObject({ changeRole: true, toggleEnabled: true });
  });

  it('A super_admin invites an auditor: not offered', () => {
    expect(invitableRoles(superAdmin('a'))).not.toContain('auditor');
  });
});

describe('A super_admin assigns standard users in their own companies', () => {
  it('A standard user is invited for A with Electricity', () => {
    const drafts = { standard_user: toggleCategory(chooseCompany([], 'a'), 'a', 'Electricity', true) };
    expect(invitePayload(form({ role: 'standard_user', drafts }))).toMatchObject({
      role: 'standard_user', access: [grant('a', ['Electricity'])],
    });
  });

  it('A company outside the super_admin\'s scope is not listed', () => {
    expect(assignableCompanies(superAdmin('a'), companies('a', 'c')).map((s) => s.id)).toEqual(['a']);
  });

  it('Editing leaves other companies\' grants alone: only the grants the reader sees are sent', () => {
    // The API answers a super_admin granted A with the user's grant for A alone.
    const row = member({ role: 'standard_user', access: [grant('a', ['Fuel'])] });
    expect(accessPayload('standard_user', withdrawCompany(initialDraft(row), 'a'))).toEqual([]);
  });

  it('A super_admin changes a role: not offered, nor disabling or enabling', () => {
    const row = member({ id: 'su', role: 'standard_user', status: 'active', invitation: null });
    expect(rowActions(superAdmin('a'), row)).toEqual({
      editAccess: true, changeRole: false, toggleEnabled: false, resend: false, menu: true,
    });
    expect(roleChangeOptions(superAdmin('a'))).toEqual([]);
  });

  it('re-sends an invitation only to a role the reader may invite', () => {
    expect(rowActions(superAdmin('a'), member({ id: 'su', role: 'standard_user' })).resend).toBe(true);
    expect(rowActions(masterkey, member({ id: 'su', role: 'standard_user' })).resend).toBe(false);
    expect(rowActions(masterkey, member({ id: 's1', role: 'super_admin' })).resend).toBe(true);
  });
});

describe('The users list shows the accounts its reader administers', () => {
  it('A super_admin\'s list: the standard users are editable, the first shown with company A alone', () => {
    const first = member({ id: 'u1', role: 'standard_user', access: [grant('a')] });
    const third = member({ id: 'u3', role: 'standard_user', access: [] });
    expect(accessSummary(first, new Map([['a', 'Alpha']]), 'en-GB')).toEqual({ key: 'named', names: ['Alpha'], overflow: 0, all: ['Alpha'] });
    expect(accessSummary(third, new Map(), 'en-GB')).toEqual({ key: 'noAccess' });
    for (const row of [first, third]) expect(rowActions(superAdmin('a'), row).editAccess).toBe(true);
    // A row the API would not list for them offers nothing either.
    expect(rowActions(superAdmin('a'), member({ id: 'mk2', role: 'masterkey' })).menu).toBe(false);
  });

  it('A standard user lists users: nothing to invite and no row action (the API answers 403)', () => {
    expect(invitableRoles(reader('standard_user'))).toEqual([]);
    expect(rowActions(reader('standard_user'), member({ id: 'x' })).menu).toBe(false);
    expect(en('forbiddenTitle')).toMatch(/masterkey or a super admin/);
  });
});

describe('list updates', () => {
  it('replaces one member with the API answer and appends pages without repeating anyone', () => {
    const a = member({ id: 'a' });
    const b = member({ id: 'b' });
    expect(replaceUser([a, b], { ...b, fullName: 'B2' }).map((u) => u.fullName)).toEqual(['A', 'B2']);
    expect(appendPage([a], [a, b]).map((u) => u.id)).toEqual(['a', 'b']);
  });
});

describe("reloadAfterAccessSave (owner's review: a withdrawn last visible grant re-reads the list)", () => {
  const sa = { id: "sa", role: "super_admin" as const, accessibleSubsidiaryIds: ["A"] };
  const mk = { id: "mk", role: "masterkey" as const, accessibleSubsidiaryIds: ["A", "C"] };
  const grant = (id: string) => ({ subsidiaryId: id, categories: [] });

  it("re-reads when a super_admin's save leaves the row with no grant it can see", () => {
    expect(reloadAfterAccessSave(sa, { access: [grant("A")] }, { access: [] })).toBe(true);
  });
  it("keeps the row when a grant it can see remains, or when there was none to withdraw", () => {
    expect(reloadAfterAccessSave(sa, { access: [grant("A")] }, { access: [grant("A")] })).toBe(false);
    expect(reloadAfterAccessSave(sa, { access: [] }, { access: [grant("A")] })).toBe(false);
  });
  it("never re-reads for a masterkey, who sees every account and grant", () => {
    expect(reloadAfterAccessSave(mk, { access: [grant("A")] }, { access: [] })).toBe(false);
  });
});
