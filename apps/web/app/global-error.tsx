"use client";

import { useEffect, useSyncExternalStore } from "react";
import { createTranslator } from "use-intl/core";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n/locale";
import type { Locale } from "@/lib/types";
import { reportError } from "@/lib/report-error";
import enCommon from "@/messages/en/common.json";
import trCommon from "@/messages/tr/common.json";

/**
 * Last-resort boundary: catches errors thrown by the root layout itself, so it
 * must render its own <html>/<body> and cannot use the app's providers or
 * shadcn components (they live inside the layout that just failed).
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    reportError(error);
  }, [error]);
  // English on the server and in the first client render (so hydration
  // matches), then the cookie's language.
  const locale = useSyncExternalStore(noSubscription, clientLocale, () => "en" as const);
  const t = globalErrorCopy(locale);

  return (
    <html lang={locale}>
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f7f9f8",
          color: "#1a1f1d",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 420,
            padding: "28px 32px",
            background: "#fff",
            border: "1px solid #e2e8e5",
            borderRadius: 14,
          }}
        >
          <h1 style={{ margin: "0 0 8px", fontSize: 20, color: "#059669" }}>
            {t("title")}
          </h1>
          <p style={{ margin: "0 0 20px", fontSize: 14, lineHeight: 1.55, color: "#5f6b66" }}>
            {t("description")}
          </p>
          {error.digest && (
            <p
              style={{
                margin: "0 0 20px",
                padding: "8px 12px",
                background: "#eef2f0",
                borderRadius: 8,
                fontFamily: "ui-monospace, Menlo, monospace",
                fontSize: 12,
                color: "#5f6b66",
              }}
            >
              {t("reference", { digest: error.digest })}
            </p>
          )}
          <button
            onClick={() => window.location.reload()}
            style={{
              width: "100%",
              padding: "10px 16px",
              background: "#059669",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("reload")}
          </button>
        </div>
      </body>
    </html>
  );
}

/**
 * The layout's provider is gone, so the language is resolved here as the
 * layout would: the locale cookie, else the browser's languages, else English.
 * Only `common` is imported, not the whole catalogue.
 */
function clientLocale(): Locale {
  const cookie = document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${LOCALE_COOKIE}=`))
    ?.slice(LOCALE_COOKIE.length + 1);
  return resolveLocale(cookie, navigator.languages?.join(","));
}

function noSubscription(): () => void {
  return () => {};
}

function globalErrorCopy(locale: Locale) {
  const messages = { common: locale === "tr" ? trCommon : enCommon };
  return createTranslator({ locale, messages, namespace: "common.globalError" });
}
