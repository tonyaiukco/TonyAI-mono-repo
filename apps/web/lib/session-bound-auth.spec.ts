import { describe, expect, it, vi } from 'vitest';
import { authForCheckedSession } from './session-bound-auth';

const checked = { access_token: 'access-a', refresh_token: 'refresh-a', user: { id: 'user-a' } };

function fakeCreate(answer: { data: { user: { id: string } | null }; error: unknown }) {
  const auth = { setSession: vi.fn(async () => answer), updateUser: vi.fn(), signOut: vi.fn() };
  const create = vi.fn((_url: string, _key: string, _options: unknown) => ({ auth }) as never);
  return { auth, create };
}

describe('authForCheckedSession (Codex review of pre-g5-security-hardening, P1)', () => {
  it('builds an in-memory client from the checked tokens alone and hands back its auth', async () => {
    const { auth, create } = fakeCreate({ data: { user: { id: 'user-a' } }, error: null });
    const bound = await authForCheckedSession(checked, create);
    expect(bound).toBe(auth);
    expect(auth.setSession).toHaveBeenCalledWith({ access_token: 'access-a', refresh_token: 'refresh-a' });
    const options = create.mock.calls[0][2] as unknown as { auth: Record<string, unknown> };
    // Nothing shared with the browser's session: no storage, no refresh timer, no cross-tab channel.
    expect(options.auth).toMatchObject({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
    expect(options.auth.storageKey).not.toBe('sb-tonyai-auth');
  });

  it('refuses when Auth says the tokens are someone else\'s, or answers an error', async () => {
    for (const answer of [
      { data: { user: { id: 'user-b' } }, error: null },
      { data: { user: null }, error: { message: 'invalid' } },
    ]) {
      const { create } = fakeCreate(answer);
      await expect(authForCheckedSession(checked, create)).rejects.toThrow();
    }
  });
});
