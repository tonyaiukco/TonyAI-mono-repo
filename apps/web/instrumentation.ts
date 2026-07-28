/**
 * Server-side (and edge) Sentry init. Opt-in: without NEXT_PUBLIC_SENTRY_DSN
 * nothing initialises, so this ships and reviews now while the account/DSN
 * arrives later (Phase-2 decision, 2026-07-27).
 *
 * The SDK is imported LAZILY and typed STRUCTURALLY (never
 * `typeof import("@sentry/nextjs")`) so the Sentry/OpenTelemetry declaration
 * graph stays out of the web app's TypeScript program and out of the dev
 * server's eager module graph while Sentry is disabled.
 */
type SentryServerApi = {
  init(options: Record<string, unknown>): void;
  captureRequestError(error: unknown, request: unknown, context: unknown): void;
};

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

let sentryReady: Promise<SentryServerApi> | null = null;

function loadSentry(): Promise<SentryServerApi> | null {
  if (!dsn) return null;
  sentryReady ??= import("@sentry/nextjs").then((mod) => {
    const sentry = mod as unknown as SentryServerApi;
    sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      tracesSampleRate: 0,
      // Compliance: never ship request bodies/headers — they carry tenant data.
      sendDefaultPii: false,
    });
    return sentry;
  });
  return sentryReady;
}

export async function register(): Promise<void> {
  await loadSentry();
}

/** Report React Server Component render errors (Next.js 15+ hook). */
export async function onRequestError(
  error: unknown,
  request: unknown,
  context: unknown,
): Promise<void> {
  const sentry = await loadSentry();
  sentry?.captureRequestError(error, request, context);
}
