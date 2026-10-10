import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, SESSION_REVOKED_PATH } from './api';

// Its own file: `lib/api.ts` ends a session once per page load, and
// `api-users.spec.ts` spends that on `account_disabled`.
const signOut = vi.fn(async () => ({ error: null }));
vi.mock('./supabase', () => ({ getSupabaseBrowserClient: () => ({ auth: { signOut: (...a: unknown[]) => signOut(...(a as [])) } }) }));
const assign = vi.fn();
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('a revoked session (a disable since it began) ends like a disabled account', () => {
  it('signs out locally and lands on the sign-in page with its own reason', async () => {
    vi.stubGlobal('window', { location: { assign } });
    const error = await apiError(new Response(JSON.stringify({ code: 'session_revoked', message: 'ended' }), { status: 401 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(error).toMatchObject({ status: 401, code: 'session_revoked' });
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(assign).toHaveBeenCalledWith(SESSION_REVOKED_PATH);
    expect(SESSION_REVOKED_PATH).toBe('/login?reason=session_revoked'); // the reason the login page words
  });
});
