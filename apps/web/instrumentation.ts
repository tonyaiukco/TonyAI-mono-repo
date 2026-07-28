/**
 * Server-side (and edge) Sentry init. Opt-in: without NEXT_PUBLIC_SENTRY_DSN
 * nothing initialises, so this ships and reviews now while the account/DSN
 * arrives later (Phase-2 decision, 2026-07-27).
 *
 * @sentry/nextjs is imported LAZILY and only when a DSN is set: its module
 * graph (~66 packages incl. OpenTelemetry) is heavy enough to matter for dev
 * compile memory on small machines, so without a DSN it must never load.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

let sentryReady: Promise<typeof import("@sentry/nextjs")> | null = null;

function loadSentry(): Promise<typeof import("@sentry/nextjs")> | null {
  if (!dsn) return null;
  sentryReady ??= import("@sentry/nextjs").then((Sentry) => {
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      tracesSampleRate: 0,
      // Compliance: never ship request bodies/headers — they carry tenant data.
      sendDefaultPii: false,
    });
    return Sentry;
  });
  return sentryReady;
}

export async function register(): Promise<void> {
  await loadSentry();
}

/** Report React Server Component render errors (Next.js 15+ hook). */
export const onRequestError = async (
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
): Promise<void> => {
  const sentry = await loadSentry();
  if (sentry) sentry.captureRequestError(...args);
};
