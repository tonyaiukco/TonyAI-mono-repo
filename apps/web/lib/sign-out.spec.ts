import { beforeEach, describe, expect, it, vi } from 'vitest';

const signOut = vi.fn();
vi.mock('./supabase', () => ({ getSupabaseBrowserClient: () => ({ auth: { signOut: () => signOut() } }) }));

import { signOutHere } from './sign-out';
import { useAuthStore, useReportingContextStore } from './store';

describe('signOutHere (pre-pilot defects)', () => {
  beforeEach(() => {
    signOut.mockReset();
    useAuthStore.getState().setUser({ id: 'user-a', role: 'super_admin' } as never);
    useReportingContextStore.getState().remember('user-a', { year: 2026 } as never);
  });

  it('signs out and forgets the user and their reporting context', async () => {
    signOut.mockResolvedValue({ error: null });
    await signOutHere();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useReportingContextStore.getState().remembered).toBeNull();
  });

  it('forgets them even when the sign-out request fails', async () => {
    signOut.mockRejectedValue(new Error('offline'));
    await expect(signOutHere()).rejects.toThrow('offline');
    expect(useAuthStore.getState().user).toBeNull();
    expect(useReportingContextStore.getState().remembered).toBeNull();
  });
});
