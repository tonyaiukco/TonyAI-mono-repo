import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const acceptInvitation = vi.fn();
vi.mock('./supabase', () => ({ getSupabaseBrowserClient: () => ({ auth: { getSession: () => getSession() } }) }));
vi.mock('./api', () => ({ api: { acceptInvitation: () => acceptInvitation() } }));

import { acceptOwnInvitation } from './invitation-acceptance';

const as = (id: string | null) => ({ data: { session: id === null ? null : { user: { id } } } });
const unavailable = () => Object.assign(new Error('unavailable'), { status: 503 });

describe('acceptOwnInvitation (Codex review of #350)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSession.mockReset();
    acceptInvitation.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const run = async () => {
    const result = acceptOwnInvitation();
    await vi.runAllTimersAsync();
    return result;
  };

  it('accepts for the signed-in user', async () => {
    getSession.mockResolvedValue(as('user-a'));
    acceptInvitation.mockResolvedValue(undefined);
    expect(await run()).toBe(true);
    expect(acceptInvitation).toHaveBeenCalledTimes(1);
  });

  it('calls nothing without a session', async () => {
    getSession.mockResolvedValue(as(null));
    expect(await run()).toBe(false);
    expect(acceptInvitation).not.toHaveBeenCalled();
  });

  it('repeats while the same user is signed in', async () => {
    getSession.mockResolvedValue(as('user-a'));
    acceptInvitation.mockRejectedValueOnce(unavailable()).mockResolvedValue(undefined);
    expect(await run()).toBe(true);
    expect(acceptInvitation).toHaveBeenCalledTimes(2);
  });

  it('stops instead of repeating for someone another tab signed in meanwhile', async () => {
    getSession.mockResolvedValueOnce(as('user-a')).mockResolvedValue(as('user-b'));
    acceptInvitation.mockRejectedValue(unavailable());
    expect(await run()).toBe(false);
    expect(acceptInvitation).toHaveBeenCalledTimes(1);
  });

  it('stops when the session is gone or cannot be read', async () => {
    getSession.mockResolvedValueOnce(as('user-a')).mockRejectedValue(new Error('storage'));
    acceptInvitation.mockRejectedValue(unavailable());
    expect(await run()).toBe(false);
    expect(acceptInvitation).toHaveBeenCalledTimes(1);
  });
});
