import { endingSessionHere } from "./session-watch";
import { useAuthStore, useReportingContextStore } from "./store";
import { getSupabaseBrowserClient } from "./supabase";

/**
 * Signs this browser out and forgets who was signed in: the signed-in user and
 * their remembered reporting context (pre-pilot defects). Answers whether the
 * browser is signed out, judged by the session it still holds, not by the
 * sign-out's answer: Supabase Auth answers an upstream failure with an error
 * and keeps the session (Codex review of #350). Then the user is still signed
 * in, nothing is forgotten, and the caller says so instead of leaving.
 */
export async function signOutHere(): Promise<boolean> {
  const auth = getSupabaseBrowserClient().auth;
  endingSessionHere(true);
  await auth.signOut().catch(() => undefined);
  // An error with no session is not a sign-out: with an expired access token
  // and Auth unreachable, auth-js answers `{ session: null, error }` and keeps
  // the session, refresh token and all (`security-rls` re-review of #350).
  const signedOut = await auth.getSession().then(
    ({ data, error }) => data.session === null && !error,
    () => false,
  );
  if (signedOut) {
    useAuthStore.getState().clear();
    useReportingContextStore.getState().clear();
  } else {
    endingSessionHere(false);
  }
  return signedOut;
}
