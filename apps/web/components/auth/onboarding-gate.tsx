import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "use-intl";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { isWizardPath, onboardingRedirect, retriesOnAuthEvent } from "@/lib/onboarding-view";
import { useAuthStore } from "@/lib/store";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { useSignOut } from "@/lib/use-sign-out";
import type { AuthUser } from "@/lib/types";

/**
 * This tab's Finish (§7.1 step 8): the wizard notes it before it writes the
 * finished account to the store, and the gate then leads to the company tree
 * rather than the dashboard. Forgotten once the tab leaves the wizard.
 */
let finishedInThisTab = false;

/**
 * The account the gate decided on, for the screens inside it: the wizard
 * fills the store from it, so the profile's language applies on its first
 * screen without a second `/me` (owner's second review of WP8, P2).
 */
const GateAccount = createContext<AuthUser | null>(null);
export function useGateAccount(): AuthUser | null {
  return useContext(GateAccount);
}
export function noteOnboardingFinished(): void {
  finishedInThisTab = true;
}

/**
 * The setup wizard's gate (inc26-central-reporter-onboarding, D9), inside the
 * session gate on every protected path. It reads `GET /me` itself, so it never
 * waits for a page that is waiting for it, and decides from the account the
 * store holds when there is one (a page's read, or Finish's answer), else from
 * its own read — which it hands the screens inside it (`useGateAccount`; the
 * wizard fills the store from it). A masterkey of
 * an unfinished organisation is replaced to `/onboarding` from any other path;
 * anyone else away from `/onboarding`. Nothing of the tool renders before the
 * answer. It reads again when the session's account changes (the store is
 * cleared then). A failed read is tried again on Auth's next events but a
 * sign-out (at most three times in a run of failures, never without an event),
 * and is otherwise offered as "Try again" and "Sign out".
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
  // Automatic retries in the current run of failures; a read that succeeds ends the run.
  const autoRetries = useRef(0);
  const failedRef = useRef(false);

  // The store cleared after holding an account: the session changed — read again.
  useEffect(() => {
    if (stored) hadStored.current = true;
    else if (hadStored.current) {
      hadStored.current = false;
      finishedInThisTab = false;
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
        if (!live) return;
        autoRetries.current = 0;
        setRead(me);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [user, attempt]);

  // A read that failed while Auth was settling is tried again on Auth's next
  // events — a few times, never by itself. One subscription for the gate's
  // life: a subscription opened per failure is handed INITIAL_SESSION at once,
  // and retried into a loop (owner review of WP8, P2).
  useEffect(() => {
    failedRef.current = failed;
  }, [failed]);
  useEffect(() => {
    const { data } = getSupabaseBrowserClient().auth.onAuthStateChange((event) => {
      if (!failedRef.current || !retriesOnAuthEvent(event, autoRetries.current)) return;
      autoRetries.current += 1;
      setAttempt((n) => n + 1);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!isWizardPath(path)) finishedInThisTab = false;
  }, [path]);

  const target = user ? onboardingRedirect(user, path, finishedInThisTab) : null;
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
            <Button onClick={() => setAttempt((n) => n + 1)} data-testid="onboarding-gate-retry">{t("gate.retry")}</Button>
            <Button variant="outline" onClick={() => void signOut()}>
              {t("gate.signOut")}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (!user || target) return null;
  return <GateAccount.Provider value={user}>{children}</GateAccount.Provider>;
}
