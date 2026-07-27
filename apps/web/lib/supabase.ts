"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fixed auth cookie name shared with the server-side client in proxy.ts.
 * @supabase/ssr derives the default cookie name from the Supabase URL's host —
 * in containers the browser and the server reach Supabase via DIFFERENT hosts
 * (localhost vs host.docker.internal), which would split the session across two
 * cookie names and bounce every login back to /login.
 */
export const AUTH_STORAGE_KEY = "sb-tonyai-auth";

let browserClient: SupabaseClient | undefined;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    browserClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
      { auth: { storageKey: AUTH_STORAGE_KEY } },
    );
  }
  return browserClient;
}
