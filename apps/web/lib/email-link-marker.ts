import { isPasswordSetFlow } from "./auth-view";
import type { PasswordSetFlow } from "./types";

/**
 * The set-password screen serves only a session that an email link opened in
 * this tab, recently (`account-access`; `pre-g5-security-hardening`). The
 * email-link page writes this marker after Auth verified the link; the
 * set-password page reads it. `sessionStorage` is per tab and per origin, so a
 * session used in another tab or browser has none. Nothing here throws: a
 * storage that refuses, or a value that is not ours, reads as no marker.
 */

/** The flow an emailed link carries: the shared contract's (`PasswordSetFlow`), one type everywhere. */
export type EmailLinkFlow = PasswordSetFlow;

export interface EmailLinkMarker {
  userId: string;
  /** The Auth session the link opened (`session_id` in its token): another
   *  sign-in by the same person, in the same tab, is a new session and finds
   *  no marker (Codex review). */
  sessionId: string;
  flow: EmailLinkFlow;
  /** When the link was verified, in epoch milliseconds. */
  at: number;
}

export const EMAIL_LINK_MARKER_KEY = "tonyai.emailLink";
/** An email link's one-time token expires in an hour (`otp_expiry`); so does its marker. */
export const EMAIL_LINK_MARKER_TTL_MS = 60 * 60 * 1000;

type MarkerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** An Auth access token's `session_id` claim, or null when it has none or cannot be read. */
export function sessionIdOf(accessToken: string | undefined): string | null {
  try {
    const payload = accessToken?.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    const claim = (JSON.parse(json) as { session_id?: unknown }).session_id;
    return typeof claim === "string" && claim.length > 0 ? claim : null;
  } catch {
    return null;
  }
}

/** The tab's storage, or none where it cannot be reached. */
export function tabStorage(): MarkerStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function writeEmailLinkMarker(
  storage: MarkerStorage | null,
  userId: string,
  sessionId: string | null,
  flow: EmailLinkFlow,
  now = Date.now(),
): void {
  if (!sessionId) return;
  try {
    storage?.setItem(EMAIL_LINK_MARKER_KEY, JSON.stringify({ userId, sessionId, flow, at: now }));
  } catch {
    // No marker: the set-password screen then asks for the link again.
  }
}

/** The marker for this user's very session, when it is under an hour old; otherwise null. */
export function readEmailLinkMarker(
  storage: MarkerStorage | null,
  userId: string | undefined,
  sessionId: string | null,
  now = Date.now(),
): EmailLinkMarker | null {
  if (!storage || !userId || !sessionId) return null;
  let value: unknown;
  try {
    const raw = storage.getItem(EMAIL_LINK_MARKER_KEY);
    if (raw === null) return null;
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const marker = value as Partial<EmailLinkMarker>;
  if (marker.userId !== userId || marker.sessionId !== sessionId) return null;
  if (!isPasswordSetFlow(marker.flow)) return null;
  if (typeof marker.at !== "number" || !Number.isFinite(marker.at)) return null;
  const age = now - marker.at;
  if (age < 0 || age >= EMAIL_LINK_MARKER_TTL_MS) return null;
  return { userId, sessionId, flow: marker.flow, at: marker.at };
}

export function clearEmailLinkMarker(storage: MarkerStorage | null): void {
  try {
    storage?.removeItem(EMAIL_LINK_MARKER_KEY);
  } catch {
    // Nothing to do: an unreadable marker reads as none.
  }
}
