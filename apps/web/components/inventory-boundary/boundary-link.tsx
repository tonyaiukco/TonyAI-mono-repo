"use client";

import Link from "next/link";
import { useTranslations } from "use-intl";
import { Waypoints } from "lucide-react";
import { useAuthStore } from "@/lib/store";
import { can } from "@/lib/types";

/**
 * The way from a coverage reading to the year's boundary (LP4-03 PR C, D1):
 * "declare or edit" for a role that writes it (`boundary.write`); "view" for
 * every other.
 */
export function BoundaryLink({ year, className = "" }: { year: number; className?: string }) {
  const t = useTranslations("boundary");
  const role = useAuthStore((s) => s.user?.role);
  return (
    <Link
      href={`/inventory-boundary?year=${year}`}
      className={`inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2 hover:no-underline ${className}`}
      data-testid="boundary-link"
    >
      <Waypoints className="h-3 w-3" aria-hidden />
      {can(role, "boundary.write") ? t("link.edit") : t("link.view")}
    </Link>
  );
}
