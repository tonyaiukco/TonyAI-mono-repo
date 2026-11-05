# emission-factor-library Specification

## Purpose
The emission-factor library holds the sourced, versioned, sealed releases that every calculation is priced from, and refuses anything it cannot cite.

## Requirements

### Requirement: Closed publisher registry with the TR publishers
The library SHALL admit releases only from registered publishers. The registry SHALL contain the two internal publishers plus `IPCC` and `ETKB` (Republic of Türkiye Ministry of Energy and Natural Resources). The import contract and the database SHALL refuse every other name, including look-alikes. The import SHALL NOT accept a caller-supplied list of extra publishers.

#### Scenario: A registered TR publisher is accepted
- **WHEN** a release file names publisher `ETKB` with its source URL and licence
- **THEN** the dry run reports no publisher issue

#### Scenario: An unregistered publisher is refused before the database
- **WHEN** a release file names publisher `DESNZ`
- **THEN** the dry run reports an unregistered-publisher issue and nothing is written

### Requirement: Sealed calculation parameters
A release SHALL be able to carry calculation parameters next to its factors. A parameter is a sourced, non-factor value with a key, value, unit, source and methodology, for example an equipment leak rate or a reference calorific value. Parameters SHALL be loaded, sealed and withdrawn together with their release. Parameters SHALL be immutable after the seal, in the same way as factors. Each key SHALL have one registered unit: a leak rate is a fraction of at most 1, and a reference calorific value is in kcal/Sm³. Every value SHALL be positive, and an alternative rate SHALL have a default beside it.

#### Scenario: A parameter cannot be added after the seal
- **WHEN** a writer inserts a parameter row into a sealed release
- **THEN** the database refuses the write

#### Scenario: A rate in the wrong unit
- **WHEN** a release file quotes a leak rate as `2` or in `%`
- **THEN** the loader refuses the whole file and writes nothing

#### Scenario: A leak rate is read from the release, not from code
- **WHEN** a refrigerant record names equipment type `fire_suppression_system`
- **THEN** its calculation uses that release's leak-rate parameter (0.02) and the snapshot cites the parameter's release and source

### Requirement: One live edition per publisher, coverage and year
The loader SHALL refuse a release whose rows overlap a live release from the same publisher, unless the new release supersedes that release. An overlap means the same category, activity type, geography, reporting year, gas and scope-2 method. This rule prevents an erratum to an older edition from outranking a newer edition.

#### Scenario: Overlapping edition without supersession
- **WHEN** a second live ETKB edition is loaded that also covers TR grid electricity for 2025, and it does not name `--supersedes`
- **THEN** the loader refuses it and writes nothing

### Requirement: TR factor package coverage
The library SHALL hold the owner-approved TR package for reporting years 2024, 2025 and 2026, as delivered in `docs/md_docs/Revision MD.md` and decided on 2026-11-05. The package SHALL use AR6 as its GWP set. Every value SHALL be taken from the document as written, with any derivation stated in the row's methodology. `reviewedBy` SHALL be "TonyAI Sustainability Team".

The package covers:
- **Grid electricity (location-based, ETKB):**

  | Reporting year | kgCO2e/kWh | data year |
  |---|---|---|
  | 2024 | 0.442 | 2023 |
  | 2025 | 0.434 | 2024 |
  | 2026 | 0.434 | 2024 |
- **Natural gas:** IPCC CO2 56,100, CH4 1.0 and N2O 0.1 kg/TJ on the net basis.
- **Stationary fuels:** diesel and petrol per litre; LPG, coal, LNG and fuel oil per kg. Each uses the document's density, net calorific value and IPCC factors.
- **The five mobile modes** per litre, computed from the document's formula.
- **Gas-network leakage:** CH4 only, GWP 29.8.
- **Refrigerant and suppression gases:** the document's AR6 GWPs.
- **Leak rates:** the nine equipment leak rates and their two alternatives.
- **Reference values:** the reference gross calorific value of 9,155 kcal/Sm³ and the reference net calorific value of 8,250 kcal/Sm³.

#### Scenario: A year without coverage fails closed
- **WHEN** a TR record for reporting year 2023 is calculated
- **THEN** it is refused with `no_factor` and no figure is stored

#### Scenario: The 2026 grid row declares its lag
- **WHEN** a 2026 TR electricity record is calculated
- **THEN** its snapshot shows factor 0.434 kgCO2e/kWh, data year 2024 and a declared fallback year policy

#### Scenario: UK is not covered
- **WHEN** a UK record is calculated with placeholders disallowed
- **THEN** it is refused with `no_factor`

### Requirement: Source document is the package's signed original
The reviewer-signed source document SHALL be kept in the repository unchanged, as the citation every TR row's `source` points to. It is in Turkish under the owner's 2026-11-05 exception. A correction to the package SHALL be a new edition loaded as an erratum. Rows of a loaded release SHALL NOT be edited.

#### Scenario: A correction arrives
- **WHEN** the reviewer corrects a TR value
- **THEN** a new edition with the next ordinal supersedes the old one, and snapshots already committed keep citing the old edition
