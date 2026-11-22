# Spec Delta

## MODIFIED Requirements

### Requirement: Natural gas net-basis chain with per-record calorific inputs
A TR natural gas record in Sm³ SHALL be converted to energy on the net basis: `kWh = Sm³ × NCV (kcal/Sm³) × 4.184 / 3600`. NCV defaults to 8,250 kcal/Sm³, and the user may enter another value. If the user enters a billed gross calorific value instead, the effective NCV SHALL be `8,250 × 9,155 / GCV_bill`, taken as written from the source document (owner decision 2026-11-05). A record SHALL NOT carry both an edited NCV and a billed GCV. A metered m³ record SHALL be multiplied by its user-entered volume correction factor to Sm³ first. Without that factor it SHALL be refused. A TR natural gas record in kWh or MWh SHALL follow the energy-unit requirements below. A TR natural gas record in therms or GJ SHALL be refused with `calorific_basis_mismatch`. For a reading in Sm³ or m³, the snapshot SHALL record each per-record input, its origin (default, user-entered or derived) and the effective multiplier; a bill in kWh or MWh records its basis as the energy-unit requirements below state.

#### Scenario: Default NCV (golden value 5)
- **WHEN** 100 Sm³ of TR natural gas for 2025 is calculated with no per-record input
- **THEN** the result is 193.83 kgCO2e (±0.5%) and the snapshot records NCV 8,250 as the default

#### Scenario: Billed GCV correction (golden value 4)
- **WHEN** 73.953103 Sm³ for 2025 is calculated with billed GCV 9,349.174 kcal/Sm³
- **THEN** the result is 140.37 kgCO2e (±0.5%) and the snapshot records an effective NCV of about 8,078.67 as derived

#### Scenario: Both NCV and GCV supplied
- **WHEN** a record carries an edited NCV and a billed GCV
- **THEN** it is refused, and nothing is calculated

#### Scenario: Metered m³ without a correction factor
- **WHEN** a TR record in m³ has no volume correction factor
- **THEN** it is refused with `no_conversion`

#### Scenario: Gas energy in therms or GJ
- **WHEN** a TR natural gas record is calculated in therms or GJ
- **THEN** it is refused with `calorific_basis_mismatch`, and nothing is calculated

#### Scenario: Sm³ snapshots are unchanged
- **WHEN** a TR natural gas record in Sm³ or m³ is recalculated after this change, with the same inputs and library
- **THEN** its snapshot is identical to the one stored before, and the record does not read as stale

### Requirement: Refusal families answer with their own HTTP status
A calculation the factor library cannot cover (`no_factor`, `placeholder_refused`, `no_conversion`, `calorific_basis_mismatch`) SHALL be refused with HTTP 422 and keep its code, message and coverage. An input refusal SHALL answer 400, and a library that contradicts itself SHALL answer 409. A subsidiary, location or record the caller cannot reach SHALL still answer the plain 404, with nothing about the factor library.

#### Scenario: No factor covers the lookup
- **WHEN** a record is created for a category, geography and year that no factor covers
- **THEN** the API answers 422 with the code `no_factor` and the coverage key it looked up
- **AND** no record is written

#### Scenario: Gas energy on the wrong calorific basis
- **WHEN** a TR natural gas record is created in therms, which the TR rules refuse
- **THEN** the API answers 422 with the code `calorific_basis_mismatch`

#### Scenario: A missing calorific basis is an input refusal
- **WHEN** a TR natural gas record is created in kWh without `cvBasis`
- **THEN** the API answers 400 with the code `parameters_required`, not a coverage code

#### Scenario: A malformed input stays a 400
- **WHEN** a record carries a unit its category does not accept
- **THEN** the API answers 400 with the code `unit_not_for_category`

#### Scenario: A self-contradicting library stays a 409
- **WHEN** two releases claim the same factor key at the same rank
- **THEN** the API answers 409 with the code `ambiguous_factor`

#### Scenario: A foreign subsidiary stays a plain 404
- **WHEN** a caller previews or creates a record for another tenant's subsidiary for which no factor exists
- **THEN** the API answers 404 with the entity's not-found code and nothing about the factor library

#### Scenario: Bulk upload still names the row's problem
- **WHEN** a bulk upload row cannot be priced because no factor covers it
- **THEN** the row's issue is `no_factor`, not `not_found`

## ADDED Requirements

### Requirement: Natural gas energy records state their calorific basis
A TR natural gas record in kWh or MWh SHALL carry `cvBasis` (`net` or `gross`), or be refused with `parameters_required` (400) naming the missing choice. It SHALL NOT carry `ncvKcalPerSm3`, `billedGcvKcalPerSm3` or `volumeCorrectionFactor`, and a record in Sm³ or m³ SHALL NOT carry `cvBasis`; both are refused with `parameters_not_applicable` (400).

