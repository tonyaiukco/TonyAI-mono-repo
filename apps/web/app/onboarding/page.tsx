"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "use-intl";
import { toast } from "sonner";
import { noteOnboardingFinished, useGateAccount } from "@/components/auth/onboarding-gate";
import { SignOutButton } from "@/components/dashboard/sign-out-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ApproachStep,
  BoundariesStep,
  CentralReporterStep,
  CompaniesStep,
  HoldingStep,
  SectorGroupsStep,
  SuperAdminsStep,
  type StepProps,
} from "@/components/onboarding/steps";
import { api } from "@/lib/api";
import { useErrorToast } from "@/lib/i18n/hooks";
import { ONBOARDING_STEPS, maySeeStep, nextStep, previousStep, type OnboardingStep } from "@/lib/onboarding-view";
import { useAuthStore } from "@/lib/store";
import type { SubsidiaryDTO } from "@/lib/types";
import { useSignOut } from "@/lib/use-sign-out";

/**
 * The masterkey's setup wizard (inc26-central-reporter-onboarding, INC-2.6
 * §7.1; design D9, D10): no sidebar, one step per screen in the fixed order,
 * a step shown only after the ones before it are passed. Nothing about the
 * steps is stored (C8): a return starts again at step 1, and each step shows
 * what is stored. Finish answers the organisation as finished — also to a
 * second masterkey whose organisation another one finished — and leads to the
 * company tree. `OnboardingGate` holds the masterkey here until then.
 */
export default function OnboardingPage() {
  const t = useTranslations("onboarding");
  const signOut = useSignOut();
  const showError = useErrorToast();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const [step, setStep] = useState<OnboardingStep>("holding");
  const [passed, setPassed] = useState<Set<OnboardingStep>>(new Set());
  const [nodes, setNodes] = useState<SubsidiaryDTO[] | null>(null);
  const [finishing, setFinishing] = useState(false);

  const reload = useCallback(async () => {
    const list = await api.listSubsidiaries();
    setNodes(list);
    return list;
  }, []);
  useEffect(() => {
    reload().catch(showError);
  }, [reload, showError]);
  // The account in the store, from the gate's own read: the profile's
  // language is applied from it (`LocaleSync`) on the wizard's first screen,
  // with no second `/me` to fail (owner's reviews of WP8, P2).
  const gateAccount = useGateAccount();
  useEffect(() => {
    if (!user && gateAccount) setUser(gateAccount);
  }, [user, gateAccount, setUser]);

  function advance() {
    setPassed((p) => new Set(p).add(step));
    const next = nextStep(step);
    if (next) setStep(next);
  }

  async function finish() {
    setFinishing(true);
    try {
      await api.completeOnboarding();
      // The gate leads on: noted as this tab's Finish, it sends the finished
      // account to the company tree (a later visit here goes to the dashboard).
      noteOnboardingFinished();
      setUser(await api.me());
    } catch (e) {
      showError(e);
      toast.error(t("finish.failed"));
    } finally {
      setFinishing(false);
    }
  }

  const index = ONBOARDING_STEPS.indexOf(step);
  const back = previousStep(step);
  const footer: StepProps["footer"] = ({ label, onClick, busy, disabled }) => (
    <div className="flex justify-between gap-2 pt-2">
      <Button variant="outline" disabled={!back} onClick={() => back && setStep(back)} data-testid="onboarding-back">
        {t("back")}
      </Button>
      <Button disabled={busy || disabled} onClick={onClick} data-testid="onboarding-next">
        {busy ? t("saving") : label ?? t("next")}
      </Button>
    </div>
  );

  const props: StepProps | null = nodes ? { nodes, reload, onNext: advance, footer } : null;
  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-8 py-4">
        <div>
          <h1 className="text-xl font-semibold" data-testid="onboarding-title">{t("title")}</h1>
          <p className="text-sm text-muted-foreground" data-testid="onboarding-step-count">
            {t("stepOf", { current: index + 1, total: ONBOARDING_STEPS.length })}
          </p>
        </div>
        <SignOutButton onClick={() => void signOut()} />
      </header>
      <main className="mx-auto max-w-2xl p-8">
        <ol className="mb-6 flex flex-wrap gap-2 text-xs" aria-label={t("title")}>
          {ONBOARDING_STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={s === step ? "step" : undefined}
              className={s === step ? "rounded bg-primary px-2 py-1 text-primary-foreground" : "rounded bg-muted px-2 py-1 text-muted-foreground"}
            >
              {i + 1}. {t(`steps.${s}`)}
            </li>
          ))}
        </ol>
        <Card>
          <CardHeader>
            <CardTitle data-testid="onboarding-step-title">{t(`steps.${step}`)}</CardTitle>
          </CardHeader>
          <CardContent>
            {!props || !maySeeStep(step, passed) ? null : step === "holding" ? (
              <HoldingStep {...props} />
            ) : step === "approach" ? (
              <ApproachStep {...props} />
            ) : step === "sectorGroups" ? (
              <SectorGroupsStep {...props} />
            ) : step === "companies" ? (
              <CompaniesStep {...props} />
            ) : step === "boundaries" ? (
              <BoundariesStep {...props} />
            ) : step === "superAdmins" ? (
              <SuperAdminsStep {...props} />
            ) : step === "centralReporter" ? (
              <CentralReporterStep {...props} />
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">{t("finish.description")}</p>
                {footer({ label: t("finish.submit"), onClick: () => void finish(), busy: finishing })}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
