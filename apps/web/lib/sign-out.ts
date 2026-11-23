import { useAuthStore, useReportingContextStore } from "./store";
import { getSupabaseBrowserClient } from "./supabase";

/**
 * Signs this browser out and forgets who was signed in: the signed-in user
 * and their remembered reporting context, whatever the sign-out answers. Every
 * page's Sign out goes through here; the store used to keep the previous
 * user's role until the next page load (pre-pilot defects).
 */
export async function signOutHere(): Promise<void> {
  try {
    await getSupabaseBrowserClient().auth.signOut();
  } finally {
    useAuthStore.getState().clear();
    useReportingContextStore.getState().clear();
  }
}
