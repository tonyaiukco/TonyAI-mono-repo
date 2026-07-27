import * as Sentry from "@sentry/nextjs";

/**
 * Server-side (and edge) Sentry init. Opt-in: without NEXT_PUBLIC_SENTRY_DSN
 * nothing initialises, so this ships and reviews now while the account/DSN
 * arrives later (Phase-2 decision, 2026-07-27).
 */
export async function register() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: 0,
    // Compliance: never ship request bodies/headers — they carry tenant data.
    sendDefaultPii: false,
  });
}

/** Report React Server Component render errors (Next.js 15+ hook). */
export const onRequestError = Sentry.captureRequestError;
