import { isChunkLike } from "@supabase/ssr";
import { isPublicPath } from "./auth-view";
import { ACTIVITY_KEY, idleTimeRemaining, shouldExpire } from "./idle-session";
import { AUTH_STORAGE_KEY } from "./supabase";

interface IdleEnvironment {
  tab: EventTarget;
  page: EventTarget & Pick<Document, "cookie">;
  location: Pick<Location, "pathname" | "reload" | "replace">;
  timers: {
    setTimeout(callback: () => void, delay: number): number;
    clearTimeout(id?: number): void;
  };
  now: () => number;
  lastActivity: () => string | null;
  recordActivity: (at: number) => void;
  withSessionLock: (operation: () => Promise<void>) => Promise<void>;
  signOut: () => Promise<unknown>;
  onExpire: () => void;
  onReady: () => void;
}

/** Mount protected content only after the first check. Re-read the shared clock
 * on input, resume, storage notifications, and after acquiring the session lock. */
export function watchIdleSession({
  tab, page, location, timers, now, lastActivity, recordActivity, withSessionLock, signOut, onExpire, onReady,
}: IdleEnvironment) {
  let timer: number;
  let trailing: number | undefined;
  let pending = 0;
  let ending = false;

  async function expire() {
    ending = true;
    onExpire();
    await withSessionLock(async () => {
      // A password or email-link exchange may have finished while we waited.
      if (!shouldExpire(location.pathname, lastActivity(), now())) {
        location.reload();
        return;
      }
      try {
        await signOut();
      } catch {
        // The browser must still forget the session if Auth is unreachable.
      }
      for (const part of page.cookie.split(";")) {
        const name = part.trim().split("=")[0];
        if (isChunkLike(name, AUTH_STORAGE_KEY)) {
          page.cookie = name + "=; Path=/; Max-Age=0; SameSite=Lax";
        }
      }
      location.replace("/login?reason=idle");
    });
  }

  function check() {
    if (ending || isPublicPath(location.pathname)) return false;
    timers.clearTimeout(timer);
    const remaining = idleTimeRemaining(lastActivity(), now());
    if (!remaining) {
      void expire();
      return false;
    }
    timer = timers.setTimeout(check, remaining);
    return true;
  }

  // Coalesce bursts but persist their final event's original time, including
  // when the tab leaves before the trailing write.
  function flush() {
    timers.clearTimeout(trailing);
    trailing = undefined;
    if (pending && check() && pending > Number(lastActivity())) recordActivity(pending);
    pending = 0;
  }

  function activity(event: Event) {
    if (!event.isTrusted) return;
    if (!check()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const at = now();
    if (at - Number(lastActivity()) >= 500) {
      recordActivity(at);
    } else {
      pending = at;
      if (trailing === undefined) trailing = timers.setTimeout(flush, 500);
    }
  }

  function storage(event: Event) {
    const { key } = event as StorageEvent;
    if (key === ACTIVITY_KEY || key === null) check();
  }

  if (!check()) return;
  onReady();
  const events = ["pointerdown", "keydown", "wheel", "scroll", "touchstart"];
  for (const event of events) tab.addEventListener(event, activity, { capture: true, passive: false });
  tab.addEventListener("storage", storage);
  tab.addEventListener("pageshow", check);
  tab.addEventListener("pagehide", flush);
  page.addEventListener("visibilitychange", check);
  return () => {
    flush();
    timers.clearTimeout(timer);
    for (const event of events) tab.removeEventListener(event, activity, true);
    tab.removeEventListener("storage", storage);
    tab.removeEventListener("pageshow", check);
    tab.removeEventListener("pagehide", flush);
    page.removeEventListener("visibilitychange", check);
  };
}
