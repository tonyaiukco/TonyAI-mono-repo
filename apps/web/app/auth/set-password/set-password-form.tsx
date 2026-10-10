"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "use-intl";
import { KeyRound, Leaf, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH, passwordProblem, setPasswordFailureKey } from "@/lib/auth-view";
import { getSupabaseBrowserClient } from "@/lib/supabase";

/**
 * The second step of an emailed link (LP4-01): `/auth/confirm` signed the
 * person in; here they choose a password. Without that session there is
 * nothing to do, and the screen says so rather than sending them in circles.
 * After a reset, every other session of the account is signed out.
 */
export function SetPasswordForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const flow = useSearchParams().get("flow") === "recovery" ? "recovery" : "invite";
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [problem, setProblem] = useState<"tooShort" | "mismatch" | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getSupabaseBrowserClient()
      .auth.getSession()
      .then(({ data }) => setHasSession(Boolean(data.session)));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const found = passwordProblem(password, repeat);
    setProblem(found);
    if (found) return;
    setSaving(true);
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setSaving(false);
      toast.error(t(setPasswordFailureKey(error.code), { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    // Whoever asked for the reset link may not be the only one holding a session.
    if (flow === "recovery") await supabase.auth.signOut({ scope: "others" }).catch(() => undefined);
    toast.success(t("setPassword.saved"));
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
          {hasSession && <CardDescription>{t("setPassword.description", { min: MIN_PASSWORD_LENGTH })}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4">
          {hasSession === false ? (
            <>
              <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p>{t("setPassword.noSession")}</p>
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
          ) : (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="new-password">{t("setPassword.password")}</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  aria-invalid={problem === "tooShort"}
                  disabled={!hasSession}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="repeat-password">{t("setPassword.repeat")}</Label>
                <Input
                  id="repeat-password"
                  type="password"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  autoComplete="new-password"
                  aria-invalid={problem === "mismatch"}
                  disabled={!hasSession}
                  required
                />
              </div>
              {problem && (
                <p className="text-sm text-destructive" role="alert">
                  {problem === "tooShort" ? t("setPassword.tooShort", { min: MIN_PASSWORD_LENGTH }) : t("setPassword.mismatch")}
                </p>
              )}
              <Button type="submit" className="w-full gap-2" disabled={!hasSession || saving}>
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
