import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const acceptInvitation = vi.fn();
const getSession = vi.fn();
vi.mock('./supabase', () => ({ getSupabaseBrowserClient: () => ({ auth: { getSession: () => getSession() } }) }));
vi.mock('./api', () => ({ api: { acceptInvitation: (token: string) => acceptInvitation(token) } }));

import { ACCEPT_WAIT_MS, acceptOwnInvitation } from './invitation-acceptance';

const unavailable = () => Object.assign(new Error('unavailable'), { status: 503 });

describe('acceptOwnInvitation (Codex reviews of #350 and pre-g5-security-hardening)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    acceptInvitation.mockReset();
    getSession.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const run = async (token: string | undefined) => {
    const result = acceptOwnInvitation(token);
    await vi.runAllTimersAsync();
    return result;
  };

  it('accepts with the token it was given, and never reads the shared session', async () => {
    acceptInvitation.mockResolvedValue(undefined);
    expect(await run('token-of-the-auth-operation')).toBe(true);
    expect(acceptInvitation.mock.calls).toEqual([['token-of-the-auth-operation']]);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('calls nothing without a token', async () => {
    expect(await run(undefined)).toBe(false);
    expect(acceptInvitation).not.toHaveBeenCalled();
  });

  it('repeats a transient failure with the same token, whatever another tab does meanwhile', async () => {
    acceptInvitation.mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockResolvedValue(undefined);
    expect(await run('token-a')).toBe(true);
    expect(acceptInvitation.mock.calls).toEqual([['token-a'], ['token-a'], ['token-a']]);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('stops on a refusal a repeat cannot change', async () => {
    acceptInvitation.mockRejectedValue(Object.assign(new Error('expired'), { status: 401 }));
    expect(await run('token-a')).toBe(false);
    expect(acceptInvitation).toHaveBeenCalledTimes(1);
  });

  it('answers false after ACCEPT_WAIT_MS when the API never answers, and the caller goes on', async () => {
    acceptInvitation.mockReturnValue(new Promise(() => undefined));
    const result = acceptOwnInvitation('token-a');
    await vi.advanceTimersByTimeAsync(ACCEPT_WAIT_MS - 1);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
  });
});
