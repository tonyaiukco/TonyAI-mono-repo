import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const recordPasswordSetCall = vi.fn();
vi.mock('./supabase', () => ({ getSupabaseBrowserClient: () => ({ auth: { getSession: () => getSession() } }) }));
vi.mock('./api', () => ({ api: { recordPasswordSet: (flow: string, token: string) => recordPasswordSetCall(flow, token) } }));

import { BOUNDED_CALL_WAIT_MS } from './invitation-acceptance';
import { recordPasswordSet } from './password-set-record';

const as = (id: string | null, token = `token-${id}`) => ({
  data: { session: id === null ? null : { user: { id }, access_token: token } },
});
const unavailable = () => Object.assign(new Error('unavailable'), { status: 503 });

describe('recordPasswordSet (pre-g5-security-hardening)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSession.mockReset();
    recordPasswordSetCall.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const run = async (userId: string | undefined, flow: 'invite' | 'recovery') => {
    const result = recordPasswordSet(userId, flow);
    await vi.runAllTimersAsync();
    return result;
  };

  it('records the flow once, with the token of the session read that checked the user', async () => {
    getSession.mockResolvedValue(as('user-a', 'checked-token'));
    recordPasswordSetCall.mockResolvedValue(undefined);
    expect(await run('user-a', 'recovery')).toBe(true);
    expect(recordPasswordSetCall.mock.calls).toEqual([['recovery', 'checked-token']]);
  });

  it('writes nothing when the session is now someone else\'s (another tab signed them in)', async () => {
    getSession.mockResolvedValue(as('user-b'));
    expect(await run('user-a', 'invite')).toBe(false);
    expect(recordPasswordSetCall).not.toHaveBeenCalled();
  });

  it('repeats a transient failure, at most three times, and never throws', async () => {
    getSession.mockResolvedValue(as('user-a'));
    recordPasswordSetCall.mockRejectedValue(unavailable());
    expect(await run('user-a', 'invite')).toBe(false);
    expect(recordPasswordSetCall).toHaveBeenCalledTimes(3);
  });

  it('holds the page for BOUNDED_CALL_WAIT_MS at most when the API never answers', async () => {
    getSession.mockResolvedValue(as('user-a'));
    recordPasswordSetCall.mockReturnValue(new Promise(() => undefined));
    const result = recordPasswordSet('user-a', 'invite');
    await vi.advanceTimersByTimeAsync(BOUNDED_CALL_WAIT_MS);
    expect(await result).toBe(false);
  });
});
