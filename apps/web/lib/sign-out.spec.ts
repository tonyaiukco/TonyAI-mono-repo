import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn();
const getSession = vi.fn();
vi.mock('./supabase', () => ({
  getSupabaseBrowserClient: () => ({ auth: { signOut: () => signOut(), getSession: () => getSession() } }),
}));

import { signOutHere } from './sign-out';
import * as watch from './session-watch';
import { sessionChangeAction } from './session-watch';
import { useAuthStore, useReportingContextStore } from './store';

const session = (id: string) => ({ data: { session: { user: { id } } } });
const noSession = { data: { session: null }, error: null };

describe('signOutHere (pre-pilot defects; Codex review of #350)', () => {
  beforeEach(() => {
    signOut.mockReset();
    getSession.mockReset();
    useAuthStore.getState().setUser({ id: 'user-a', role: 'super_admin' } as never);
    useReportingContextStore.getState().remember('user-a', { year: 2026 } as never);
  });

  const forgotten = () => useAuthStore.getState().user === null && useReportingContextStore.getState().remembered === null;
  const kept = () => useAuthStore.getState().user?.id === 'user-a' && useReportingContextStore.getState().remembered !== null;

  it('signs out and forgets the user and their reporting context', async () => {
    signOut.mockResolvedValue({ error: null });
    getSession.mockResolvedValue(noSession);
    expect(await signOutHere()).toBe(true);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(forgotten()).toBe(true);
  });

  it('answers false and forgets nothing when Auth answered an error and kept the session', async () => {
    // auth-js 2.108.2 resolves `{ error }` on an upstream failure, before removing the session.
    signOut.mockResolvedValue({ error: { status: 502, message: 'bad gateway' } });
    getSession.mockResolvedValue(session('user-a'));
    const flag = vi.spyOn(watch, 'endingSessionHere');
    expect(await signOutHere()).toBe(false);
    expect(kept()).toBe(true);
    // Called off again: the tab still follows other tabs' sign-outs.
    expect(flag.mock.calls).toEqual([[true], [false]]);
    flag.mockRestore();
  });

  it('answers false when the sign-out throws and the session is still there', async () => {
    signOut.mockRejectedValue(new Error('offline'));
    getSession.mockResolvedValue(session('user-a'));
    expect(await signOutHere()).toBe(false);
    expect(kept()).toBe(true);
  });

  it('answers true when the sign-out threw but the session is gone', async () => {
    signOut.mockRejectedValue(new Error('lock'));
    getSession.mockResolvedValue(noSession);
    expect(await signOutHere()).toBe(true);
    expect(forgotten()).toBe(true);
  });

  it('answers false when the session read fails with no session: an expired token whose refresh could not reach Auth', async () => {
    // auth-js 2.108.2 resolves this (it does not reject) and keeps the session in storage.
    signOut.mockResolvedValue({ error: { name: 'AuthRetryableFetchError', status: 0 } });
    getSession.mockResolvedValue({ data: { session: null }, error: { name: 'AuthRetryableFetchError', status: 0 } });
    expect(await signOutHere()).toBe(false);
    expect(kept()).toBe(true);
  });

  it('answers false when the session cannot be read', async () => {
    signOut.mockResolvedValue({ error: null });
    getSession.mockRejectedValue(new Error('storage'));
    expect(await signOutHere()).toBe(false);
    expect(kept()).toBe(true);
  });
});

describe('sessionChangeAction (Codex review of #350)', () => {
  it('sends a page whose user signed out elsewhere to sign-in', () => {
    expect(sessionChangeAction('SIGNED_OUT', undefined, 'user-a', '/users', false)).toBe('signIn');
    expect(sessionChangeAction('INITIAL_SESSION', undefined, 'user-a', '/users', false)).toBe('signIn');
  });

  it('reloads a page whose session is now another user\'s', () => {
    expect(sessionChangeAction('SIGNED_IN', 'user-b', 'user-a', '/users', false)).toBe('reload');
    expect(sessionChangeAction('TOKEN_REFRESHED', 'user-b', 'user-a', '/', false)).toBe('reload');
  });

  it('leaves the page alone for its own user\'s refreshes and sign-ins', () => {
    for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED', 'INITIAL_SESSION']) {
      expect(sessionChangeAction(event, 'user-a', 'user-a', '/users', false), event).toBe('none');
    }
  });

  it('does nothing when no user was loaded, on a public page, or when this tab is ending its own session', () => {
    expect(sessionChangeAction('SIGNED_IN', 'user-b', undefined, '/users', false)).toBe('none');
    for (const path of ['/login', '/register', '/forgot-password', '/auth/confirm', '/auth/set-password']) {
      expect(sessionChangeAction('SIGNED_IN', 'user-b', 'user-a', path, false), path).toBe('none');
      expect(sessionChangeAction('SIGNED_OUT', undefined, 'user-a', path, false), path).toBe('none');
    }
    expect(sessionChangeAction('SIGNED_OUT', undefined, 'user-a', '/users', true)).toBe('none');
  });
});

describe('the session wiring', () => {
  const read = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');

  it('the root layout mounts the session watch, so a page that never reads the reporting context is covered', () => {
    expect(read('app/layout.tsx')).toMatch(/<SessionWatch \/>/);
    expect(read('components/auth/session-watch.tsx')).toMatch(/watchSession\(\)/);
  });

  it.each(['app/page.tsx', 'app/emissions/page.tsx', 'app/data-entry/page.tsx', 'app/subsidiaries/page.tsx', 'app/audit/page.tsx',
    'app/review/page.tsx', 'app/users/page.tsx', 'app/inventory-boundary/page.tsx', 'app/reports/page.tsx'])(
    '%s signs out through useSignOut, never the SDK directly',
    (file) => {
      const source = read(file);
      expect(source).toMatch(/useSignOut\(\)/);
      expect(source).not.toMatch(/auth\.signOut\(/);
    },
  );

  it.each(['app/auth/confirm/confirm-email-link.tsx', 'app/auth/set-password/set-password-form.tsx', 'app/login/page.tsx'])(
    '%s accepts the invitation through acceptOwnInvitation',
    (file) => {
      // With the subject the Auth operation returned, never a later session read.
      expect(read(file)).toMatch(/await acceptOwnInvitation\(data\.user\?\.id\);/);
    },
  );

  it('a recovery asks Auth to end the other sessions before the acceptance, and says when it could not', () => {
    const source = read('app/auth/set-password/set-password-form.tsx');
    expect(source.indexOf('signOut({ scope: "others" })')).toBeGreaterThan(-1);
    expect(source.indexOf('signOut({ scope: "others" })')).toBeLessThan(source.indexOf('await acceptOwnInvitation('));
    expect(source).toMatch(/if \(othersError\) toast\.warning\(t\("setPassword\.othersNotSignedOut"\)\)/);
  });

  it('the API client marks its own session end before signing out', () => {
    const source = read('lib/api.ts');
    expect(source.indexOf('endingSessionHere(true)')).toBeGreaterThan(-1);
    expect(source.indexOf('endingSessionHere(true)')).toBeLessThan(source.indexOf('.auth.signOut({ scope: "local" })'));
  });
});
