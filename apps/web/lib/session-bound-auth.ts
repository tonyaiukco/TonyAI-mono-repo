import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** The session a screen checked: who it is and the tokens that prove it. */
export interface CheckedSession {
  access_token: string;
  refresh_token: string;
  user: { id: string };
}

type BoundAuth = Pick<SupabaseClient["auth"], "updateUser" | "signOut">;

/**
 * Auth, for exactly the session the screen checked — never the browser's
 * shared one (Codex review of `pre-g5-security-hardening`, P1). The shared
 * client reads the session again inside `updateUser` and `signOut`, so a sign-in
 * in another tab between the check and the call would set this password on, or
 * sign out the sessions of, someone else.
 *
 * A client of its own, in memory: no storage, no refresh timer, no cross-tab
 * channel, and the checked tokens alone. `setSession` keeps a token it can
 * still use (the check read it moments ago) and asks Auth who it belongs to;
 * any other user, or no answer, refuses.
 */
export async function authForCheckedSession(
  session: CheckedSession,
  create: (url: string, key: string, options: Parameters<typeof createClient>[2]) => Pick<SupabaseClient, "auth"> = createClient,
): Promise<BoundAuth> {
  const client = create(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `tonyai-checked-session-${session.user.id}`,
    },
  });
  const { data, error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error || data.user?.id !== session.user.id) {
    throw new Error("The checked session could not be bound.");
  }
  return client.auth;
}
