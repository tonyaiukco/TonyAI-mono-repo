# Proposal

## Why

The sealed calculation spec v2.4 (§1.1) says that a calculation the factor library cannot cover fails closed with **HTTP 422**. The API answers **404** instead. A 404 tells a client the resource does not exist, yet the record, the route and the subsidiary all exist; it is the request that cannot be processed against the library. The owner decided on 2026-11-20 to follow the spec (Decisions 2026-11-20, D4; `uat3-decisions`).

This ships ahead of the natural-gas kWh work (LP4-06), so that work is written against the final status.

## What Changes

- **BREAKING (API status code):** the four coverage refusals answer **422 Unprocessable Entity** instead of 404:
  - `no_factor`
  - `placeholder_refused`
  - `no_conversion`
  - `calorific_basis_mismatch`

  Their `code`, `message` and `coverage` fields are unchanged.
- **Unchanged statuses:**
  - Input refusals stay **400**.
  - Library conflicts stay **409** (`ambiguous_factor`, `factor_scope_mismatch`, `parameter_missing`).
  - A subsidiary, location or record the caller cannot reach still answers the plain **404** with nothing about the library, the tenant-isolation rule.
- **The status map and the thrown exception change together, in one commit.** The API's error filter keeps a code only when the status it was thrown with matches the registry. A map changed alone would therefore strip every coverage code down to a generic one.
- **The preview is unaffected.** `POST /calculations/preview` already answers 200 with the "not calculated" shape for an invoice-tracked category without a factor. It refuses exactly as before, only with the new status.
- **Docs:**
  - `docs/api/endpoints.md` states the status for each refusal family;
  - `docs/architecture/localisation.md` keeps its error-body note accurate.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `emission-calculation`: adds a requirement that coverage refusals answer 422, input refusals 400 and library conflicts 409, while an unreachable reporting entity stays a plain 404.

## Impact

- **API:**
  - `apps/api/src/calculations/errors.ts`: `NoEmissionFactorError` and its comment;
  - `packages/shared-types/src/index.ts`: `CALCULATION_REFUSAL_STATUS` and the `CalculationRefusalBody.statusCode` union.
- **Tests:**
  - `apps/api/src/calculations/errors.spec.ts`, `calculations.service.spec.ts`;
  - `apps/api/src/common/api-error.spec.ts`;
  - `apps/api/src/activity-records/activity-records.service.spec.ts`;
  - any integration spec asserting the coverage status.

  Tests that assert the tenant 404 must stay green unchanged.
- **Web:** no behaviour change. Screens key on `code`, not status, and the one status check in `lib/api.ts` is for `registration_unavailable`. A web unit test that builds a coverage `ApiError` with 404 is updated to 422 for accuracy.
- **Bulk upload:** unchanged. It tells a coverage refusal from a missing entity by exception class, not by status, and bulk submit wraps refusals as stale.
- **Clients:** no external client exists before the pilot.
- **Deploy:** an image change. The QA deploy runs on merge.
