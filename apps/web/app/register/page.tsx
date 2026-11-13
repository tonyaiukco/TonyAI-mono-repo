"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "use-intl";
import { Leaf, MailCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import {
  EMPTY_REGISTRATION_FORM,
  registrationFailure,
  registrationNoticeIsCurrent,
  registrationProblem,
  registrationRequest,
  type RegistrationForm,
} from "@/lib/auth-view";
import { useErrorToast } from "@/lib/i18n/hooks";
import { DEFAULT_LOCALE, isLocale, isPlaceholderConsentVersion, REGISTRATION_CONSENT_VERSION, REGISTRATION_FIELD_MAX } from "@/lib/types";

/** The notice this build shows is its own: so is whether it is a placeholder. */
const NOTICE_IS_PLACEHOLDER = isPlaceholderConsentVersion(REGISTRATION_CONSENT_VERSION);

type Phase =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "loadFailed" }
  // The API records consent to another notice than this build shows.
  | { kind: "outdated" }
  | { kind: "form" }
  | { kind: "sent"; email: string };

/**
 * Self-service registration: an invited company creates its account and its
 * first administrator behind the registration code. The API answers the same
 * for every address once the code is right, so the confirmation here does
 * too: it never says whether an address already has an account.
 */
export default function RegisterPage() {
  const t = useTranslations("auth");
  const locale = useLocale();
  const errorToast = useErrorToast();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [form, setForm] = useState<RegistrationForm>(EMPTY_REGISTRATION_FORM);
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [consentMissing, setConsentMissing] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const status = await api.getRegistrationStatus();
      if (!status) setPhase({ kind: "unavailable" });
      else setPhase(registrationNoticeIsCurrent(status) ? { kind: "form" } : { kind: "outdated" });
    } catch {
      setPhase({ kind: "loadFailed" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (field: keyof RegistrationForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [field]: e.target.value }));
    if (field === "registrationCode") setCodeInvalid(false);
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (phase.kind !== "form") return;
    const problem = registrationProblem(form);
    setConsentMissing(problem === "consentRequired");
    if (problem) {
      toast.error(t(`register.${problem}`));
      return;
    }
    setSending(true);
    try {
      const request = registrationRequest(form, isLocale(locale) ? locale : DEFAULT_LOCALE);
      await api.register(request);
      setPhase({ kind: "sent", email: request.email });
    } catch (error) {
      const failure = registrationFailure(error);
      // A wrong code is said at its field, the form kept as typed.
      if (failure === "codeInvalid") setCodeInvalid(true);
      else if (failure === "unavailable") setPhase({ kind: "unavailable" });
      // 429 (too many requests from here), the network, or a notice changed
      // under an open page — never "this address is registered".
      else errorToast(error);
    } finally {
      setSending(false);
    }
  }

  const title =
    phase.kind === "sent"
      ? t("register.sentTitle")
      : phase.kind === "unavailable"
        ? t("register.unavailableTitle")
        : phase.kind === "loadFailed"
          ? t("register.loadFailedTitle")
          : phase.kind === "outdated"
            ? t("register.outdatedTitle")
            : t("register.title");

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-lg">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Leaf className="h-5 w-5" />
            </span>
            <span className="text-lg font-semibold">TonyAI</span>
          </div>
          <CardTitle className="text-xl">{title}</CardTitle>
          {(phase.kind === "form" || phase.kind === "loading") && <CardDescription>{t("register.description")}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4">
          {phase.kind === "loading" && (
            <p className="text-sm text-muted-foreground" role="status">
              {t("register.loading")}
            </p>
          )}

          {phase.kind === "unavailable" && <p className="text-sm text-muted-foreground">{t("register.unavailable")}</p>}

          {phase.kind === "loadFailed" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t("register.loadFailed")}</p>
              <Button type="button" variant="outline" className="w-full" onClick={() => void load()}>
                {t("register.retry")}
              </Button>
            </div>
          )}

          {phase.kind === "outdated" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t("register.outdated")}</p>
              <Button type="button" variant="outline" className="w-full" onClick={() => window.location.reload()}>
                {t("register.reload")}
              </Button>
            </div>
          )}

          {phase.kind === "sent" && (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                <p>{t("register.sent", { email: phase.email })}</p>
              </div>
              <p className="text-sm text-muted-foreground">{t("register.sentExisting")}</p>
            </div>
          )}

          {phase.kind === "form" && (
            <form onSubmit={onSubmit} className="space-y-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="firstName">{t("register.firstName")}</Label>
                  <Input
                    id="firstName"
                    value={form.firstName}
                    onChange={set("firstName")}
                    required
                    maxLength={REGISTRATION_FIELD_MAX.firstName}
                    autoComplete="given-name"
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">{t("register.lastName")}</Label>
                  <Input
                    id="lastName"
                    value={form.lastName}
                    onChange={set("lastName")}
                    required
                    maxLength={REGISTRATION_FIELD_MAX.lastName}
                    autoComplete="family-name"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="companyName">{t("register.companyName")}</Label>
                <Input
                  id="companyName"
                  value={form.companyName}
                  onChange={set("companyName")}
                  required
                  maxLength={REGISTRATION_FIELD_MAX.companyName}
                  autoComplete="organization"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="jobTitle">{t("register.jobTitle")}</Label>
                <Input
                  id="jobTitle"
                  value={form.jobTitle}
                  onChange={set("jobTitle")}
                  required
                  maxLength={REGISTRATION_FIELD_MAX.jobTitle}
                  autoComplete="organization-title"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">{t("register.email")}</Label>
                <Input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={set("email")}
                  required
                  maxLength={REGISTRATION_FIELD_MAX.email}
                  autoComplete="email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="registrationCode">{t("register.code")}</Label>
                <Input
                  id="registrationCode"
                  value={form.registrationCode}
                  onChange={set("registrationCode")}
                  required
                  maxLength={5}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="font-mono tracking-widest"
                  aria-invalid={codeInvalid}
                  aria-describedby={codeInvalid ? "registrationCode-error" : "registrationCode-hint"}
                />
                {codeInvalid ? (
                  <p id="registrationCode-error" role="alert" className="text-xs font-medium text-destructive">
                    {t("register.codeInvalid")}
                  </p>
                ) : (
                  <p id="registrationCode-hint" className="text-xs text-muted-foreground">
                    {t("register.codeHint")}
                  </p>
                )}
              </div>

              <section aria-labelledby="notice-title" className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="notice-title" className="text-sm font-medium">
                    {t("register.noticeTitle")}
                  </h2>
                  {NOTICE_IS_PLACEHOLDER && (
                    <Badge variant="outline" className="gap-1 border-amber-500/50 bg-amber-500/10 text-amber-800">
                      <TriangleAlert className="h-3 w-3" />
                      {t("register.noticePlaceholder")}
                    </Badge>
                  )}
                </div>
                <div
                  tabIndex={0}
                  className="max-h-32 overflow-y-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground"
                >
                  {t("register.notice")}
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="consent"
                    checked={form.consent}
                    onCheckedChange={(checked) => {
                      setForm((current) => ({ ...current, consent: checked === true }));
                      if (checked === true) setConsentMissing(false);
                    }}
                    aria-invalid={consentMissing}
                    className="mt-0.5"
                  />
                  <Label htmlFor="consent" className="text-sm font-normal leading-snug">
                    {t("register.consent")}
                  </Label>
                </div>
                {consentMissing && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {t("register.consentRequired")}
                  </p>
                )}
              </section>

              <Button type="submit" className="w-full" disabled={sending}>
                {sending ? t("register.submitting") : t("register.submit")}
              </Button>
            </form>
          )}

          <p className="text-center text-sm text-muted-foreground">
            {phase.kind === "form" && <>{t("register.haveAccount")} </>}
            <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
              {t("register.signIn")}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
