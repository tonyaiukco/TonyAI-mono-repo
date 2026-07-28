"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/report-error";

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

  return (
    <html lang="en">
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
            TonyAI is temporarily unavailable
          </h1>
          <p style={{ margin: "0 0 20px", fontSize: 14, lineHeight: 1.55, color: "#5f6b66" }}>
            The application failed to start. Your data has not been changed —
            reload the page, and if this keeps happening quote the reference below.
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
              Reference: {error.digest}
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
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
