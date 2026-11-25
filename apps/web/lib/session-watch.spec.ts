import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: string, session: { user: { id: string } } | null) => void;
let listener: Listener | undefined;
const subscribe = vi.fn((cb: Listener) => {
  listener = cb;
});
vi.mock('./supabase', () => ({ getSupabaseBrowserClient: () => ({ auth: { onAuthStateChange: subscribe } }) }));

const location = { pathname: '/users', assign: vi.fn(), reload: vi.fn() };
const getActivity = vi.fn(() => String(Date.now()));
vi.stubGlobal('window', { location, localStorage: { getItem: getActivity } });

import { endingSessionHere, watchSession } from './session-watch';
import { useAuthStore, useReportingContextStore } from './store';

afterAll(() => vi.unstubAllGlobals());

/** The watcher's glue: what reaches the stores and the page (`qa-auditor` re-review of #350). */
describe('watchSession', () => {
  beforeEach(() => {
    location.pathname = '/users';
    location.assign.mockReset();
    location.reload.mockReset();
    endingSessionHere(false);
    useAuthStore.getState().setUser({ id: 'user-a', role: 'super_admin' } as never);
    useReportingContextStore.getState().remember('user-a', { year: 2026 } as never);
    watchSession();
    // Every test starts from a tab that has seen user A's session.
    listener!('INITIAL_SESSION', { user: { id: 'user-a' } });
    location.assign.mockReset();
    location.reload.mockReset();
  });

  it('explains a session end after an hour of inactivity', () => {
    getActivity.mockReturnValueOnce(String(Date.now() - 3_600_000));
    listener!('SIGNED_OUT', null);
    expect(location.assign).toHaveBeenCalledWith('/login?reason=idle');
  });

  it('subscribes once per tab', () => {
    watchSession();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('forgets the user and sends the page to sign-in when the session ends elsewhere', () => {
    listener!('SIGNED_OUT', null);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useReportingContextStore.getState().remembered).toBeNull();
    expect(location.assign).toHaveBeenCalledWith('/login');
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('reloads the page when the session is now another user\'s', () => {
    listener!('SIGNED_IN', { user: { id: 'user-b' } });
    expect(useAuthStore.getState().user).toBeNull();
    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(location.assign).not.toHaveBeenCalled();
  });

  it('leaves the page alone on its own user\'s refresh', () => {
    listener!('TOKEN_REFRESHED', { user: { id: 'user-a' } });
    expect(useAuthStore.getState().user?.id).toBe('user-a');
    expect(location.assign).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('follows the session on a page whose /me has not answered yet (Codex re-review of #350)', () => {
    useAuthStore.getState().clear();
    listener!('SIGNED_OUT', null);
    expect(location.assign).toHaveBeenCalledWith('/login');

    listener!('SIGNED_IN', { user: { id: 'user-a' } });
    location.pathname = '/users';
    listener!('SIGNED_IN', { user: { id: 'user-b' } });
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('only forgets while this tab ends its own session, and acts again once that is called off', () => {
    endingSessionHere(true);
    listener!('SIGNED_OUT', null);
    expect(useAuthStore.getState().user).toBeNull();
    expect(location.assign).not.toHaveBeenCalled();

    endingSessionHere(false);
    listener!('SIGNED_IN', { user: { id: 'user-a' } });
    listener!('SIGNED_OUT', null);
    expect(location.assign).toHaveBeenCalledWith('/login');
  });
});
