---
name: factor-release-import
description: Load, correct or withdraw an emission-factor release in TonyAI's factor library — a release file in the import contract's shape (FactorReleaseImport), checked by validateFactorReleaseImport, loaded whole and sealed in one transaction by the factor-release loader CLI as the tonyai_factor_loader role, an erratum as a new edition that withdraws what it corrects, a dry run before every --apply. Use when factor values reach the library (an authoritative edition, an erratum, a withdrawal, a fixture for a test). Not for the local placeholder seed (packages/db/prisma/factor-library.ts) or for calculation code (calculations/).
---

# factor-release-import

The factor library is what every tenant's figures are priced from, and a
committed snapshot cites its release forever. So it has **one writer** — the
loader, `pnpm --filter @tonyai/api factor-release`, connecting as the database
role `tonyai_factor_loader` — and every release it writes is **checked, whole,
and sealed**. The **canonical reference** is LP4-02 PR B1:
`apps/api/src/factor-releases/` (the CLI and `FactorReleaseLoader`), the
migration `20261011120000_lp4_02_loader` (the seal, the role, its guards) and
`apps/api/test/int/factor-release-loader.int.spec.ts`.

## When to use

- An owner-approved source edition is ready to load (UK DESNZ, a TR grid factor…).
- A loaded edition was found wrong: an **erratum** (a corrected edition) or a **withdrawal**.
- A test needs a factor the seed does not hold: a **fixture** release.

## Rules (must hold)

1. **Never invent a value.** Every factor and conversion comes from the cited
   publication, with its sheet/table/row in `source` and the arithmetic from the
   publisher's own quote in `methodology`. A release under a publisher not in
   `FACTOR_PUBLISHERS` is refused by the contract and by the database; a real
   publisher is registered only after the owner records its source, edition and
   licence (decision L6) — that is a contract change (`@tonyai/shared-types`
   and the CHECK, together), not a loader flag.
2. **The file is the contract's shape** (`FactorReleaseImport`): `release`,
   `factors[]`, `conversions[]`. An authoritative release carries `sourceUrl`
   (https), `licence`, `publishedAt`, `reviewedBy` (a firm or role) and
   `reviewedAt` (after publication), and its `gwpSet` — **one GWP set per
   inventory year** (D09), the set the sources declare. A factor is quoted per
   ONE base unit of its family (`normalizedUnit` = `DIMENSION_BASE_UNIT`), its
   `factorUnit` is `factorUnitFor(normalizedUnit)`; a factor's `version` is set
   by the loader to the release's edition.
3. **Dry run first, every time.** Without `--apply` the loader validates the
   file, checks the database and prints what it would do; nothing is written.
   Read the report: the release, the row counts, the edition it supersedes.
4. **Whole and sealed.** `--apply` loads the release, its rows and its seal in
   one transaction; a sealed release takes no row and is never unsealed, and the
   database refuses a commit that leaves a release unsealed. There is no
   "append a missing row": a missing row is an erratum.
5. **An erratum is a new edition** with the next ordinal (it must exceed every
   ordinal the publisher has), loaded with `--supersedes=<old edition>
   --reason=<why>`: the old edition is withdrawn in the same transaction, so
   there is never a moment with two live editions or none. A withdrawn release
   never prices a new record; committed snapshots keep citing it.
6. **`--operator` names a firm or a role, never a person** — it is recorded as
   the actor of every event in `factor_release_events` and as a withdrawal's
   `withdrawn_by`.
7. **Only the loader's login.** `FACTOR_LOADER_DATABASE_URL` logs in as
   `tonyai_factor_loader`; the loader refuses the owner, the runtime role and
   anything else. Off a loopback database `--apply` needs `--allow-remote`.
   In a deployed environment the login never reaches the API's environment or
   its Key Vault references, and the role goes back to `NOLOGIN` between loads.
8. **A load moves every draft.** Submit and approve recompute a draft's figure
   with the current library and refuse a stale one (`calculation_stale`, K11 —
   from LP4-02 PR B2): tell the users whose drafts it touches to save them again.
9. **Fixtures are labelled.** A test release is published by
   `INTERNAL_FACTOR_PUBLISHERS.fixture` with status `fixture`, and its title,
   `methodology` and `source` say it is not an emission factor; it is removed
   by its test (the fixture publisher's releases are the only deletable ones).

## Steps

1. Write the release file (JSON) from the publication: one `factors[]` row per
   (category, activity type, gas, geography, year, Scope 2 method, calorific
   basis, unit) and one `conversions[]` row per sourced conversion step.
2. Locally: `set -a; source apps/api/.env; set +a`, and give the loader a
   login once — `read -rs FACTOR_LOADER_DB_PASSWORD && export FACTOR_LOADER_DB_PASSWORD`,
   `DIRECT_URL=<owner url> node packages/db/scripts/runtime-role.mjs provision-loader`,
   then export `FACTOR_LOADER_DATABASE_URL` (the owner URL with the loader's
   user and password). On staging or production the owner provisions it per
   environment (the rotation runbook).
3. `pnpm --filter @tonyai/api build`, then the dry run:
   `pnpm --filter @tonyai/api factor-release load --file=<release.json> --operator=<firm or role>`.
   Fix every issue it lists — it refuses the whole file while one stands.
4. `--apply`. Re-running the same command is a no-op (`already_loaded`); other
   content under a loaded edition is refused.
5. An erratum: the corrected file with the next ordinal and a new edition,
   `--supersedes=<old edition> --reason=<why>`. A withdrawal with no
   replacement: `factor-release withdraw --publisher=<name> --edition=<edition> --reason=<why> --operator=<firm or role>`.
6. Check: `DATABASE_URL=<owner url> node packages/db/scripts/runtime-role.mjs check`
   (the library's record reconciles through the owner) and the release in
   `GET /api/v1/factors`.

## Skeleton

```json
{
  "release": {
    "publisher": "TonyAI test fixture", "title": "Example fixture — not a source", "edition": "example-1",
    "ordinal": 1, "status": "fixture", "sourceUrl": null, "licence": null, "publishedAt": null,
    "gwpSet": null, "reviewedBy": null, "reviewedAt": null, "notes": "A test fixture. Not a source."
  },
  "factors": [{
    "category": "Natural Gas", "activityType": "natural_gas", "gas": "CO2e", "gasCoverage": "all_ghg",
    "geographyCode": "UK", "reportingYear": 2031, "dataYear": 2031, "scope": 1,
    "factorValue": 0.2, "factorUnit": "kgCO2e/kWh", "normalizedUnit": "kWh",
    "calorificBasis": "gross", "scope2Method": "not_applicable",
    "methodology": "FIXTURE — not a methodology", "source": "FIXTURE — not a real emission factor"
  }],
  "conversions": []
}
```

The values above are a labelled fixture's, not a source's. An authoritative
release replaces every one of them from the publication.

## Verify

- Unit: `apps/api/src/factor-releases/*.spec.ts` — arguments, the remote guard,
  the file cap, the contract called with no options, the column-by-column map.
- Integration (`pnpm --filter @tonyai/api test:int`, alone):
  `factor-release-loader.int.spec.ts` (load, re-run, erratum, withdrawal, the
  wrong login) and `factor-model.int.spec.ts` (the seal, the loader's bounds,
  the service role refused). `pnpm rls:probe` checks the role and every other
  library writer.
