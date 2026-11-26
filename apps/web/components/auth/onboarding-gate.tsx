import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "use-intl";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { onboardingRedirect } from "@/lib/onboarding-view";
import { useAuthStore } from "@/lib/store";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { useSignOut } from "@/lib/use-sign-out";
import type { AuthUser } from "@/lib/types";

/**
 * The setup wizard's gate (inc26-central-reporter-onboarding, D9), inside the
 * session gate on every protected path. It reads `GET /me` itself, so it never
 * waits for a page that is waiting for it, and decides from the account the
 * store holds when there is one (a page's read, or Finish's answer, which the
 * wizard writes before it navigates), else from its own read. A masterkey of
 * an unfinished organisation is replaced to `/onboarding` from any other path;
 * anyone else away from `/onboarding`. Nothing of the tool renders before the
 * answer. It reads again when the session's account changes (the store is
 * cleared then), and a failed read is tried again on the next Auth event,
 * then offered as "Try again" and "Sign out".
 *
 * It keeps its own read rather than writing the store: the pages fill the
 * store as before, so the profile's language is applied at the moment it
 * always was (`LocaleSync`).
 */
export function OnboardingGate({ path, children }: { path: string; children: ReactNode }) {
  const t = useTranslations("onboarding");
  const router = useRouter();
  const signOut = useSignOut();
  const stored = useAuthStore((s) => s.user);
  const [read, setRead] = useState<AuthUser | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const hadStored = useRef(false);

  // The store cleared after holding an account: the session changed — read again.
  useEffect(() => {
    if (stored) hadStored.current = true;
    else if (hadStored.current) {
      hadStored.current = false;
      setRead(null);
    }
  }, [stored]);

  const user = stored ?? read;
  useEffect(() => {
    if (user) return;
    let live = true;
    setFailed(false);
    api.me().then(
      (me) => {
        if (live) setRead(me);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [user, attempt]);

  // A read that failed while Auth was settling is tried again on its next event.
  useEffect(() => {
    if (!failed) return;
    const { data } = getSupabaseBrowserClient().auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT") setAttempt((n) => n + 1);
    });
    return () => data.subscription.unsubscribe();
  }, [failed]);

  const target = user ? onboardingRedirect(user, path) : null;
  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (!user && failed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6" data-testid="onboarding-gate-failed">
        <div className="max-w-sm space-y-4 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-amber-500" />
          <p className="text-sm text-muted-foreground">{t("gate.failed")}</p>
          <div className="flex justify-center gap-2">
            <Button onClick={() => setAttempt((n) => n + 1)}>{t("gate.retry")}</Button>
            <Button variant="outline" onClick={() => void signOut()}>
              {t("gate.signOut")}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (!user || target) return null;
  return <>{children}</>;
}
