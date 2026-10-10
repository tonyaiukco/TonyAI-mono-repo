"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "use-intl";
import { Leaf, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useErrorToast } from "@/lib/i18n/hooks";

/**
 * "Forgot password" (LP4-01). The API answers the same for every address, so
 * this screen does too: it never says whether an account exists.
 */
export default function ForgotPasswordPage() {
  const t = useTranslations("auth");
  const errorToast = useErrorToast();
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      await api.requestPasswordReset({ email: email.trim() });
      setSentTo(email.trim());
    } catch (error) {
      // 429 (too many requests from here) or the network — never "no such account".
      errorToast(error);
    } finally {
      setSending(false);
    }
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
          <CardTitle className="text-xl">{sentTo ? t("forgot.sentTitle") : t("forgot.title")}</CardTitle>
          {!sentTo && <CardDescription>{t("forgot.description")}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4">
          {sentTo ? (
            <div className="flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
              <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
              <p>{t("forgot.sent", { email: sentTo })}</p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t("forgot.email")}</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  maxLength={254}
                  autoComplete="email"
                  autoFocus
                />
              </div>
              <Button type="submit" className="w-full" disabled={sending}>
                {sending ? t("forgot.submitting") : t("forgot.submit")}
              </Button>
            </form>
          )}
          <p className="text-center text-sm">
            <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
              {t("forgot.back")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
