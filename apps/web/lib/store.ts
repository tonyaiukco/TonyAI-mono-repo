import { create } from "zustand";
import type { AuthUser, ReportingContext } from "@tonyai/shared-types";

interface AuthState {
  user: AuthUser | null;
  loaded: boolean;
  setUser: (user: AuthUser | null) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loaded: false,
  setUser: (user) => set({ user, loaded: true }),
  clear: () => set({ user: null, loaded: true }),
}));

interface ReportingContextState {
  /** The last reporting context a signed-in user resolved (LP3-02 N1). In
   * memory only: a reload is the URL's job, and nothing outlives the tab. Kept
   * per user, and cleared at every sign-in, so one person's selection never
   * narrows the next person's screens in the same tab. */
  remembered: { userId: string; context: ReportingContext } | null;
  remember: (userId: string, context: ReportingContext) => void;
  clear: () => void;
}

export const useReportingContextStore = create<ReportingContextState>((set) => ({
  remembered: null,
  remember: (userId, context) => set({ remembered: { userId, context } }),
  clear: () => set({ remembered: null }),
}));

/** A Supabase auth event in this tab — including another tab's sign-in or
 * sign-out on the shared session — drops a remembered selection that belongs
 * to anyone but the session's user (`security-rls` P3-3). */
export function forgetOnSessionChange(event: string, sessionUserId: string | undefined): void {
  const { remembered, clear } = useReportingContextStore.getState();
  if (remembered && (event === "SIGNED_OUT" || sessionUserId !== remembered.userId)) clear();
}

/** The remembered context, only for the user it belongs to. */
export function rememberedContextFor(
  remembered: ReportingContextState["remembered"],
  userId: string | undefined,
): ReportingContext | null {
  return remembered && userId !== undefined && remembered.userId === userId ? remembered.context : null;
}
