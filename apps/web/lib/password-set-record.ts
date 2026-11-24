import { api } from "./api";
import { BOUNDED_CALL_WAIT_MS, callAsSubjectQuietly } from "./invitation-acceptance";
import type { PasswordSetFlow } from "./types";

/**
 * Tells the API that Auth accepted a new password for `userId` from an email
 * link, so the account's audit trail shows it (`password_set`;
 * `account-access`). Bound to that user and to the token of the session read
 * that checked them, like the invitation acceptance: another tab's sign-in
 * stops it instead of writing the row as someone else. The password is set
 * whatever this answers, so it never throws and never holds the page longer
 * than `BOUNDED_CALL_WAIT_MS`. Answers whether it was recorded.
 */
export async function recordPasswordSet(
  userId: string | undefined,
  flow: PasswordSetFlow,
  waitAtMost = BOUNDED_CALL_WAIT_MS,
): Promise<boolean> {
  return callAsSubjectQuietly(userId, (accessToken) => api.recordPasswordSet(flow, accessToken), waitAtMost);
}
