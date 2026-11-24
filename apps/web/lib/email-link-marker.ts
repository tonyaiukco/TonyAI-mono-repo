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
  flow: EmailLinkFlow;
  /** When the link was verified, in epoch milliseconds. */
  at: number;
}

export const EMAIL_LINK_MARKER_KEY = "tonyai.emailLink";
/** An email link's one-time token expires in an hour (`otp_expiry`); so does its marker. */
export const EMAIL_LINK_MARKER_TTL_MS = 60 * 60 * 1000;

type MarkerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The tab's storage, or none where it cannot be reached. */
export function tabStorage(): MarkerStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function writeEmailLinkMarker(storage: MarkerStorage | null, userId: string, flow: EmailLinkFlow, now = Date.now()): void {
  try {
    storage?.setItem(EMAIL_LINK_MARKER_KEY, JSON.stringify({ userId, flow, at: now }));
  } catch {
    // No marker: the set-password screen then asks for the link again.
  }
}

/** The marker for `userId`, when it is this user's and under an hour old; otherwise null. */
export function readEmailLinkMarker(storage: MarkerStorage | null, userId: string | undefined, now = Date.now()): EmailLinkMarker | null {
  if (!storage || !userId) return null;
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
  if (marker.userId !== userId) return null;
  if (!isPasswordSetFlow(marker.flow)) return null;
  if (typeof marker.at !== "number" || !Number.isFinite(marker.at)) return null;
  const age = now - marker.at;
  if (age < 0 || age >= EMAIL_LINK_MARKER_TTL_MS) return null;
  return { userId, flow: marker.flow, at: marker.at };
}

export function clearEmailLinkMarker(storage: MarkerStorage | null): void {
  try {
    storage?.removeItem(EMAIL_LINK_MARKER_KEY);
  } catch {
    // Nothing to do: an unreadable marker reads as none.
  }
}