#### Scenario: A kWh record without its basis
- **WHEN** a TR natural gas record of 1,000 kWh for 2025 carries no `cvBasis`
- **THEN** it is refused with `parameters_required`, nothing is calculated, and the TR and EN sentences ask for the net or gross choice, not refrigerant equipment

#### Scenario: A billed GCV on a kWh record
- **WHEN** a TR natural gas record in kWh carries `cvBasis` and a billed GCV
- **THEN** it is refused with `parameters_not_applicable`

#### Scenario: A basis on a volume record
- **WHEN** a TR natural gas record in Sm³ carries `cvBasis`
- **THEN** it is refused with `parameters_not_applicable`

#### Scenario: A basis outside Türkiye
- **WHEN** a UK natural gas record in kWh carries `cvBasis`
- **THEN** it is refused with `parameters_not_applicable`, and the UK record without it is priced as before

#### Scenario: A value other than net or gross
- **WHEN** a record carries `cvBasis` `lower`
- **THEN** it is refused as invalid input, and the database refuses the same value written directly

#### Scenario: An explicit null is an absent basis
- **WHEN** a record is created or updated with `cvBasis: null`, once in Sm³ and once in kWh
- **THEN** the Sm³ record is priced and stored, and the kWh record is refused with `parameters_required`; neither request ends in a server error

### Requirement: Net energy is priced directly against the net factor
A TR natural gas record in kWh or MWh SHALL be priced against the year's TR natural gas factor on the net basis, after MWh is normalised to kWh. It SHALL look up no conversion row, take no NCV step and read no billed GCV. If the factor that resolves is not on the net basis, the record SHALL be refused with `calorific_basis_mismatch` (422).

#### Scenario: GV-NG-kWh-A
- **WHEN** 1,000 kWh of TR natural gas for 2025 is calculated with `cvBasis` `net`
- **THEN** the result is 202.16 kgCO2e (±0.5%), the snapshot cites no conversion, and it echoes no per-record input: a bill's snapshot reads as net by carrying no gross-to-net ratio

#### Scenario: GV-NG-kWh-C matches golden value 5
- **WHEN** 958.83 kWh of TR natural gas for 2025 is calculated with `cvBasis` `net`
- **THEN** the result is 193.83 kgCO2e and equals golden value 5 (100 Sm³) within ±0.5%

#### Scenario: No conversion row is needed
- **WHEN** a release holds the TR net natural gas factor but no Sm³ conversion for that year
- **THEN** a kWh record with `cvBasis` `net` is priced, and an Sm³ record is refused with `no_conversion`

#### Scenario: No conversion row is read
- **WHEN** a TR natural gas record in kWh is priced, or refused and its refusal diagnosed
- **THEN** the lookup reads factors only and queries no unit conversion

#### Scenario: Only a gross factor resolves
- **WHEN** the only TR natural gas factor for the year is on the gross basis
- **THEN** a kWh record with either `cvBasis` is refused with `calorific_basis_mismatch`

### Requirement: Gross energy is reduced by the release's own ratio
A TR natural gas record in kWh or MWh with `cvBasis` `gross` SHALL be multiplied by `reference_ncv / reference_gcv`, both read from the resolved factor's release, and the net result priced as for `net`. A release lacking either row, or one whose ratio is not between 0 and 1, SHALL answer `parameter_missing` (409) and price nothing. The snapshot SHALL echo the ratio as a derived input and cite both release rows.

#### Scenario: GV-NG-kWh-B
- **WHEN** 1,000 kWh of TR natural gas for 2025 is calculated with `cvBasis` `gross` against `reference_ncv` 8,250 and `reference_gcv` 9,155
- **THEN** the net quantity is 901.147 kWh, the result is 182.17 kgCO2e within ±0.01 kg and inside v2.5's band of 181.0–182.8, and the snapshot records the ratio 0.901147 as derived and cites both rows

#### Scenario: Gross in MWh
- **WHEN** 1 MWh of TR natural gas for 2025 is calculated with `cvBasis` `gross`
- **THEN** the result is 182.17 kgCO2e within ±0.01 kg

#### Scenario: A release without its reference values
- **WHEN** the factor's release lacks `reference_gcv`
- **THEN** a gross kWh record is refused with `parameter_missing`, and a net kWh record is priced

#### Scenario: A report discloses the step
- **WHEN** a report lists a gross bill and a net bill priced by the same factor
- **THEN** the gross bill's calculation inputs name the gross-to-net ratio, and the factor appendix gives each set of conversion steps a line of its own (net and gross, kWh and MWh), in whatever order the records come, so no step is hidden or lent to another record

#### Scenario: A ratio that would raise the quantity
- **WHEN** the factor's release holds a `reference_ncv` that is not below its `reference_gcv`
- **THEN** a gross kWh record is refused with `parameter_missing`, and nothing is priced
