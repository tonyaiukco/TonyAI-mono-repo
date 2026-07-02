---
name: wire-page
description: Wire a Next.js page in apps/web to the live TonyAI API — replace mock data with calls through lib/api.ts, add auth (current user + sign-out), and handle loading/empty/error (incl. 401/403) states, matching the existing design system. Use when connecting a frontend page or section to the backend.
---

# wire-page

Connect a page in `apps/web` to the live API. Three **canonical references** — read the one closest
to your page type first and mirror it:

- `apps/web/app/subsidiaries/page.tsx` — simple CRUD list + dialog forms
- `apps/web/app/data-entry/page.tsx` — form workspace with live calculation preview + mutations
- `apps/web/app/emissions/page.tsx` — read-only analytics over an aggregation endpoint (tabs, filters, charts)

## When to use
Turning a mock-driven page/section into a live one (dashboard widgets, Reports, new modules).

## Rules (must hold)
- Data goes through **`@/lib/api`** (the typed `api` client) — never raw `fetch` or a hardcoded URL in a page.
- Types come from **`@/lib/types`** (re-exports `@tonyai/shared-types`) — never inline a duplicate.
- Match the existing design system: Tailwind v4 + shadcn/ui, Inter / JetBrains Mono, emerald primary. No generic AI look.
- Keep `typescript.ignoreBuildErrors` OFF — fix types.
- Client components (`"use client"`) fetch on mount; the route is already protected by `middleware.ts`.

## Steps
1. **API methods:** add any missing calls to `apps/web/lib/api.ts` (typed with shared-types DTOs). Keep the `apiFetch` wrapper — it attaches the Supabase bearer token and surfaces the API's `message` on error.
2. **Current user:** on mount, `api.me()` → `useAuthStore().setUser`; show the user's name/role + a Sign-out button (mirror the subsidiaries page: `getSupabaseBrowserClient().auth.signOut()` then `router.push('/login')`).
3. **Fetch + state:** load data in a `useEffect`; keep `loading`, empty, and error states. Surface every failure with `sonner` `toast.error` — branch on `ApiError.status` for friendly 401 (session expired) / 403 (no access) / 5xx (service unavailable) messages (see the `errMessage` helper in the emissions page).
4. **Mutations:** call the `api.*` method, then refresh; `toast.success` on success; disable buttons while saving.
5. **Honesty (compliance-critical):** if part of the screen has no backend yet, choose one of two labels and never imply mock data is live:
   - **"Demo data" badge** — when illustrative mock content stays visible (e.g. a dashboard section awaiting wiring).
   - **"Not yet available" empty state** — preferred for emissions/target *numbers*: show an explicit placeholder card with no figures at all, so nothing can be mistaken for a real value (see the Targets tab + locked Intensity toggle on the emissions page).

## Skeleton
```tsx
"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "sonner";
import type { SomeDTO } from "@/lib/types";

export default function Page() {
  const { setUser } = useAuthStore();
  const [rows, setRows] = useState<SomeDTO[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try { setRows(await api.listSomething()); }
    catch (e) { toast.error((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    api.me().then(setUser).catch((e) => toast.error((e as Error).message));
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // render: loading -> empty -> rows.map(...)
}
```

## Verify
`pnpm --filter @tonyai/web typecheck && pnpm --filter @tonyai/web build`, then load the page against the running API and confirm the live data and a mutation reflect correctly (and that a 403 / empty state renders cleanly).
