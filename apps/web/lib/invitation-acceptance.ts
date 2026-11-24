import { api } from "./api";
import { repeatQuietly } from "./auth-view";

/** How long a caller waits for a bounded call before going on; the call itself goes on. */
export const BOUNDED_CALL_WAIT_MS = 5_000;
/** The acceptance's wait: the same bound. */
export const ACCEPT_WAIT_MS = BOUNDED_CALL_WAIT_MS;

/**
 * Runs `call` with `accessToken` — the token of the session the initiating Auth
 * operation returned or the screen checked — quietly and with repeats
 * (`repeatQuietly`), every repeat with that same token. The browser's shared
 * session is never read again: another tab that signs someone else in
 * meanwhile can neither redirect the call to that person nor stop it (Codex
 * reviews of #350 and of `pre-g5-security-hardening`). Answers whether it went
 * through, within `waitAtMost`: a hung API never holds the page (false then,
 * while the call goes on).
 */
export async function callWithTokenQuietly(
  accessToken: string | undefined,
  call: (accessToken: string) => Promise<unknown>,
  waitAtMost = BOUNDED_CALL_WAIT_MS,
): Promise<boolean> {
  if (!accessToken) return false;
  const done = repeatQuietly(() => call(accessToken));
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
 * Accepts the open invitation of the session `accessToken` belongs to
 * (`callWithTokenQuietly`).
 *
 * Called by the email link, after the password is chosen, and after every
 * password sign-in, each with its own Auth operation's token. The last one is
 * the reconciliation: an acceptance that failed through every repeat, with the
 * API down while Auth was up, closes at the next sign-in instead of staying
 * `sent`. A no-op on the server for anyone with nothing open.
 */
export async function acceptOwnInvitation(accessToken: string | undefined, waitAtMost = ACCEPT_WAIT_MS): Promise<boolean> {
  return callWithTokenQuietly(accessToken, (token) => api.acceptInvitation(token), waitAtMost);
}
