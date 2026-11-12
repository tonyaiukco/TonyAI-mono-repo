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

### Requirement: Supplementary IPCC edition for marine gas oil
The library SHALL hold a separate IPCC release for marine gas oil (MGO), beside the TR package and not superseding it. It SHALL cover TR for reporting years 2024, 2025 and 2026, priced per kilogram, with a row for each of CO2e, CO2, CH4 and N2O, on AR6. Each row SHALL cite the IPCC 2006 tables it comes from, never the TR package document, and SHALL state its derivation in its methodology.

#### Scenario: Loaded beside the TR package
- **WHEN** the MGO edition is dry-run and then loaded while the TR package's IPCC release is live
- **THEN** the loader reports no overlap, both releases stay live, and no TR package row changes

#### Scenario: A row cites its own source
- **WHEN** an MGO factor row is read
- **THEN** its source names IPCC 2006 Vol. 2 (water-borne navigation and the default net calorific value), and it does not cite `docs/md_docs/Revision MD.md`

#### Scenario: A year without coverage fails closed
- **WHEN** a TR MGO record for a reporting year outside 2024–2026, such as 2027, is calculated
- **THEN** it is refused with `no_factor` and no figure is stored

### Requirement: MGO edition review record
The MGO edition SHALL name "TonyAI Sustainability Team" as its reviewer, and SHALL be loaded as authoritative only after the owner's approval is recorded in the status file's Decisions log. Its values SHALL be listed for the external carbon reviewer's check before G4. A correction SHALL be a new edition that supersedes it, never an edit to a loaded row.

#### Scenario: A reviewer corrects an MGO value
- **WHEN** the external reviewer rejects an MGO value
- **THEN** a new IPCC edition with the next ordinal supersedes the MGO edition, and committed snapshots keep citing the old one

### Requirement: The library reports its coverage
The API SHALL report, to any signed-in user, each geography and reporting year that holds at least one factor the calculation engine could read: the CO2e row, in its category's own Scope 2 method, in a sealed, non-withdrawn release. Each entry SHALL name the statuses of the releases behind it: authoritative, placeholder or fixture. Withdrawn releases SHALL never count. The report SHALL carry no factor value and nothing about a release beyond its status.

#### Scenario: Pilot library
- **WHEN** the library holds only the authoritative TR releases for 2024–2026
- **THEN** the report lists TR for 2024, 2025 and 2026, each marked authoritative, and nothing else

#### Scenario: A withdrawn release
- **WHEN** a release is withdrawn and no other live release covers its geography and year
- **THEN** that geography and year disappear from the report

#### Scenario: A market-based factor only
- **WHEN** a geography and year hold only a market-based electricity factor, which the pilot never prices (location-based only, D08)
- **THEN** that geography and year are absent from the report

#### Scenario: A market-based factor beside a placeholder location-based one
- **WHEN** placeholder factors are allowed and a geography and year hold an authoritative market-based electricity factor and a placeholder location-based one
- **THEN** the report lists that geography and year marked placeholder only

#### Scenario: No library
- **WHEN** the library holds no sealed, live release
- **THEN** the report is an empty list, not an error

### Requirement: Coverage follows the pricing policy
The coverage report SHALL count placeholder and fixture releases only when the calculation engine may price from them, which is when non-authoritative factors are allowed. Where they are refused, the report SHALL list authoritative coverage only, so it never claims a geography or year that the engine would refuse.

#### Scenario: Placeholders refused
- **WHEN** placeholder factors are refused and the library holds placeholder UK rows for 2026
- **THEN** UK 2026 is absent from the report

#### Scenario: Placeholders allowed
- **WHEN** placeholder factors are allowed and the library holds placeholder UK rows for 2026 and no authoritative ones
- **THEN** the report lists UK 2026 marked placeholder only

### Requirement: The library lists its sealed releases with their seal date
The API SHALL list the library's sealed releases to any signed-in user, whatever their role or organisation. The list SHALL include withdrawn releases, because past figures still cite them. It SHALL NOT include a release that is not sealed.

Each release SHALL carry its seal date: the time the database recorded when the release was sealed. The API SHALL NOT take the seal date from the release file or from any user input.

Listing releases SHALL change nothing. It SHALL write no audit row.

#### Scenario: A data entry user lists releases
- **WHEN** a data_entry user requests the release list
- **THEN** each sealed release is returned with its publisher, edition, status and seal date

#### Scenario: A withdrawn release is still listed
- **WHEN** a sealed release has been withdrawn by an erratum
- **THEN** it is still listed, with its seal date and its withdrawn status

#### Scenario: An unauthenticated request
- **WHEN** a request without a valid session asks for the release list
- **THEN** it is refused as unauthenticated

### Requirement: Screens show the seal date of the release behind a figure
Data Entry's calculation preview (beside its source and in its conversion note), the emissions record view and the review sheet SHALL show, beside the release they name, that release's seal date as a date in the user's locale. The label SHALL be "Paketin mühürlenme tarihi" in Turkish and "Package sealed on" in English. An issued report SHALL keep what it was issued with.

#### Scenario: A previewed natural gas figure
- **WHEN** a user previews a TR natural gas record priced from the TR package
- **THEN** the conversion note names the release and says "Paketin mühürlenme tarihi" with the date that release was sealed

### Requirement: The seal date is found through the figure's release
The seal date SHALL be found through the release that the figure's calculation names. A stored calculation SHALL NOT be rewritten to carry it. Where a figure names no release, or one the release list does not hold, the screen SHALL show no seal date and no other date in its place.

#### Scenario: An approved record priced before this change
- **WHEN** a user opens an approved record whose stored calculation names a release
- **THEN** the emissions record view shows that release's seal date, and the stored calculation is unchanged

#### Scenario: A figure with no release
- **WHEN** a record's calculation names no release
- **THEN** no seal date is shown
