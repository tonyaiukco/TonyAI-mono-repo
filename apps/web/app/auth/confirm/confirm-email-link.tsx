"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "use-intl";
import { Leaf, LinkIcon, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { parseEmailLink, type EmailLinkType } from "@/lib/auth-view";
import { getSupabaseBrowserClient } from "@/lib/supabase";

type State =
  | { phase: "ready"; tokenHash: string; type: EmailLinkType }
  | { phase: "verifying"; tokenHash: string; type: EmailLinkType }
  | { phase: "invalid"; type: EmailLinkType | null }
  | { phase: "loading" };

/**
 * Where the invitation and reset emails land (K5): `?token_hash=…&type=…`.
 *
 * `verifyOtp` runs on a click, not on load — a mail scanner that opens links
 * to inspect them would otherwise spend the one-time token before its owner.
 * The token leaves the address bar as soon as it is read (no history entry,
 * no referrer — see `page.tsx`). A valid link signs the person in; an
 * invitation is then marked accepted, and both go on to choose a password.
 */
export function ConfirmEmailLink() {
  const t = useTranslations("auth");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    const link = parseEmailLink(searchParams);
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
    setState((current) => {
      if (current.phase !== "loading") return current;
      return link ? { phase: "ready", ...link } : { phase: "invalid", type: null };
    });
  }, [searchParams]);

  async function onContinue() {
    if (state.phase !== "ready") return;
    const { tokenHash, type } = state;
    setState({ phase: "verifying", tokenHash, type });
    const { error } = await getSupabaseBrowserClient().auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) {
      setState({ phase: "invalid", type });
      return;
    }
    try {
      // Marks an open invitation accepted — after a reset too, for an invitee
      // who never used the invitation itself. A no-op otherwise.
      await api.acceptInvitation();
    } catch {
      // Not a reason to stop: the password still has to be chosen, and a
      // disabled account has already been signed out by `lib/api.ts`.
    }
    router.replace(`/auth/set-password?flow=${type}`);
  }

  const type = state.phase === "loading" ? null : state.type;
  const title =
    state.phase === "invalid" ? t("confirm.invalidTitle") : type === "recovery" ? t("confirm.recoveryTitle") : t("confirm.inviteTitle");

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
          <CardTitle className="text-xl">{title}</CardTitle>
          {(state.phase === "ready" || state.phase === "verifying") && (
            <CardDescription>
              {state.type === "recovery" ? t("confirm.recoveryDescription") : t("confirm.inviteDescription")}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {state.phase === "invalid" ? (
            <>
              <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p>
                  {state.type === "invite"
                    ? t("confirm.invalidInvite")
                    : state.type === "recovery"
                      ? t("confirm.invalidRecovery")
                      : t("confirm.malformed")}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                {state.type !== "invite" && (
                  <Button asChild variant="outline">
                    <Link href="/forgot-password">{t("confirm.requestNew")}</Link>
                  </Button>
                )}
                <Button asChild variant="ghost">
                  <Link href="/login">{t("confirm.toSignIn")}</Link>
                </Button>
              </div>
            </>
          ) : (
            <Button className="w-full gap-2" onClick={onContinue} disabled={state.phase !== "ready"}>
              <LinkIcon className="h-4 w-4" />
              {state.phase === "verifying" || state.phase === "loading" ? t("confirm.verifying") : t("confirm.continue")}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
