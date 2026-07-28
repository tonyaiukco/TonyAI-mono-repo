/**
 * Single seam for client-side error reporting.
 *
 * Sentry is loaded LAZILY and only when NEXT_PUBLIC_SENTRY_DSN is set. That
 * matters beyond bundle size: the error boundaries render on every route, so a
 * static `import * as Sentry from "@sentry/nextjs"` in them pulled the whole
 * Sentry/OpenTelemetry graph into the client bundle AND into the dev server's
 * eager compile — memory the dev machine could not spare while Sentry is off.
 *
 * Typed structurally on purpose: a `typeof import("@sentry/nextjs")` annotation
 * would drag the same declaration graph back into the TypeScript program.
 */
type SentryCapture = { captureException(error: unknown): void };

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

/** Report an error to Sentry; a no-op until a DSN is configured. */
export function reportError(error: unknown): void {
  if (!dsn) return;
  void import("@sentry/nextjs").then((mod) => {
    (mod as unknown as SentryCapture).captureException(error);
  });
}
