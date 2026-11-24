"use client";

import { isChunkLike } from "@supabase/ssr";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { isPublicPath } from "@/lib/auth-view";
import { ACTIVITY_KEY, idleTimeRemaining, lastActivity, recordActivity, shouldExpire, withSessionLock } from "@/lib/idle-session";
import { endingSessionHere, watchSession } from "@/lib/session-watch";
import { AUTH_STORAGE_KEY, getSupabaseBrowserClient } from "@/lib/supabase";
import { useAuthStore, useReportingContextStore } from "@/lib/store";

export function SessionWatch({ children }: { children: ReactNode }) {
  const path = usePathname();
  return <SessionGate key={isPublicPath(path) ? "public" : "protected"} path={path}>{children}</SessionGate>;
}

function SessionGate({ path, children }: { path: string; children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isPublicPath(path)) {
      watchSession();
      return;
    }

    let timer: number;
    let trailing: number | undefined;
    let pending = 0;
    let ending = false;

    async function expire() {
      ending = true;
      endingSessionHere(true);
      setReady(false);
      useAuthStore.getState().clear();
      useReportingContextStore.getState().clear();
      await withSessionLock(async () => {
        // A password or email-link exchange may have finished while we waited.
        if (!shouldExpire(location.pathname, lastActivity(), Date.now())) {
          window.location.reload();
          return;
        }
        try {
          await getSupabaseBrowserClient().auth.signOut({ scope: "local" });
        } catch {
          // The browser must still forget the session if Auth is unreachable.
        }
        for (const part of document.cookie.split(";")) {
          const name = part.trim().split("=")[0];
          if (isChunkLike(name, AUTH_STORAGE_KEY)) {
            document.cookie = name + "=; Path=/; Max-Age=0; SameSite=Lax";
          }
        }
        window.location.replace("/login?reason=idle");
      });
    }

    function check() {
      if (ending || isPublicPath(location.pathname)) return false;
      window.clearTimeout(timer);
      const remaining = idleTimeRemaining(lastActivity(), Date.now());
      if (!remaining) {
        void expire();
        return false;
      }
      timer = window.setTimeout(check, remaining);
      return true;
    }

    // Coalesce bursts but persist their final event's original time, including
    // when the tab leaves before the trailing write.
    function flush() {
      window.clearTimeout(trailing);
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
      const now = Date.now();
      if (now - Number(lastActivity()) >= 500) {
        recordActivity(now);
      } else {
        pending = now;
        if (trailing === undefined) trailing = window.setTimeout(flush, 500);
      }
    }

    function storage(event: StorageEvent) {
      if (event.key === ACTIVITY_KEY || event.key === null) check();
    }

    if (!check()) return;
    watchSession();
    setReady(true);
    const events = ["pointerdown", "keydown", "wheel", "scroll", "touchstart"];
    for (const event of events) window.addEventListener(event, activity, { capture: true, passive: false });
    window.addEventListener("storage", storage);
    window.addEventListener("pageshow", check);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", check);
    return () => {
      flush();
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, activity, true);
      window.removeEventListener("storage", storage);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", check);
    };
  }, [path]);

  return isPublicPath(path) || ready ? children : null;
}
