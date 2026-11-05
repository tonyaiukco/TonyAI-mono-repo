# TonyAI: Observability guide

> Moved from [`README.md`](../../README.md) on 2026-11-05 (OpenSpec change `refactor-readme`); the text is unchanged.

## Observability

The API emits **one structured JSON line per request** to stdout — the shape every log aggregator (Cloud Logging, Loki) expects from a container:

```json
{"ts":"2026-07-27T17:31:24.008Z","level":"info","msg":"request","requestId":"5c39d54a-…","method":"GET","path":"/api/v1/subsidiaries","status":200,"durationMs":2,"userId":"62db344f-…"}
```

- **Request ids** — an inbound `x-request-id` is honoured (so a load balancer's trace id stays stitched to our logs), otherwise one is minted. It is echoed in the response header (CORS‑exposed) and attached to every log line of that request via `AsyncLocalStorage`.
- **Levels** — 4xx are expected business outcomes (a blocked submit gate, a 403) and log at `warn`; unexpected 5xx and unhandled throws log at `error` with a stack and go to stderr. Expected `/health/ready` 503 responses neither log request errors nor create Sentry events.
- **A batch writes one line, not one per row** — the bulk importer and bulk submit map every failure they understand onto a row-level code in the response and log nothing for it. What they do NOT understand is folded into a single `error` line per request by `BatchFailureLog` (`apps/api/src/common/batch-failure-log.ts`): the count, the first ten rows or record ids plus a count of the rest, the **first** failure (class, driver code and a cleaned sample of its message) and **one** stack — a later failure of a different class is counted and named by row but not described; which rows failed is in the response. Logging each row instead measured 148,542 bytes of stderr for a 50-row file whose every row tripped the same driver error, which the 1,000-row cap puts near 3 MB for one request; the aggregate is bounded (ten refs, one 240-code-point sample, thirty 200-character stack lines). The sample and the stack pass through `sanitiseCallerText` — a Prisma parse failure quotes the character it choked on — the stack **line by line**, so its newlines survive the cleaning that would otherwise fold thirty frames into one run.
- **`LOG_FORMAT`** — `pretty` (default in dev) or `json` (default in production).
- **Storage sweeper** — each pass that finds work logs one line: `Storage sweep: removed N, failed N, kept N, abandoned N; waiting N delete(s), N upload(s), N stuck, oldest <ts>` (`info`; `error` when a removal failed or an intent named bytes a row owns; `warn` while `STORAGE_CLEANUP_HOLD` holds work back). An intent that has failed five times or more is **stuck**: logged at `error` and sent to Sentry once each time the stuck count changes. A row whose bytes are missing answers its download with a 404 ("This file's contents are missing from storage…"), logged at `error` and sent to Sentry — never a 500, never silent.
- **Sentry** is opt‑in: without `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` the SDK is never initialised and every capture is a no‑op. `sendDefaultPii` alone does not prevent request capture. The API disables incoming body buffering, excludes request headers/cookies/body/query data, applies a final request allowlist (method and queryless URL), strips query strings from path tags, and drops HTTP/fetch breadcrumbs. API transaction telemetry is forced off. The real-SDK multipart regression exercises an in-request 500 with a Bearer token, cookie, query and file bytes through `initSentry()` and inspects captured envelopes. Do not enable a DSN with real tenant data until these protections ship and pass review; follow runbook 06. These API guarantees do not establish web SDK privacy or sanitise arbitrary exception messages.
- **Uptime targets** once a staging URL exists: `GET /api/v1/health/ready` (public dependency availability) and `GET /login`; use `/api/v1/health` only for process liveness and `/api/v1/health/synthetic` with a dedicated synthetic token for authenticated readiness.

The web app has route (`error.tsx`), root (`global-error.tsx`) and 404 boundaries; client errors report to Sentry when a DSN is configured.
