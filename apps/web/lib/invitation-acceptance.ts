import { api } from "./api";
import { acceptInvitationQuietly } from "./auth-view";
import { getSupabaseBrowserClient } from "./supabase";

/** The signed-in user's id as the session holds it now; none when it cannot be read. */
async function sessionUserId(): Promise<string | undefined> {
  try {
    return (await getSupabaseBrowserClient().auth.getSession()).data.session?.user.id;
  } catch {
    return undefined;
  }
}

/**
 * Accepts the signed-in person's open invitation, quietly and with repeats
 * (`acceptInvitationQuietly`), for the person signed in when it starts: a
 * repeat after the session changed hands stops instead of accepting someone
 * else's invitation. Answers whether the acceptance went through.
 *
 * Called by the email link, after the password is chosen, and after every
 * password sign-in. The last one is the reconciliation: an acceptance that
 * failed through every repeat, with the API down while Auth was up, closes
 * at the next sign-in instead of staying `sent` (Codex review of #350). A
 * no-op on the server for anyone with nothing open.
 */
export async function acceptOwnInvitation(): Promise<boolean> {
  const startedAs = await sessionUserId();
  if (startedAs === undefined) return false;
  return acceptInvitationQuietly(() => api.acceptInvitation(), {
    stillSame: async () => (await sessionUserId()) === startedAs,
  });
}
