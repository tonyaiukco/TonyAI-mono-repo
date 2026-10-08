"use client";

import { Languages } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "use-intl";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useDescribeError } from "@/lib/i18n/hooks";
import { useAuthStore } from "@/lib/store";
import { SUPPORTED_LOCALES, type Locale } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The UI language, saved to the signed-in user's profile (PATCH
 * /me/preferences). The profile is the truth: once it answers, `LocaleSync`
 * mirrors it into the cookie and re-renders the page in it — form state
 * included, which is why a typed quantity is re-rendered from the number it
 * meant (`reformatDecimalInput`), never re-read.
 *
 * Disabled until the user is known: a choice made before /me answered would
 * be overwritten by the profile a moment later.
 */
export function LanguageSwitcher({ collapsed }: { collapsed: boolean }) {
  const t = useTranslations("nav");
  const locale = useLocale();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const describe = useDescribeError();
  const [saving, setSaving] = useState<Locale | null>(null);

  async function choose(next: Locale) {
    if (!user || next === locale || saving) return;
    setSaving(next);
    try {
      setUser(await api.updateMyPreferences({ language: next }));
    } catch (e) {
      const { title } = describe(e);
      toast.error(t("languageSaveFailed"), { description: title });
    } finally {
      setSaving(null);
    }
  }

  const other = SUPPORTED_LOCALES.find((l) => l !== locale) ?? locale;

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => choose(other)}
            disabled={!user || saving !== null}
            aria-label={`${t("language")}: ${t(`languages.${other}`)}`}
            className="flex w-full items-center justify-center rounded-xl px-4 py-3 text-xs font-semibold text-[#6E6E73] transition-all duration-200 hover:bg-[#E0E0E5] disabled:opacity-50"
          >
            <Languages className="h-5 w-5 shrink-0" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="bg-[#1D1D1F] text-white border-0 font-semibold shadow-lg">
          {t("language")}: {t(`languages.${locale}`)}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-xl px-4 py-2 text-sm font-semibold text-[#1D1D1F]">
      <Languages className="h-5 w-5 shrink-0 text-[#6E6E73]" />
      <span id="language-switcher-label">{t("language")}</span>
      <div role="group" aria-labelledby="language-switcher-label" className="ml-auto flex rounded-lg bg-[#E0E0E5] p-0.5">
        {SUPPORTED_LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            lang={l}
            aria-pressed={l === locale}
            aria-label={t(`languages.${l}`)}
            disabled={!user || saving !== null}
            onClick={() => choose(l)}
            className={cn(
              "rounded-md px-2.5 py-1 font-mono text-xs uppercase transition-colors disabled:cursor-not-allowed",
              l === locale ? "bg-[#1B5E3B] text-white" : "text-[#6E6E73] hover:text-[#1D1D1F]",
              saving === l && "animate-pulse",
            )}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}
