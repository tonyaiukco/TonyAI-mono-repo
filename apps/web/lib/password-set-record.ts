import { api } from "./api";
import { BOUNDED_CALL_WAIT_MS, callWithTokenQuietly } from "./invitation-acceptance";
import type { PasswordSetFlow } from "./types";

/**
 * Tells the API that Auth accepted a new password from an email link, so the
 * account's audit trail shows it (`password_set`; `account-access`). With the
 * token of the very session the password was changed through, on every repeat:
 * a sign-in in another tab can neither move the row to someone else nor lose
 * it. The password is set whatever this answers, so it never throws and never
 * holds the page longer than `BOUNDED_CALL_WAIT_MS`. Answers whether it was
 * recorded.
 */
export async function recordPasswordSet(
  accessToken: string | undefined,
  flow: PasswordSetFlow,
  waitAtMost = BOUNDED_CALL_WAIT_MS,
): Promise<boolean> {
  // One id for this change, the same on every repeat: the API records it once.
  const changeId = crypto.randomUUID();
  return callWithTokenQuietly(accessToken, (token) => api.recordPasswordSet(flow, changeId, token), waitAtMost);
}
