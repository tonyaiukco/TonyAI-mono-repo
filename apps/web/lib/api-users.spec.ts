import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_DISABLED_PATH, api, ApiError, apiError } from './api';

const signOut = vi.fn(async () => ({ error: null }));
vi.mock('./supabase', () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
      signOut: (...args: unknown[]) => signOut(...(args as [])),
    },
  }),
}));

const fetchMock = vi.fn();
const assign = vi.fn();
// A fresh Response per call: a body is read once.
const respond = (body: unknown, status = 200) => {
  fetchMock.mockImplementation(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));
};
const call = (i = 0) => ({ url: new URL(fetchMock.mock.calls[i][0]), init: fetchMock.mock.calls[i][1] as RequestInit });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('LP4-01 user management calls', () => {
  it('pages users through the bounded-access contract', async () => {
    respond({ items: [], limit: 50, nextCursor: null });
    await api.listUsersPage({ cursor: 'abc' });
    expect(call().url.pathname).toBe('/api/v1/users');
    expect(Object.fromEntries(call().url.searchParams)).toEqual({ cursor: 'abc' });
  });

  it('refuses an array where a page was promised (an older API)', async () => {
    respond([]);
    await expect(api.listUsersPage()).rejects.toMatchObject({ status: 502 });
  });

  it('sends each action to its route and method', async () => {
    respond({ id: 'u' });
    await api.inviteUser({ email: 'a@b.test', fullName: 'A', role: 'data_entry', language: 'tr', subsidiaryIds: ['s'] });
    await api.resendInvitation('u');
    await api.setUserRole('u', { role: 'consultant' });
    await api.replaceUserAccess('u', { subsidiaryIds: [] });
    await api.disableUser('u');
    await api.enableUser('u');
    expect(fetchMock.mock.calls.map((_, i) => `${call(i).init.method} ${call(i).url.pathname}`)).toEqual([
      'POST /api/v1/users/invitations',
      'POST /api/v1/users/u/invitation/resend',
      'PATCH /api/v1/users/u/role',
      'PUT /api/v1/users/u/access',
      'POST /api/v1/users/u/disable',
      'POST /api/v1/users/u/enable',
    ]);
    expect(JSON.parse(call(0).init.body as string)).toEqual({
      email: 'a@b.test', fullName: 'A', role: 'data_entry', language: 'tr', subsidiaryIds: ['s'],
    });
  });

  it('accepts an invitation with the invitee session (204, no body)', async () => {
    respond(undefined, 204);
    await expect(api.acceptInvitation()).resolves.toBeUndefined();
    expect(call().url.pathname).toBe('/api/v1/invitations/accept');
    expect((call().init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('requests a reset without a session header and reads no body from the 202', async () => {
    respond(undefined, 202);
    await expect(api.requestPasswordReset({ email: 'a@b.test' })).resolves.toBeUndefined();
    expect(call().url.pathname).toBe('/api/v1/auth/password-reset');
    expect(call().init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('surfaces a reset refused by the quota as rate_limited', async () => {
    respond({ statusCode: 429, code: 'rate_limited', message: 'slow down' }, 429);
    await expect(api.requestPasswordReset({ email: 'a@b.test' })).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });
});

// Order matters below: the session ends once per page load.
describe('a disabled account (D19) — the one place the session ends', () => {
  beforeEach(() => vi.stubGlobal('window', { location: { assign } }));

  it('leaves an ordinary 401 to the screen — an expired session is not a disabled account', async () => {
    const error = await apiError(new Response(JSON.stringify({ code: 'unauthorized', message: 'x' }), { status: 401 }));
    await flush();
    expect(error).toBeInstanceOf(ApiError);
    expect(signOut).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('signs out locally and goes to the sign-in page, once however many calls fail', async () => {
    respond({ statusCode: 401, code: 'account_disabled', message: 'disabled' }, 401);
    const results = await Promise.allSettled([api.me(), api.listUsersPage()]);
    await flush();
    for (const r of results) expect(r).toMatchObject({ status: 'rejected', reason: { status: 401, code: 'account_disabled' } });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(ACCOUNT_DISABLED_PATH);
  });
});
