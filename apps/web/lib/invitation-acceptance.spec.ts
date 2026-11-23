import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const acceptInvitation = vi.fn();
vi.mock('./supabase', () => ({ getSupabaseBrowserClient: () => ({ auth: { getSession: () => getSession() } }) }));
vi.mock('./api', () => ({ api: { acceptInvitation: (token: string) => acceptInvitation(token) } }));

import { ACCEPT_WAIT_MS, acceptOwnInvitation } from './invitation-acceptance';

const as = (id: string | null, token = `token-${id}`) => ({
  data: { session: id === null ? null : { user: { id }, access_token: token } },
});
const unavailable = () => Object.assign(new Error('unavailable'), { status: 503 });

describe('acceptOwnInvitation (Codex reviews of #350)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSession.mockReset();
    acceptInvitation.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const run = async (userId: string | undefined = 'user-a') => {
    const result = acceptOwnInvitation(userId);
    await vi.runAllTimersAsync();
    return result;
  };

  it('accepts for the subject, with the token of the very session read that checked it', async () => {
    getSession.mockResolvedValue(as('user-a', 'token-read-once'));
    acceptInvitation.mockResolvedValue(undefined);
    expect(await run()).toBe(true);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(acceptInvitation).toHaveBeenCalledWith('token-read-once');
  });

  it('calls nothing without a subject, or when the session is already someone else\'s on the first attempt', async () => {
    expect(await run(undefined)).toBe(false);
    getSession.mockResolvedValue(as('user-b'));
    expect(await run('user-a')).toBe(false);
    getSession.mockResolvedValue(as(null));
    expect(await run('user-a')).toBe(false);
    expect(acceptInvitation).not.toHaveBeenCalled();
  });

  it('repeats while the subject is signed in, each time with a fresh read', async () => {
    getSession.mockResolvedValueOnce(as('user-a', 't1')).mockResolvedValue(as('user-a', 't2'));
    acceptInvitation.mockRejectedValueOnce(unavailable()).mockResolvedValue(undefined);
    expect(await run()).toBe(true);
    expect(acceptInvitation.mock.calls).toEqual([['t1'], ['t2']]);
  });

  it('stops instead of repeating for someone another tab signed in meanwhile', async () => {
    getSession.mockResolvedValueOnce(as('user-a')).mockResolvedValue(as('user-b'));
    acceptInvitation.mockRejectedValue(unavailable());
    expect(await run()).toBe(false);
    expect(acceptInvitation).toHaveBeenCalledTimes(1);
  });

  it('stops when the session cannot be read', async () => {
    getSession.mockResolvedValueOnce(as('user-a')).mockRejectedValue(new Error('storage'));
    acceptInvitation.mockRejectedValue(unavailable());
    expect(await run()).toBe(false);
    expect(acceptInvitation).toHaveBeenCalledTimes(1);
  });

  it('answers false after ACCEPT_WAIT_MS when the API never answers, and the caller goes on', async () => {
    getSession.mockResolvedValue(as('user-a'));
    acceptInvitation.mockReturnValue(new Promise(() => undefined));
    const result = acceptOwnInvitation('user-a');
    await vi.advanceTimersByTimeAsync(ACCEPT_WAIT_MS - 1);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
  });
});
