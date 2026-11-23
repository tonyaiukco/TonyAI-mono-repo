import { api } from "./api";
import { acceptInvitationQuietly } from "./auth-view";
import { getSupabaseBrowserClient } from "./supabase";

/** How long a caller waits for the acceptance before going on; the call itself goes on. */
export const ACCEPT_WAIT_MS = 5_000;

/** The session now, read once; none when it cannot be read. */
async function currentSession(): Promise<{ userId: string; accessToken: string } | null> {
  try {
    const { data } = await getSupabaseBrowserClient().auth.getSession();
    return data.session ? { userId: data.session.user.id, accessToken: data.session.access_token } : null;
  } catch {
    return null;
  }
}

/** The session is no longer the subject's: a refusal no repeat can change. */
class SessionChangedError extends Error {
  readonly status = 401;
  constructor() {
    super("The session is no longer the one that started the acceptance.");
  }
}

/**
 * Accepts the open invitation of `userId` — the subject the initiating Auth
 * operation returned (sign-in, the email link, the password update) —
 * quietly and with repeats (`acceptInvitationQuietly`). Every attempt reads
 * the session once and sends that read's own token, and only while it is
 * still `userId`'s: another tab that signed someone else in meanwhile stops
 * it, instead of closing that person's invitation (Codex reviews of #350).
 *
 * Called by the email link, after the password is chosen, and after every
 * password sign-in. The last one is the reconciliation: an acceptance that
 * failed through every repeat, with the API down while Auth was up, closes at
 * the next sign-in instead of staying `sent`. A no-op on the server for anyone
 * with nothing open.
 *
 * Answers whether it went through, within `ACCEPT_WAIT_MS` at most: a hung
 * API never holds the page (false then, while the call goes on).
 */
export async function acceptOwnInvitation(userId: string | undefined, waitAtMost = ACCEPT_WAIT_MS): Promise<boolean> {
  if (!userId) return false;
  const accepted = acceptInvitationQuietly(async () => {
    const session = await currentSession();
    if (session?.userId !== userId) throw new SessionChangedError();
    await api.acceptInvitation(session.accessToken);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitAtMost);
  });
  try {
    return await Promise.race([accepted, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
