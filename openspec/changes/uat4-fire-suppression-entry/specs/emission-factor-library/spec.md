# Spec Delta

## ADDED Requirements

### Requirement: Supplementary IPCC edition for fire suppression
The library SHALL hold a separate IPCC release for the Fire Suppression category, beside the TR package and the MGO edition and superseding neither. It SHALL cover TR for reporting years 2024, 2025 and 2026, per kilogram, on AR6, with one CO2e row each for HFC-227ea (3,600), SF6 (25,200), CO2 (1) and the dry powder or foam option (0). The three gas values SHALL be the TR package's own, as written in its §4.6.

#### Scenario: Loaded beside the other editions
- **WHEN** the fire suppression edition is dry-run and then loaded while the TR package's IPCC release and the MGO edition are live
- **THEN** the loader reports no overlap, the three releases stay live, and no row of the other two changes

#### Scenario: No draft becomes stale
- **WHEN** the edition is loaded on a database holding open drafts priced by the TR package
- **THEN** every such draft is still fresh, because no release was withdrawn

#### Scenario: A year without coverage fails closed
- **WHEN** a TR Fire Suppression record for a reporting year outside 2024–2026, such as 2027, is calculated
- **THEN** it is refused with `no_factor` and no figure is stored

#### Scenario: The refrigerant rows are untouched
- **WHEN** a Refrigerants record of HFC-227ea is calculated after the edition is loaded
- **THEN** it is priced by the TR package's own row, as before

### Requirement: The fire suppression edition carries its devices' leak rates
The edition SHALL carry the default leak rates of the fire extinguisher (0.04), the fire suppression system (0.02) and the transformer breaker gas (0.0001), as the TR package's §4.6 gives them, with no alternative rate and no rate for any other device. A fire suppression record SHALL read its leak rates from this edition.

#### Scenario: The rates equal the package's
- **WHEN** the edition's three leak rates are compared with the TR package release's rates for the same devices
- **THEN** they are equal

#### Scenario: A record's snapshot names the edition
- **WHEN** a Fire Suppression record of CO2 with a fire extinguisher line is calculated
- **THEN** its snapshot shows leak rate 0.04 read from the fire suppression edition

### Requirement: Each fire suppression row cites its own source
The HFC-227ea, SF6 and CO2 rows and the three leak rates SHALL cite the TR package document's §4.6. The dry powder or foam row SHALL cite the owner's UAT round 4 decision (BUG-12: the agent holds no greenhouse gas) and SHALL NOT cite the TR package, which does not mention it. Its methodology SHALL say that the zero states the absence of a greenhouse gas and is not a measured factor.

#### Scenario: A gas row is read
- **WHEN** the CO2 factor row is read
- **THEN** its source names the TR package's §4.6 and IPCC AR6, and its value is 1

#### Scenario: The zero row is read
- **WHEN** the dry powder or foam factor row is read
- **THEN** its source names the UAT round 4 decision and not `docs/md_docs/Revision MD.md`, and its methodology says the agent holds no greenhouse gas

### Requirement: Fire suppression edition review record
The fire suppression edition SHALL name "TonyAI Sustainability Team" as its reviewer, and SHALL be loaded as authoritative only after the owner's approval is recorded in the status file's Decisions log. Its values SHALL be listed for the external carbon reviewer with two questions: whether the 4% and 2% rates apply to CO2 equipment, and the zero for dry powder and foam. A correction SHALL be a new edition that supersedes it, never an edit to a loaded row.

#### Scenario: Loaded before the approval is recorded
- **WHEN** the Decisions log holds no approval of the edition
- **THEN** the edition is not loaded as authoritative on any shared environment

#### Scenario: A reviewer corrects a value
- **WHEN** the external reviewer rejects a rate or a value of the edition
- **THEN** a new IPCC edition with the next ordinal supersedes it, and committed snapshots keep citing the old one

### Requirement: The import contract treats fire suppression as it treats refrigerants
The release import SHALL hold a Fire Suppression factor row to the rules of a refrigerant row: its coverage is the gas itself (`all_ghg`), it has no per-gas rows, its unit is the kilogram, its activity type is one the category's catalogue holds, and a TR row needs a default leak rate in the same release.

#### Scenario: A per-gas row for fire suppression
- **WHEN** a release file holds a CH4 row for Fire Suppression
- **THEN** validation refuses the file and nothing is loaded

#### Scenario: A TR fire suppression factor without a leak rate
- **WHEN** a release file prices TR Fire Suppression and carries no default leak rate
- **THEN** validation refuses the file and nothing is loaded

#### Scenario: A gas the catalogue does not hold
- **WHEN** a release file prices Fire Suppression for R-410A
- **THEN** validation refuses the file, because R-410A is not a fire suppression gas
