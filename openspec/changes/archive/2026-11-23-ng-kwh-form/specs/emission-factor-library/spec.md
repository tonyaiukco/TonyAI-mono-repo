## ADDED Requirements

### Requirement: Release parameters for a gas energy bill
The release-parameters read SHALL accept an optional unit. For TR natural gas in kWh or MWh it SHALL resolve the factor as the calculation does for such a bill and return the parameters of that factor's release. Without a unit, or with a volume unit, it SHALL answer as before. A unit outside the vocabulary SHALL be refused as invalid input. Outside the TR rules, or with no factor resolved, it SHALL return no release.

#### Scenario: A TR gas bill in kWh
- **WHEN** a client reads the release parameters for TR natural gas, 2025, unit kWh
- **THEN** the answer names the release that holds the TR net factor, and its parameters include `reference_ncv` 8,250 and `reference_gcv` 9,155

#### Scenario: The answer follows the factor, not the conversion
- **WHEN** the net factor and the Sm³ conversion of a TR year sit in different releases
- **THEN** a read in kWh returns the factor's release, and a read in Sm³, or without a unit, returns the conversion's release

#### Scenario: The volume read is unchanged
- **WHEN** a client reads the release parameters for TR natural gas without a unit, or with Sm³ or m³
- **THEN** the answer is the same as before this change

#### Scenario: A unit outside the vocabulary
- **WHEN** a client sends unit `kwh_gas`
- **THEN** the read is refused as invalid input (400)

#### Scenario: Outside the TR rules
- **WHEN** a client reads the release parameters for UK natural gas in kWh
- **THEN** the answer holds no release and no parameters
