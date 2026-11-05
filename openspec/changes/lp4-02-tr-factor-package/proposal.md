## Why

The calculation engine can price nothing authoritatively: the factor library holds only placeholder and fixture releases, and its publisher registry admits no real publisher. On 2026-11-04 the owner and the COO delivered the pilot's Turkish factor package (`docs/md_docs/Revision MD.md`, sealed edition `TONYAI-EF-TR-UK-2026.11-AR6-SEALED`), and on 2026-11-05 the owner decided to proceed from it alone, for Türkiye only. Loading it, and adding the inputs it assumes, closes LP4-02 and unblocks the pilot's numbers.

## What Changes

- Commit the reviewer-signed Turkish source document as the package's original, under a new language exception in `CLAUDE.md` and `AGENTS.md` (owner decision 2026-11-05, 1.b).
- Register two real publishers, IPCC and the Turkish Ministry of Energy and Natural Resources (ETKB), in the factor library's closed registry (a migration). Remove the import's `testPublishers` stand-in.
- Settle LP4-02 follow-up (12): the loader refuses a second live edition that overlaps an existing one unless it supersedes it.
- Add release-carried **calculation parameters**: sourced, sealed values that are not emission factors (the equipment leak rates and the reference calorific values, gross 9,155 and net 8,250 kcal/Sm³), loaded and snapshotted like factors.
- Extend the Scope 1 source catalogue to the pilot's inventory:
  - **Fuel** (stationary): petrol, coal and LNG; the `kg` unit.
  - **Mobile Combustion**: five vehicle modes (on-road petrol, diesel and LPG; off-road petrol and diesel).
  - **Refrigerants**: HFC-227ea (FM200), SF6 and R-22.
  - A new **Fugitive Gas** category for gas-network leakage, in standard cubic metres.
- Add **per-record calculation inputs** the package requires:
  - natural gas: an editable net calorific value (default 8,250 kcal/Sm³), an optional billed gross calorific value, and a volume correction factor for metered m³;
  - refrigerants: per equipment type, an installed capacity, an optional alternative leak rate and a refilled mass, calculated as `Σ (capacity × leak rate + refill) × GWP` on an annual record whose `kg` quantity is the total capacity.
- Keep retained report datasets issuable: a new dataset schema version carries the new category, an older dataset keeps the categories it was captured under, and a version confirmed before Fugitive Gas existed yields a partial until a new version decides it.
- Load two authoritative TR releases (IPCC-based fuels and gases; ETKB grid electricity) for reporting years 2024–2026, with every derivation in the row's methodology. Years before 2024 stay fail-closed.
- Pin the document's golden values as tests, within its ±0.5% tolerance. There are nine rows in its §5 CSV; the owner's "close on the 8" referred to this set.
- Reports print "No market-based result" beside Scope 2 when no market-based figure exists.
- Record the owner's 2026-11-05 decisions in the planning file.

Out of scope:
- UK factors (the owner's TR-only decision).
- Certificate inputs (I-REC, YEK-G, REGO) and on-site solar self-consumption.
- The UAT round-1 UI findings BUG-01..10, including the year-list range; they are a separate work package.
- Loading into hosted QA before L10 closes.

## Capabilities

### New Capabilities
- `emission-factor-library`: authoritative releases. Covers publishers, sealed releases with their calculation parameters, edition overlap, the TR package's coverage and its fail-closed years.
- `emission-calculation`: how a record becomes kgCO2e. Covers the natural gas chain with its per-record calorific inputs, liquid and solid fuels, mobile modes, gas-network leakage, the refrigerant capacity method, snapshots and the golden values.
- `activity-data-entry`: the inputs a user supplies for the new categories, types and parameters, on the Data Entry form and in bulk upload.

### Modified Capabilities
None. `openspec/specs/` holds no capability yet.

## Impact

- **Contract** (`packages/shared-types`): categories, units, activity types, `CalculationInput`, the snapshot type (a new version; old snapshots stay readable and unchanged) and the import contract (parameters, publishers).
- **Database** (`packages/db`): migrations for the publisher CHECK, the category and activity-type CHECKs, a parameters table under the release seal, and per-record parameter storage. Also the runtime-role md5 pins and the parity specs.
- **API**: the calculation service, the factor-release loader, bulk upload and report issuance.
- **Web**: the Data Entry form and the TR/EN catalogues.
- **Data and docs**: two release files and the golden tests; README, calculation_logic.md and the factor-release-import skill.
- **Sequencing:**
  - "QA deploy" was re-enabled on 2026-11-05 (owner decision), so each PR deploys to hosted QA as it merges, migrations included.
  - Once PR2 deploys, the L10 rollback drill can no longer move to ci4-1 (refused across a migration). L10 rehearses the same-image fallback only.
  - Nothing loads into hosted QA until L10 closes.
  - Risky PRs (calculation path, factor immutability, schema and contract) get the `security-rls`, `qa-auditor` and `architect` review pass.
