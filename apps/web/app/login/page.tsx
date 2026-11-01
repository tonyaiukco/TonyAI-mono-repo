"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "use-intl";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import { signInFailureKey } from "@/lib/auth-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Leaf } from "lucide-react";
import { toast } from "sonner";
import { useReportingContextStore } from "@/lib/store";

// `useSearchParams` needs a Suspense boundary for the page to prerender.
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations("auth");
  const [loading, setLoading] = useState(false);
  const reason = searchParams.get("reason");

  // Sent here because the account was disabled (D19) or its session revoked
  // since it began: `lib/api.ts` ended the session on the API's 401.
  useEffect(() => {
    // Long enough to read: the person did not choose to leave.
    if (reason === "account_disabled") toast.error(t("signIn.disabled"), { id: "login-reason", duration: 10_000 });
    if (reason === "session_revoked") toast.error(t("signIn.sessionRevoked"), { id: "login-reason", duration: 10_000 });
  }, [reason, t]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Read from the inputs, not from state: a password manager or a quick typist
    // can fill them before hydration, and React state never hears about that.
    // By id on purpose: until hydration a click is a native GET submit, and a
    // `name` attribute would put the password in the URL.
    const { elements } = e.currentTarget;
    const email = (elements.namedItem("email") as HTMLInputElement).value;
    const password = (elements.namedItem("password") as HTMLInputElement).value;
    setLoading(true);
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      // Supabase's own sentence is English and names internals; the catalogue
      // words the two outcomes a person can act on.
      toast.error(t(signInFailureKey(error.code)));
      return;
    }
    toast.success(t("signIn.success"));
    // A new session: the previous person's remembered reporting context goes (LP3-02 N1).
    useReportingContextStore.getState().clear();
    router.push("/");
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
          <CardTitle className="text-xl">{t("signIn.title")}</CardTitle>
          <CardDescription>{t("tagline")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t("signIn.email")}</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">{t("signIn.password")}</Label>
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                >
                  {t("signIn.forgot")}
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t("signIn.submitting") : t("signIn.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
