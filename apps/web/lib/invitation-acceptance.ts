import { api } from "./api";
import { repeatQuietly } from "./auth-view";
import { getSupabaseBrowserClient } from "./supabase";

/** How long a caller waits for a bounded call before going on; the call itself goes on. */
export const BOUNDED_CALL_WAIT_MS = 5_000;
/** The acceptance's wait: the same bound. */
export const ACCEPT_WAIT_MS = BOUNDED_CALL_WAIT_MS;

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
    super("The session is no longer the one that started the call.");
  }
}

/**
 * Runs `call` for `userId` — the subject the initiating Auth operation
 * returned — quietly and with repeats (`repeatQuietly`). Every attempt reads
 * the session once and hands `call` that read's own token, and only while the
 * session is still `userId`'s: another tab that signed someone else in
 * meanwhile stops it, instead of acting as that person (Codex reviews of
 * #350). Answers whether it went through, within `waitAtMost`: a hung API
 * never holds the page (false then, while the call goes on).
 */
export async function callAsSubjectQuietly(
  userId: string | undefined,
  call: (accessToken: string) => Promise<unknown>,
  waitAtMost = BOUNDED_CALL_WAIT_MS,
): Promise<boolean> {
  if (!userId) return false;
  const done = repeatQuietly(async () => {
    const session = await currentSession();
    if (session?.userId !== userId) throw new SessionChangedError();
    await call(session.accessToken);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitAtMost);
  });
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Accepts the open invitation of `userId` (`callAsSubjectQuietly`).
 *
 * Called by the email link, after the password is chosen, and after every
 * password sign-in. The last one is the reconciliation: an acceptance that
 * failed through every repeat, with the API down while Auth was up, closes at
 * the next sign-in instead of staying `sent`. A no-op on the server for anyone
 * with nothing open.
 */
export async function acceptOwnInvitation(userId: string | undefined, waitAtMost = ACCEPT_WAIT_MS): Promise<boolean> {
  return callAsSubjectQuietly(userId, (accessToken) => api.acceptInvitation(accessToken), waitAtMost);
}
