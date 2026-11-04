# Spec Delta

## Purpose
Emission calculation turns one activity record into kgCO2e from the release in force, records every value it used in an immutable snapshot, and refuses rather than approximates.

## ADDED Requirements

### Requirement: Natural gas net-basis chain with per-record calorific inputs
A TR natural gas record in Sm³ SHALL be converted to energy on the net basis: `kWh = Sm³ × NCV (kcal/Sm³) × 4.184 / 3600`. NCV defaults to 8,250 kcal/Sm³, and the user may enter another value. If the user enters a billed gross calorific value instead, the effective NCV SHALL be `8,250 × 9,155 / GCV_bill`, taken as written from the source document (owner decision 2026-11-05). A record SHALL NOT carry both an edited NCV and a billed GCV. A metered m³ record SHALL be multiplied by its user-entered volume correction factor to Sm³ first. Without that factor it SHALL be refused. A TR natural gas record in kWh SHALL be refused with `calorific_basis_mismatch`, because bills state kWh on the gross basis. The snapshot SHALL record each per-record input, its origin (default, user-entered or derived) and the effective multiplier.

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

### Requirement: Grid electricity
A TR grid electricity record SHALL be priced location-based from the ETKB row for its reporting year. A record in MWh SHALL first be converted to kWh by definition.

#### Scenario: Golden values 1–3
- **WHEN** 4,180.56 kWh of TR electricity is calculated for 2025, 2024 and 2026
- **THEN** the results are 1,814.36, 1,847.81 and 1,814.36 kgCO2e (±0.5%)

### Requirement: Mobile combustion by vehicle mode
A TR mobile record SHALL name one of the five vehicle modes and SHALL be priced per litre for that mode. The per-litre factor is `density × NCV × 4.184e-9 × (CO2 + CH4 × 27.0 + N2O × 273)`, computed from the document's formula, not taken from its combined column.

#### Scenario: Golden values 6–7
- **WHEN** 15,973.75 L on-road petrol and 3,784.51 L on-road diesel are calculated for 2025
- **THEN** the results are 36,864.62 and 10,090.24 kgCO2e (±0.5%)

### Requirement: Gas-network leakage
A Fugitive Gas record in standard cubic metres (15 °C) SHALL be priced as `Sm³ × 273/288 × 0.7409 kg/Sm³ × 0.92 × 29.8`. The result is CH4 only: CO2 and N2O are zero. The record is Scope 1.

#### Scenario: Golden value 8
- **WHEN** 84,783.36 Sm³ of leakage is calculated for 2025
- **THEN** the result is 1,632,467.22 kgCO2e (±0.5%)

### Requirement: Refrigerant capacity method
A refrigerant record SHALL carry a gas, an equipment type, an installed capacity in kg and a refilled mass in kg (zero allowed). It SHALL be priced as `(capacity × leak rate + refill) × GWP`. The leak rate is the equipment type's default parameter. The user may select the release's alternative instead: 10% for split air conditioners and 8% for chillers. The chosen rate and whether it is the default SHALL be in the snapshot. R-22 SHALL be priced in Scope 1 like the other gases (owner decision 2026-11-05).

#### Scenario: Golden value 9 (FM200)
- **WHEN** a fire-suppression system holding 40 kg of HFC-227ea with no refill is calculated for 2025
- **THEN** the result is 2,880.00 kgCO2e (±0.5%) and the snapshot records leak rate 0.02 as the default

#### Scenario: Alternative leak rate
- **WHEN** a split air conditioner record selects the 10% alternative
- **THEN** the calculation uses 0.10 and the snapshot marks the rate as the user's alternative

### Requirement: Scope 2 method disclosure
A report SHALL label the Scope 2 figure as location-based. When there is no market-based figure, the report SHALL print "No market-based result" in English, with its TR catalogue equivalent. It SHALL NOT copy the location-based figure into a market-based column.

#### Scenario: No certificates held
- **WHEN** a final report is issued for a TR boundary with grid electricity
- **THEN** Scope 2 reads as location-based, with the statement "No market-based result"

### Requirement: Snapshots stay immutable and readable
A calculation SHALL write its per-record inputs and parameters into a new snapshot version. Snapshots already committed SHALL be neither rewritten nor reinterpreted. Readers SHALL accept both the old and the new version. Loading the TR releases SHALL change no committed record's figure.

#### Scenario: Old snapshot after the load
- **WHEN** the TR releases load into a database holding committed placeholder-era records
- **THEN** every committed record's snapshot and figure are byte-identical to before
