# Design

## Context

See `proposal.md`. This section records the current state, checked on `main` at `a9fbd00d`.

- **The registry.** `CALCULATION_REFUSAL_STATUS` (shared types) maps the coverage codes to 404, typed `400 | 404 | 409`. `API_ERROR_STATUS` merges it with the generic and domain codes. `CalculationRefusalBody.statusCode` is typed `400 | 404 | 409`.
- **The thrown class.** `NoEmissionFactorError` (`apps/api/src/calculations/errors.ts`) `extends NotFoundException` and builds a 404 body. Its comment says the class is the contract that lets the bulk importer tell "cannot be priced yet" from "not yours", which are both 404 today.
- **The filter.** `toErrorBody` (`apps/api/src/common/api-error.ts`) keeps a code only when `API_ERROR_STATUS[code] === status`; otherwise it substitutes the status's generic code. `STATUS_TEXT` already has 422 ("Unprocessable Entity"), and `query_too_broad` already answers 422.
- **Who reads the class or the status:**
  - `bulk-upload.service.ts` checks `instanceof NoEmissionFactorError || FactorLibraryConflictError` before `instanceof NotFoundException`, so its row issue stays `no_factor`.
  - `bulk-submit.service.ts` checks `CalculationStaleError` first, because submit raises a recompute refusal as that class, and only later `instanceof NotFoundException` → `not_found`. A raw `NoEmissionFactorError` reaching that point would read as `not_found` today; after this change it would fall through to the next branches.
  - No web code keys on 404 for these codes: `describeApiError` keys on `code`.
  - No e2e spec asserts their status. `e2e/gates.spec.ts` gets 200 from the preview, by design.
- **Tests that name the 404:**
  - `errors.spec.ts`: the body's `statusCode: 404`;
  - `api-error.spec.ts`: `toErrorBody(404, { code: 'no_factor', … })`;
  - `calculations.service.spec.ts`: a `statusCode: 404` body and "keeps the 404 when only the diagnostic pass … exceeds the cap";
  - `activity-records.service.spec.ts`: case labels "(404)";
  - `apps/web/lib/i18n/errors.spec.ts`: `new ApiError("API 404", 404, "no_factor")`.

  The tenant-isolation tests (`factor-model.int.spec.ts`, "answers a foreign subsidiary with the plain 404") must stay unchanged.

## Goals / Non-Goals

**Goals:**
- Coverage refusals answer 422 everywhere they surface: create, update, record preview and submit's recompute, keeping the code, message and `coverage`.
- No change to 400s, 409s, or the plain 404 for unreachable entities.

**Non-Goals:**
- New codes, new messages, or any change to which input triggers which refusal.
- The natural-gas kWh path (LP4-06), which builds on this.

## Decisions

### D1 — Change the base class and the map in one commit

`NoEmissionFactorError` extends `UnprocessableEntityException` and builds `{ statusCode: 422, error: 'Unprocessable Entity', … }`. The four entries in `CALCULATION_REFUSAL_STATUS` become 422. Both status unions become `400 | 409 | 422`: no calculation refusal answers 404 any more, so 404 leaves the union (the build narrowed it, where the plan had only widened it; typecheck confirms that no consumer needed 404). `packages/shared-types/src/factor-model.spec.ts`, which pins every refusal status, moves to 422 as well.

**Why together:** with only the map changed, a thrown 404 carrying `no_factor` would hit the filter's mismatch rule and lose its code. With only the class changed, a 422 carrying `no_factor` would lose it the same way. The specs check each half against the other.

**Rejected:** a custom filter branch that rewrites 404→422 for these codes. That is a second source of truth beside the registry.

### D2 — Keep the class as the bulk importer's contract; harden bulk submit

The comment on `NoEmissionFactorError` is rewritten: the class, not the status, is how the importer separates a library gap from a foreign entity. The status difference (422 against 404) now says the same thing on the wire.

In `bulk-submit.service.ts`, an explicit `NoEmissionFactorError` / `FactorLibraryConflictError` branch is added before the `NotFoundException` fallback. It maps to `calculation_stale`, the code submit already gives a recompute refusal, so a refusal that escapes the wrapper can never read as `not_found` or `unexpected`. A unit test throws a raw `NoEmissionFactorError` from the submit path and asserts that code.

### D3 — Docs

- `docs/api/endpoints.md`: one sentence in the factor-model paragraph (line ~124) giving the status of each refusal family. It also corrects any line that says a coverage refusal is a 404.
- `docs/architecture/localisation.md` ("Error body"): unchanged in substance. It is checked so it does not imply 404 for these codes.

## Risks / Trade-offs

- **A client that treated 404 as "no factor" now sees 422** → no external client exists before the pilot. The web keys on `code`. The API doc states the change.
- **A catch somewhere relies on `NotFoundException` for a coverage refusal** → the only two such catches are the bulk services. The importer checks the class first, and D2 adds the same guard to submit. A repo-wide `grep` for `instanceof NotFoundException` is part of the verification.
- **Logs, metrics or alerts that count 404s** → coverage refusals move to the 422 count. Nothing in the repo alerts on either today, and Sentry captures 5xx only.

## Migration Plan

This is a code-only change with no migration. It deploys with the image and rolls back by reverting the commit. Nothing persisted stores the status.
