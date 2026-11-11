# Spec Delta

## ADDED Requirements

### Requirement: The library reports its coverage
The API SHALL report, to any signed-in user, each geography and reporting year that holds at least one factor in a sealed, non-withdrawn release. Each entry SHALL name the statuses of the releases behind it: authoritative, placeholder or fixture. Withdrawn releases SHALL never count. The report SHALL carry no factor value and nothing about a release beyond its status.

#### Scenario: Pilot library
- **WHEN** the library holds only the authoritative TR releases for 2024–2026
- **THEN** the report lists TR for 2024, 2025 and 2026, each marked authoritative, and nothing else

#### Scenario: A withdrawn release
- **WHEN** a release is withdrawn and no other live release covers its geography and year
- **THEN** that geography and year disappear from the report

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
