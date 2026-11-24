import { isPublicPath } from "./auth-view";

export const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
export const ACTIVITY_KEY = "tonyai-last-activity";

/** Missing, corrupt and future timestamps cannot establish recent activity. */
export function idleTimeRemaining(value: string | null, now: number): number {
  const at = Number(value);
  if (!value || !Number.isSafeInteger(at) || at <= 0 || at > now) return 0;
  return Math.max(0, IDLE_TIMEOUT_MS - (now - at));
}

export function shouldExpire(path: string, value: string | null, now: number): boolean {
  return !isPublicPath(path) && idleTimeRemaining(value, now) === 0;
}

export function lastActivity(): string | null {
  try {
    return window.localStorage.getItem(ACTIVITY_KEY);
  } catch {
    return null;
  }
}

export function recordActivity(at = Date.now()): void {
  try {
    window.localStorage.setItem(ACTIVITY_KEY, String(at));
  } catch {
    // A protected page needs a readable, shared timestamp to open.
  }
}
