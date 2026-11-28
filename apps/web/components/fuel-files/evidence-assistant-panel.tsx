"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import { CircleDashed, Loader2, ScanSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/i18n/number";
import {
  assistantLitres,
  fileText,
  invoiceLevelText,
  latestOnly,
  lineChip,
  lineText,
  unreadWording,
  type AssistantKey,
} from "@/lib/evidence-assistant-view";
import type { EvidenceAssistantDTO, Locale } from "@/lib/types";

type Answer = { kind: "loading" } | { kind: "failed" } | { kind: "answer"; dto: EvidenceAssistantDTO };

/**
 * The evidence assistant beside a fuel package in the review queue
 * (inc29-evidence-assistant, D10): the invoice's litres per fuel beside the
 * package's, a soft state each, and nothing that decides. It asks on its own
 * request after the sheet has the batch, so the sheet's actions never wait for
 * it; a late answer for another batch or an older set of files is dropped, and
 * a failed or slow request shows the manual-check wording. Off, it shows nothing.
 *
 * `version` changes whenever the package's files or submission change, so the
 * comparison is asked again (INC-2.6 §1.2: it runs again on the new value).
 */
export function EvidenceAssistantPanel({
  batchId,
  version,
  onOpenBatch,
}: {
  batchId: string;
  version: string;
  onOpenBatch?: (id: string) => void;
}) {
  const t = useTranslations("evidenceAssistant");
  const locale = useLocale() as Locale;
  const copy = useMemo(() => ({ t: t as unknown as (key: AssistantKey, values?: Record<string, string | number>) => string, locale }), [t, locale]);
  const guard = useMemo(() => latestOnly(), []);
  const [answer, setAnswer] = useState<Answer>({ kind: "loading" });

  useEffect(() => {
    const token = guard.next();
    setAnswer({ kind: "loading" });
    api
      .getFuelBatchEvidenceAssistant(batchId)
      .then((dto) => guard.isLatest(token) && setAnswer({ kind: "answer", dto }))
      .catch(() => guard.isLatest(token) && setAnswer({ kind: "failed" }));
    return () => guard.cancel();
  }, [batchId, version, guard]);

  if (answer.kind === "answer" && !answer.dto.enabled) return null;

  return (
    <section className="space-y-3 rounded-md border border-dashed p-3" data-testid="evidence-assistant">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium"><ScanSearch className="h-4 w-4" />{t("title")}</h3>
        {answer.kind === "answer" && answer.dto.enabled && (
          <span className="text-xs text-muted-foreground">{t("tolerance", { percent: formatNumber(answer.dto.tolerancePercent, locale) })}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("notADecision")}</p>
      <Body answer={answer} copy={copy} onOpenBatch={onOpenBatch} />
    </section>
  );
}

function Body({ answer, copy, onOpenBatch }: { answer: Answer; copy: { t: (key: AssistantKey, values?: Record<string, string | number>) => string; locale: Locale }; onOpenBatch?: (id: string) => void }) {
  const t = useTranslations("evidenceAssistant");
  if (answer.kind === "loading") {
    // While it reads, the reviewer is pointed to the manual check, as for any unread answer (D7).
    return (
      <div className="space-y-1">
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</p>
        <p className="text-sm font-medium">{t("manualCheck")}</p>
      </div>
    );
  }
  if (answer.kind === "failed" || !answer.dto.enabled || answer.dto.unread) {
    const reason = answer.kind === "failed" || !answer.dto.enabled ? "failed" : answer.dto.unread!.reason;
    const words = unreadWording(reason, copy);
    return (
      <div className="space-y-1 text-sm" data-testid="evidence-assistant-unread">
        <Badge variant="outline" className="gap-1 border-slate-400/50 text-slate-700"><CircleDashed className="h-3 w-3" />{words.title}</Badge>
        <p>{words.ask}</p>
        {words.detail && <p className="text-xs text-muted-foreground">{words.detail}</p>}
      </div>
    );
  }
  const dto = answer.dto;
  const { invoice } = dto;
  return (
    <div className="space-y-3 text-sm">
      <ul className="space-y-2">
        {dto.lines.map((line) => {
          const chip = lineChip(line, copy);
          const level = "invoiceLevelLitres" in line ? invoiceLevelText(line, copy) : null;
          return (
            <li key={line.fuel} className="space-y-1" data-testid={`evidence-assistant-line-${line.fuel}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{lineText(line, invoice, copy)}</span>
                <Badge
                  variant="outline"
                  className={chip.tone === "consistent" ? "border-emerald-500/40 text-emerald-700" : "border-amber-500/40 text-amber-700"}>
                  {chip.label}
                </Badge>
              </div>
              {level && <p className="text-xs text-muted-foreground">{level}</p>}
            </li>
          );
        })}
      </ul>
      {dto.otherLines.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground">{t("otherLines")}</p>
          <ul className="text-xs">
            {dto.otherLines.map((l) => <li key={l.product}>{t("otherLine", { product: l.product, litres: assistantLitres(l.litres, copy.locale) })}</li>)}
          </ul>
        </div>
      )}
      {dto.level === "invoice" && (
        <div className="space-y-1">
          {dto.shared.accounts >= 2 && <p className="font-medium">{t("sharedNote", { count: formatNumber(dto.shared.accounts, copy.locale) })}</p>}
          {dto.shared.siblings.length > 0 ? (
            <div>
              <p className="text-xs text-muted-foreground">{t("siblings")}</p>
              <ul className="text-xs">
                {dto.shared.siblings.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="text-primary hover:underline disabled:no-underline" disabled={!onOpenBatch} onClick={() => onOpenBatch?.(s.id)}>
                      {t("sibling", { account: s.accountName, company: s.subsidiaryName, sequence: formatNumber(s.sequence, copy.locale) })}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            dto.shared.accounts >= 2 && <p className="text-xs text-muted-foreground">{t("noVisibleSiblings")}</p>
          )}
        </div>
      )}
      {invoice.buyerName && (
        <p className="text-xs">
          {t("buyer", { name: invoice.buyerName })}
          {invoice.buyerTaxId && ` · ${t("buyerTaxId", { taxId: invoice.buyerTaxId })}`}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{fileText(invoice, copy)}</p>
    </div>
  );
}
