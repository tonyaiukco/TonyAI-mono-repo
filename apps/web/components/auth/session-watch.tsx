"use client";

import { watchIdleSession } from "@/lib/watch-idle-session";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { isPublicPath } from "@/lib/auth-view";
import { lastActivity, recordActivity, withSessionLock } from "@/lib/idle-session";
import { endingSessionHere, watchSession } from "@/lib/session-watch";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { useAuthStore, useReportingContextStore } from "@/lib/store";
import { OnboardingGate } from "@/components/auth/onboarding-gate";

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

    return watchIdleSession({
      tab: window, page: document, location: window.location, timers: window,
      now: Date.now, lastActivity, recordActivity, withSessionLock,
      signOut: () => getSupabaseBrowserClient().auth.signOut({ scope: "local" }),
      onExpire() {
        endingSessionHere(true);
        setReady(false);
        useAuthStore.getState().clear();
        useReportingContextStore.getState().clear();
      },
      onReady() {
        watchSession();
        setReady(true);
      },
    });
  }, [path]);

  if (isPublicPath(path)) return children;
  // A protected path: the setup wizard's gate decides once the session is
  // ready (inc26-central-reporter-onboarding, D9).
  return ready ? <OnboardingGate path={path}>{children}</OnboardingGate> : null;
}
