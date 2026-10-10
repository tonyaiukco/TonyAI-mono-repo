/**
 * The decisions behind the sign-in, email-link and set-password screens
 * (LP4-01), kept out of the components so they are tested (`auth-view.spec.ts`).
 */

/**
 * The shortest password the product accepts — Supabase Auth's
 * `minimum_password_length` (decision S9: 12, no composition rules). The
 * screen checks it first so the person is told before Auth refuses.
 */
export const MIN_PASSWORD_LENGTH = 12;

export type EmailLinkType = "invite" | "recovery";

/** The catalogue key (namespace `auth`) for a failed sign-in, by Supabase's error code. */
export function signInFailureKey(code: string | undefined): "signIn.invalidCredentials" | "signIn.disabled" | "signIn.failed" {
  if (code === "invalid_credentials") return "signIn.invalidCredentials";
  // A disabled account is banned in Supabase Auth too (D19).
  if (code === "user_banned") return "signIn.disabled";
  return "signIn.failed";
}

/**
 * What an emailed link carries: `?token_hash=…&type=invite|recovery`, as the
 * API builds it (K5). Anything else is not a link this product sent.
 */
export function parseEmailLink(search: URLSearchParams): { tokenHash: string; type: EmailLinkType } | null {
  const tokenHash = search.get("token_hash");
  const type = search.get("type");
  if (!tokenHash || !/^[A-Za-z0-9_-]{16,512}$/.test(tokenHash)) return null;
  if (type !== "invite" && type !== "recovery") return null;
  return { tokenHash, type };
}

/** What is wrong with a new password before it is sent, if anything. */
export function passwordProblem(password: string, repeat: string): "tooShort" | "mismatch" | null {
  if (password.length < MIN_PASSWORD_LENGTH) return "tooShort";
  if (password !== repeat) return "mismatch";
  return null;
}

/** The catalogue key (namespace `auth`) for a password Supabase refused. */
export function setPasswordFailureKey(code: string | undefined): "setPassword.weak" | "setPassword.same" | "setPassword.failed" {
  if (code === "weak_password") return "setPassword.weak";
  if (code === "same_password") return "setPassword.same";
  return "setPassword.failed";
}

/**
 * Reachable without a session (LP4-01): sign-in, "forgot password", and the
 * landing pages of the emailed links — `/auth/confirm` runs `verifyOtp` with
 * the link's token, and `/auth/set-password` works only with the session that
 * made (it says so when there is none). Exact paths and their sub-paths.
 */
export const PUBLIC_PATHS = ["/login", "/forgot-password", "/auth/confirm", "/auth/set-password"] as const;
/** A signed-in visitor has nothing to do here and goes to the dashboard. The
 *  email-link pages are not among them: an invitee is signed in by the link. */
export const SIGNED_OUT_ONLY_PATHS = ["/login", "/forgot-password"] as const;

function matchesPath(path: string, list: readonly string[]): boolean {
  return list.some((p) => path === p || path.startsWith(`${p}/`));
}

/** `proxy.ts`: may this path be served without a session? */
export function isPublicPath(path: string): boolean {
  return matchesPath(path, PUBLIC_PATHS);
}

/** `proxy.ts`: does a signed-in visitor go to the dashboard instead? */
export function isSignedOutOnlyPath(path: string): boolean {
  return matchesPath(path, SIGNED_OUT_ONLY_PATHS);
}
