# Spec Delta

## ADDED Requirements

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
