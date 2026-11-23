import { isPublicPath } from "./auth-view";
import { forgetOnSessionChange, useAuthStore } from "./store";
import { getSupabaseBrowserClient } from "./supabase";

/** What a tab does when the session changes under it. */
export type SessionChangeAction = "none" | "reload" | "signIn";

/**
 * A page that loaded a user — known from the session this tab last saw, or
 * from the store's profile — holds that user's data in its own state and may
 * have requests in flight under their credentials. When the session ends — a
 * sign-out in another tab, a refresh token Auth revoked — or becomes someone
 * else's, clearing the stores is not enough
 * (Codex review of #350): the page leaves, with a full navigation, so nothing
 * of the previous user's survives in memory. A session that ended is sent to
 * sign-in; one now held by another user reloads the page as that user.
 *
 * The session's own user counts, not only the profile `/me` put in the store:
 * a page whose `/me` has not answered yet already holds rows read with that
 * session's token (Codex re-review of #350).
 *
 * Nothing happens on a public page (sign-in, registration, the email-link
 * pages: signing someone in there is the point), when no user was known, or
 * when this tab is ending its own session (`endingSessionHere`), whose caller
 * navigates itself.
 */
export function sessionChangeAction(
  event: string,
  sessionUserId: string | undefined,
  loadedUserId: string | undefined,
  pathname: string,
  endingHere: boolean,
): SessionChangeAction {
  if (loadedUserId === undefined || endingHere || isPublicPath(pathname)) return "none";
  if (event === "SIGNED_OUT" || sessionUserId === undefined) return "signIn";
  return sessionUserId === loadedUserId ? "none" : "reload";
}

let endingHere = false;

/** This tab is ending its own session (Sign out, or a disabled account): the
 *  watcher only forgets, and the caller decides where the tab goes. */
export function endingSessionHere(ending: boolean): void {
  endingHere = ending;
}

let watching = false;
/** The user of the session this tab last saw, from its first event on. */
let seenUserId: string | undefined;

/**
 * Subscribes once per tab, from the root layout, so every page is covered:
 * the auth events include another tab's sign-in and sign-out on the shared
 * session. The stores forget whoever is no longer signed in
 * (`forgetOnSessionChange`), then the page acts on `sessionChangeAction`.
 */
export function watchSession(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  getSupabaseBrowserClient().auth.onAuthStateChange((event, session) => {
    const sessionUserId = session?.user.id;
    const loadedUserId = seenUserId ?? useAuthStore.getState().user?.id;
    seenUserId = sessionUserId;
    forgetOnSessionChange(event, sessionUserId);
    const action = sessionChangeAction(event, sessionUserId, loadedUserId, window.location.pathname, endingHere);
    if (action === "signIn") window.location.assign("/login");
    else if (action === "reload") window.location.reload();
  });
}
