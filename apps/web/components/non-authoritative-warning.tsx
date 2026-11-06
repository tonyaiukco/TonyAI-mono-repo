import { Info } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The figures above or beside it that are not authoritative now, counted by the
 * server (`nonAuthoritativeRecordCount`): a placeholder (demo) or fixture factor,
 * a pre-release snapshot or a release withdrawn since. A standing condition, so
 * `status`, not `alert`: it is re-read on every selection, never announced as
 * an error (QA L10).
 */
export function NonAuthoritativeWarning({ children, testId = "non-authoritative-warning" }: { children: ReactNode; testId?: string }) {
  return (
    <div role="status" data-testid={testId} className="flex items-start gap-2 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-sm text-[#991B1B]">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
