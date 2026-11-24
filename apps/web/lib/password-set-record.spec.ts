import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const recordPasswordSetCall = vi.fn();
vi.mock('./supabase', () => ({ getSupabaseBrowserClient: () => ({ auth: { getSession: () => getSession() } }) }));
vi.mock('./api', () => ({ api: { recordPasswordSet: (flow: string, changeId: string, token: string) => recordPasswordSetCall(flow, changeId, token) } }));

import { BOUNDED_CALL_WAIT_MS } from './invitation-acceptance';
import { recordPasswordSet } from './password-set-record';

const unavailable = () => Object.assign(new Error('unavailable'), { status: 503 });

describe('recordPasswordSet (pre-g5-security-hardening; Codex reviews)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSession.mockReset();
    recordPasswordSetCall.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const run = async (token: string | undefined, flow: 'invite' | 'recovery') => {
    const result = recordPasswordSet(token, flow);
    await vi.runAllTimersAsync();
    return result;
  };

  it('records the flow with the token of the session the password was changed through, never re-reading the shared one', async () => {
    recordPasswordSetCall.mockResolvedValue(undefined);
    expect(await run('checked-token', 'recovery')).toBe(true);
    expect(recordPasswordSetCall.mock.calls).toEqual([['recovery', expect.stringMatching(/^[0-9a-f-]{36}$/), 'checked-token']]);
    // Another tab signing someone else in cannot lose the row or move it: the shared session is not read.
    expect(getSession).not.toHaveBeenCalled();
  });

  it('records nothing without a token', async () => {
    expect(await run(undefined, 'invite')).toBe(false);
    expect(recordPasswordSetCall).not.toHaveBeenCalled();
  });

  it('repeats a transient failure, at most three times, with the same token and change id, and never throws', async () => {
    recordPasswordSetCall.mockRejectedValue(unavailable());
    expect(await run('checked-token', 'invite')).toBe(false);
    expect(recordPasswordSetCall).toHaveBeenCalledTimes(3);
    expect(new Set(recordPasswordSetCall.mock.calls.map((c) => c[1])).size).toBe(1);
    expect(new Set(recordPasswordSetCall.mock.calls.map((c) => c[2]))).toEqual(new Set(['checked-token']));
  });

  it('holds the page for BOUNDED_CALL_WAIT_MS at most when the API never answers', async () => {
    recordPasswordSetCall.mockReturnValue(new Promise(() => undefined));
    const result = recordPasswordSet('checked-token', 'invite');
    await vi.advanceTimersByTimeAsync(BOUNDED_CALL_WAIT_MS);
    expect(await result).toBe(false);
  });
});
