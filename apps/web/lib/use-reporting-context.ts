"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReportingContext } from "@tonyai/shared-types";
import { forgetOnSessionChange, rememberedContextFor, useAuthStore, useReportingContextStore } from "./store";
import { getSupabaseBrowserClient } from "./supabase";
import {
  parseReportingContextUrl,
  queryString,
  reportingContextKey,
  reportingContextQuery,
  resolveReportingContext,
  type ReportingContextUrlKey,
} from "./reporting-context-url";

export type ReportingContextView =
  | {
      status: "ready";
      context: ReportingContext;
      /** Changes exactly when the context does: an effect keyed on it refetches once. */
      key: string;
      /** A new selection, as a history entry (Back returns to the previous one). */
      select: (next: ReportingContext) => void;
    }
  | {
      status: "invalid";
      /** The URL keys refused — the screen names them and fetches nothing. */
      invalid: ReportingContextUrlKey[];
      /** The user's explicit way out: the default context (D06 year, all, unfiltered). */
      reset: () => void;
    };

/** Subscribed once per tab, before anything is remembered: the remembered
 * selection never outlives the session it was made in. */
let watchingSession = false;
function watchSession(): void {
  if (watchingSession) return;
  watchingSession = true;
  getSupabaseBrowserClient().auth.onAuthStateChange((event, session) => forgetOnSessionChange(event, session?.user.id));
}

/**
 * The one reporting context of an annual screen (LP3-02 N1), read from the
 * URL and written back to it in canonical form. Needs a Suspense boundary
 * (`useSearchParams`). An invalid URL is never "fixed" automatically.
 *
 * The URL is written with the History API, which Next's router observes
 * (`useSearchParams` follows it) at once and without a server round trip.
 * `router.replace` on load kept a route fetch in flight for as long as it
 * took, and `LocaleSync`'s `router.refresh()` after sign-in was lost under it:
 * the dashboard, where sign-in lands, stayed in the old language. A selection
 * made while that refresh is still in flight discards it all the same (any
 * client navigation does) — an Open question on `LocaleSync`, not this hook.
 */
export function useReportingContext(): ReportingContextView {
  const params = useSearchParams();
  const pathname = usePathname();
  const userId = useAuthStore((s) => s.user?.id);
  const remembered = useReportingContextStore((s) => s.remembered);
  const remember = useReportingContextStore((s) => s.remember);
  const current = queryString(params);

  const resolution = useMemo(() => {
    const parsed = parseReportingContextUrl(params);
    if (!parsed.ok) return parsed;
    const context = resolveReportingContext(parsed.explicit, rememberedContextFor(remembered, userId));
    return context
      ? { ok: true as const, context }
      : { ok: false as const, invalid: ["scope", "category"] as ReportingContextUrlKey[] };
    // `current` stands for `params`: the object's identity is not its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, remembered, userId]);

  const key = resolution.ok ? reportingContextKey(resolution.context) : null;

  useEffect(() => {
    watchSession();
    if (!resolution.ok || key === null) return;
    const canonical = reportingContextQuery(resolution.context, params);
    if (canonical !== current) window.history.replaceState(null, "", `${pathname}?${canonical}`);
    const rememberedKey = remembered && remembered.userId === userId ? reportingContextKey(remembered.context) : null;
    if (userId !== undefined && rememberedKey !== key) remember(userId, resolution.context);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, current, pathname, userId]);

  const navigate = useCallback(
    (next: ReportingContext, how: "pushState" | "replaceState") => {
      window.history[how](null, "", `${pathname}?${reportingContextQuery(next, params)}`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname, current],
  );
  const select = useCallback((next: ReportingContext) => navigate(next, "pushState"), [navigate]);
  // The default, as the button says — not a remembered selection the link never named.
  const reset = useCallback(() => navigate(resolveReportingContext({}, null)!, "replaceState"), [navigate]);

  return resolution.ok
    ? { status: "ready", context: resolution.context, key: key!, select }
    : { status: "invalid", invalid: resolution.invalid, reset };
}
