"use client";

import { ArrowDown } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { entriesJumpWording, jumpToRecords } from "@/lib/records-table-view";

/**
 * The control at the top of Data Entry that leads to the records table (UAT
 * round 4, BUG-15, screen part). A button, not a hash link: the page holds
 * the form in memory, and a jump must not read as a navigation.
 */
export function EntriesJump({ total }: { total: number | null }) {
  const t = useTranslations("dataEntry.records");
  const wording = entriesJumpWording(total);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-3"
      data-testid="entries-jump"
      onClick={() =>
        jumpToRecords(
          (id) => document.getElementById(id),
          window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        )
      }
    >
      <ArrowDown className="h-4 w-4" aria-hidden />
      {wording.key === "jump.count" ? t(wording.key, { count: wording.count }) : t(wording.key)}
    </Button>
  );
}
