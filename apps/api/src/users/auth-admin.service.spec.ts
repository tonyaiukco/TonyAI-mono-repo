import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthAdminError, AuthAdminService } from './auth-admin.service';

const admin = {
  createUser: vi.fn(),
  getUserById: vi.fn(),
  generateLink: vi.fn(),
  updateUserById: vi.fn(),
};
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { admin } }) }));

const ID = '11111111-1111-4111-8111-111111111111';
const fail = (code: string) => ({ data: { user: null }, error: { code } });

describe('AuthAdminService — every Auth answer onboarding depends on (measured against GoTrue in LP4-01)', () => {
  let service: AuthAdminService;
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    service = new AuthAdminService();
  });

  it('creates the Auth user with the profile id; a second time, the same user is fine', async () => {
    admin.createUser.mockResolvedValueOnce({ data: { user: { id: ID } }, error: null });
    await service.ensureUser(ID, 'a@b.test');
    expect(admin.createUser).toHaveBeenCalledWith({ id: ID, email: 'a@b.test', email_confirm: false });
    admin.createUser.mockResolvedValueOnce(fail('email_exists'));
    admin.getUserById.mockResolvedValueOnce({ data: { user: { id: ID, email: 'A@B.test' } }, error: null });
    await expect(service.ensureUser(ID, 'a@b.test')).resolves.toBeUndefined();
  });

  it('an address held by another Auth user is unavailable; the profile id under another address is a mismatch', async () => {
    admin.createUser.mockResolvedValue(fail('email_exists'));
    admin.getUserById.mockResolvedValueOnce({ data: { user: null }, error: { code: 'user_not_found' } });
    await expect(service.ensureUser(ID, 'a@b.test')).rejects.toMatchObject({ code: 'email_unavailable' });
    admin.getUserById.mockResolvedValueOnce({ data: { user: { id: ID, email: 'other@b.test' } }, error: null });
    await expect(service.ensureUser(ID, 'a@b.test')).rejects.toMatchObject({ code: 'auth_user_mismatch' });
    admin.createUser.mockResolvedValueOnce(fail('unexpected_failure'));
    await expect(service.ensureUser(ID, 'a@b.test')).rejects.toMatchObject({ code: 'auth_unavailable' });
  });

  it('never returns a token minted for another account', async () => {
    admin.generateLink.mockResolvedValueOnce({ data: { user: { id: ID }, properties: { hashed_token: 'tok' } }, error: null });
    await expect(service.inviteToken(ID, 'a@b.test')).resolves.toBe('tok');
    admin.generateLink.mockResolvedValueOnce({ data: { user: { id: 'someone-else' }, properties: { hashed_token: 'tok' } }, error: null });
    await expect(service.recoveryToken(ID, 'a@b.test')).rejects.toMatchObject({ code: 'auth_user_mismatch' });
    expect(admin.generateLink).toHaveBeenLastCalledWith({ type: 'recovery', email: 'a@b.test' });
  });

  it('names each failed link: an address already confirmed, no Auth user, anything else', async () => {
    for (const [code, expected] of [['email_exists', 'email_unavailable'], ['user_not_found', 'auth_user_missing'], ['over_request_rate_limit', 'auth_unavailable']] as const) {
      admin.generateLink.mockResolvedValueOnce({ data: { user: null, properties: null }, error: { code } });
      const error = await service.inviteToken(ID, 'a@b.test').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthAdminError);
      expect((error as AuthAdminError).code).toBe(expected);
    }
  });

  it('bans for ten years and unbans with "none"; an id Auth does not know has nothing to ban', async () => {
    admin.updateUserById.mockResolvedValue({ data: { user: { id: ID } }, error: null });
    await service.setBanned(ID, true);
    await service.setBanned(ID, false);
    expect(admin.updateUserById.mock.calls).toEqual([[ID, { ban_duration: '876000h' }], [ID, { ban_duration: 'none' }]]);
    admin.updateUserById.mockResolvedValueOnce(fail('user_not_found'));
    await expect(service.setBanned(ID, true)).resolves.toBeUndefined();
    admin.updateUserById.mockResolvedValueOnce(fail('unexpected_failure'));
    await expect(service.setBanned(ID, true)).rejects.toMatchObject({ code: 'auth_unavailable' });
  });

  it('without the service-role settings it fails as unavailable, never with a half-built client', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(new AuthAdminService().setBanned(ID, true)).rejects.toMatchObject({ code: 'auth_unavailable' });
  });
});
