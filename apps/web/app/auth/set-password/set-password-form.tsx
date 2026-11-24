"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "use-intl";
import { KeyRound, Leaf, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PasswordInput } from "@/components/auth/password-input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH, passwordProblem, setPasswordFailureKey } from "@/lib/auth-view";
import { clearEmailLinkMarker, readEmailLinkMarker, sessionIdOf, tabStorage, type EmailLinkFlow } from "@/lib/email-link-marker";
import { authForCheckedSession } from "@/lib/session-bound-auth";
import { acceptOwnInvitation } from "@/lib/invitation-acceptance";
import { recordPasswordSet } from "@/lib/password-set-record";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { useAuthStore, useReportingContextStore } from "@/lib/store";

/** What the screen can offer: nothing yet, no session, a session no email link opened here, or the form. */
type Access =
  | { kind: "loading" }
  | { kind: "noSession" }
  | { kind: "noLink" }
  | { kind: "ready"; flow: EmailLinkFlow };

/**
 * The second step of an emailed link (LP4-01): `/auth/confirm` signed the
 * person in; here they choose a password. Without that session there is
 * nothing to do, and the screen says so rather than sending them in circles.
 * After a reset, every other session of the account is signed out.
 *
 * Only a session an email link opened in this tab within the hour gets the
 * form (`account-access`; `pre-g5-security-hardening`): the marker
 * `/auth/confirm` wrote. Any other visitor — a signed-in user who opens this
 * page directly, another tab, a stale link — is told to use their email link.
 * The flow is the marker's, never the address bar's.
 */
export function SetPasswordForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const requestedFlow = useSearchParams().get("flow") === "recovery" ? "recovery" : "invite";
  const [access, setAccess] = useState<Access>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [problem, setProblem] = useState<"tooShort" | "mismatch" | null>(null);
  const [saving, setSaving] = useState(false);
  const ready = access.kind === "ready";
  // The title before the marker is read: cosmetic only, the address bar's word.
  const flow = access.kind === "ready" ? access.flow : requestedFlow;

  useEffect(() => {
    void getSupabaseBrowserClient()
      .auth.getSession()
      .then(({ data }) => {
        if (!data.session) return setAccess({ kind: "noSession" });
        const marker = readEmailLinkMarker(tabStorage(), data.session.user.id, sessionIdOf(data.session.access_token));
        setAccess(marker ? { kind: "ready", flow: marker.flow } : { kind: "noLink" });
      }, () => setAccess({ kind: "noSession" }));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const found = passwordProblem(password, repeat);
    setProblem(found);
    if (found) return;
    if (access.kind !== "ready") return;
    setSaving(true);
    const supabase = getSupabaseBrowserClient();
    // Checked again now, not only on load: another tab may have signed someone
    // else in since, or the marker expired (architect review). The password
    // and its record are for the session the marker was written for.
    const current = await supabase.auth.getSession().then(({ data }) => data.session, () => null);
    const marker = current ? readEmailLinkMarker(tabStorage(), current.user.id, sessionIdOf(current.access_token)) : null;
    if (!current || !marker) {
      setSaving(false);
      setAccess(current ? { kind: "noLink" } : { kind: "noSession" });
      return;
    }
    const linkFlow = marker.flow;
    // Auth for exactly the session just checked: the shared client would read
    // the session again inside each call, and another tab may change it
    // (Codex review, P1).
    let auth: Awaited<ReturnType<typeof authForCheckedSession>>;
    try {
      auth = await authForCheckedSession(current);
    } catch {
      setSaving(false);
      setAccess({ kind: "noLink" });
      return;
    }
    const { error } = await auth.updateUser({ password });
    if (error) {
      setSaving(false);
      toast.error(t(setPasswordFailureKey(error.code), { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    // Whoever asked for the reset link may not be the only one holding a
    // session. Asked first, before any bookkeeping can delay or lose it, and
    // said when it did not go through (Codex review of #350).
    if (linkFlow === "recovery") {
      const { error: othersError } = await auth
        .signOut({ scope: "others" })
        .catch((failure: unknown) => ({ error: failure }));
      if (othersError) toast.warning(t("setPassword.othersNotSignedOut"));
    }
    // The marker has done its work: this tab sets no second password from it.
    clearEmailLinkMarker(tabStorage());
    toast.success(t("setPassword.saved"));
    // The confirm step's acceptance may not have gone through: asked again, a
    // no-op when it did (pre-pilot defects); waited for `ACCEPT_WAIT_MS` at most.
    await acceptOwnInvitation(current.access_token);
    // The account's own audit trail records the new password (`account-access`),
    // bounded the same way; the password is set whatever it answers.
    await recordPasswordSet(current.access_token, linkFlow);
    // A new session: the previous person's remembered reporting context goes (LP3-02 N1).
    useReportingContextStore.getState().clear();
    // …and the previous person's role, until the new one is read (pre-pilot defects).
    useAuthStore.getState().clear();
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Leaf className="h-5 w-5" />
            </span>
            <span className="text-lg font-semibold">TonyAI</span>
          </div>
          <CardTitle className="text-xl">
            {flow === "recovery" ? t("setPassword.titleReset") : t("setPassword.title")}
          </CardTitle>
          {ready && <CardDescription>{t("setPassword.description", { min: MIN_PASSWORD_LENGTH })}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4">
          {access.kind === "noSession" || access.kind === "noLink" ? (
            <>
              <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm" role="status">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p>{access.kind === "noSession" ? t("setPassword.noSession") : t("setPassword.useEmailLink")}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Button asChild variant="outline">
                  <Link href="/forgot-password">{t("confirm.requestNew")}</Link>
                </Button>
                <Button asChild variant="ghost">
                  <Link href="/login">{t("confirm.toSignIn")}</Link>
                </Button>
              </div>
            </>
          ) : access.kind === "loading" ? (
            // No field before the marker is read: the spec offers none without it.
            <p className="text-sm text-muted-foreground" role="status" aria-busy="true">
              {t("setPassword.checking")}
            </p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="new-password">{t("setPassword.password")}</Label>
                <PasswordInput
                  id="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  aria-invalid={problem === "tooShort"}
                  disabled={!ready}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="repeat-password">{t("setPassword.repeat")}</Label>
                <PasswordInput
                  id="repeat-password"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  autoComplete="new-password"
                  aria-invalid={problem === "mismatch"}
                  disabled={!ready}
                  required
                />
              </div>
              {problem && (
                <p className="text-sm text-destructive" role="alert">
                  {problem === "tooShort" ? t("setPassword.tooShort", { min: MIN_PASSWORD_LENGTH }) : t("setPassword.mismatch")}
                </p>
              )}
              <Button type="submit" className="w-full gap-2" disabled={!ready || saving}>
                <KeyRound className="h-4 w-4" />
                {saving ? t("setPassword.submitting") : t("setPassword.submit")}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
