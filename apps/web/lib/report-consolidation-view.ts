import { CONSOLIDATION_APPROACHES, type ConsolidationApproach, type ReportMetaDTO } from "@/lib/types";

export type PreviewConsolidation = { approach: ConsolidationApproach; associates: string[] } | "loading" | "failed";

/**
 * The approach and the associates a report preview states (inc26-group-tree,
 * D8), from its own `GET /reports/meta` read. "failed" when the read failed —
 * or answered without them, as the API image before WP7 does after a
 * rollback: the figures still show, and the screen says the approach was not
 * read rather than reading a field that is not there (owner's third review of
 * WP7, P2).
 */
export function previewConsolidation(meta: ReportMetaDTO | null, previewFailed: boolean): PreviewConsolidation {
  if (meta === null) return previewFailed ? "failed" : "loading";
  const approach = (meta as Partial<ReportMetaDTO>).consolidationApproach;
  const associates = (meta as Partial<ReportMetaDTO>).excludedAssociates;
  if (!(CONSOLIDATION_APPROACHES as readonly unknown[]).includes(approach) || !Array.isArray(associates)) return "failed";
  return { approach: approach as ConsolidationApproach, associates: associates.filter((a): a is string => typeof a === "string") };
}
