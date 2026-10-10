import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Next.js 16 renamed the `middleware` file convention to `proxy` (same runtime
// behaviour). This guards every route: unauthenticated users are redirected to
// /login, and signed-in users are bounced off /login to the dashboard.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Server-side auth check. In containers the browser-facing URL (localhost)
  // is not reachable from inside the container, so the server runtime may
  // override it via SUPABASE_URL_INTERNAL (runtime env, not build-inlined).
  const supabaseUrl =
    process.env.SUPABASE_URL_INTERNAL ||
    (process.env.NEXT_PUBLIC_SUPABASE_URL as string);

  const supabase = createServerClient(
    supabaseUrl,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    {
      // Must match the browser client's storageKey (lib/supabase.ts): the
      // default cookie name is derived from the URL host, which differs between
      // the browser (localhost) and the container runtime (host.docker.internal).
      auth: { storageKey: "sb-tonyai-auth" },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: {
            name: string;
            value: string;
            options?: Record<string, unknown>;
          }[],
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  if (!user && !matches(path, PUBLIC_PATHS)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && matches(path, SIGNED_OUT_ONLY)) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

/**
 * Reachable without a session (LP4-01): sign-in, "forgot password", and the
 * landing pages of the emailed links — `/auth/confirm` runs `verifyOtp` with
 * the link's token, and `/auth/set-password` works only with the session that
 * made (it says so when there is none). Exact paths and their sub-paths.
 */
const PUBLIC_PATHS = ["/login", "/forgot-password", "/auth/confirm", "/auth/set-password"];
/** A signed-in visitor has nothing to do here and goes to the dashboard. The
 *  email-link pages are not among them: an invitee is signed in by the link. */
const SIGNED_OUT_ONLY = ["/login", "/forgot-password"];

function matches(path: string, list: readonly string[]): boolean {
  return list.some((p) => path === p || path.startsWith(`${p}/`));
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$|.*\\.ico$).*)",
  ],
};
