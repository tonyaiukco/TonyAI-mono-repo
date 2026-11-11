# Spec Delta

## ADDED Requirements

### Requirement: Data Entry shows the factor coverage legend
Data Entry SHALL show, under the record's factor geography, the geographies and reporting years the library covers, taken from the library's coverage report. Coverage that rests only on placeholder or fixture releases SHALL be labelled "placeholder — not authoritative". When the record's geography and year are not covered, the legend SHALL say so in a warning colour.

#### Scenario: Pilot coverage
- **WHEN** a user opens Data Entry on hosted QA, which holds only the authoritative TR releases
- **THEN** the legend reads that factors are defined for Türkiye (TR) for 2024–2026, with no placeholder label

#### Scenario: Geography outside coverage
- **WHEN** the record's factor geography is UK and UK is not in the coverage report
- **THEN** the legend shows, in amber, that no factor is defined for UK in that year

#### Scenario: Placeholder coverage
- **WHEN** the coverage report lists UK 2026 as placeholder only, and the record is UK 2026
- **THEN** the legend lists UK 2026 with the label "placeholder — not authoritative"

#### Scenario: Report unavailable
- **WHEN** the coverage request fails
- **THEN** the legend is omitted, the rest of the form works, and nothing claims coverage

### Requirement: The volume correction factor is explained on Data Entry
Where a natural gas record in m³ asks for a volume correction factor, an information control beside the field SHALL open an explanation with four points: the factor converts metered m³ to standard m³ (Sm³) at 15 °C and 1013.25 mbar; value × factor gives Sm³, which is then converted to energy at the net calorific value shown on the form; the accepted range is 0.75–30; and a bill already in Sm³ is entered in the Sm³ unit with no factor.

#### Scenario: Opening the explanation
- **WHEN** a user selects m³ for a natural gas record and activates the information control beside the volume correction factor
- **THEN** the four points appear in the user's language, and Escape closes them

#### Scenario: Not offered for Sm³
- **WHEN** the record's unit is Sm³
- **THEN** neither the volume correction factor nor its information control is shown
