# emission-calculation Specification

## Purpose
Emission calculation turns one activity record into kgCO2e from the release in force, records every value it used in an immutable snapshot, and refuses rather than approximates.

## Requirements

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
A TR mobile record for a road or off-road vehicle SHALL name one of the five vehicle modes and SHALL be priced per litre for that mode. The per-litre factor is `density × NCV × 4.184e-9 × (CO2 + CH4 × 27.0 + N2O × 273)`, computed from the document's formula, not taken from its combined column.

#### Scenario: Golden values 6–7
- **WHEN** 15,973.75 L on-road petrol and 3,784.51 L on-road diesel are calculated for 2025
- **THEN** the results are 36,864.62 and 10,090.24 kgCO2e (±0.5%)

#### Scenario: A vehicle mode entered by mass
- **WHEN** a TR on-road diesel record is entered in kg or tonnes
- **THEN** it is refused with `no_factor`, because the vehicle modes are priced per litre only

### Requirement: Marine gas oil by mass
A TR Mobile Combustion record of type marine gas oil SHALL be priced per kilogram from the MGO edition. The per-kilogram factor is `NCV (TJ/kg) × (CO2 + CH4 × 27.0 + N2O × 273)` with the IPCC water-borne navigation factors in kg/TJ. A record in tonnes SHALL first be converted to kilograms by definition. The record is Scope 1.

#### Scenario: Tonnes and kilograms agree
- **WHEN** one TR MGO record of 12.5 t and another of 12,500 kg are calculated for 2025
- **THEN** both give the same kgCO2e, equal to 12,500 × the edition's per-kilogram CO2e factor

#### Scenario: The snapshot cites the MGO edition
- **WHEN** a TR MGO record is calculated
- **THEN** its snapshot names the MGO edition, its factor rows' source and methodology, and the tonnes-to-kilograms conversion when one was applied

#### Scenario: MGO entered by volume
- **WHEN** a TR MGO record is entered in litres
- **THEN** it is refused with `no_factor`, because no density is held for MGO

### Requirement: Gas-network leakage
A Fugitive Gas record in standard cubic metres (15 °C) SHALL be priced as `Sm³ × 273/288 × 0.7409 kg/Sm³ × 0.92 × 29.8`. The result is CH4 only: CO2 and N2O are zero. The record is Scope 1.

#### Scenario: Golden value 8
- **WHEN** 84,783.36 Sm³ of leakage is calculated for 2025
- **THEN** the result is 1,632,467.22 kgCO2e (±0.5%)

### Requirement: Refrigerant capacity method
A refrigerant record SHALL be one gas on an annual period, with one line per equipment type, each carrying an installed capacity and a refilled mass in kg (zero allowed). Its activity value SHALL equal the sum of the capacities. It SHALL be priced as `Σ (capacity × leak rate + refill) × GWP`. A record on another period, or with no equipment line, SHALL be refused. The leak rate is the equipment type's default parameter. The user may select the release's alternative instead: 10% for split air conditioners and 8% for chillers. The chosen rate and whether it is the default SHALL be in the snapshot. R-22 SHALL be priced in Scope 1 like the other gases (owner decision 2026-11-05).

#### Scenario: Golden value 9 (FM200)
- **WHEN** a fire-suppression system holding 40 kg of HFC-227ea with no refill is calculated for 2025
- **THEN** the result is 2,880.00 kgCO2e (±0.5%) and the snapshot records leak rate 0.02 as the default

#### Scenario: Two equipment types, one gas
- **WHEN** an annual R-410A record has a split air conditioner line and a chiller line
- **THEN** each line uses its own rate, the result is their sum, and the snapshot records both terms

#### Scenario: A monthly refrigerant record
- **WHEN** a TR refrigerant record names a monthly period
- **THEN** it is refused, because the document's leak rates are yearly

#### Scenario: Alternative leak rate
- **WHEN** a split air conditioner record selects the 10% alternative
- **THEN** the calculation uses 0.10 and the snapshot marks the rate as the user's alternative

### Requirement: Scope 2 method disclosure
A report SHALL label the Scope 2 figure as location-based. When there is no market-based figure, the report SHALL print "No market-based result" in English, with its TR catalogue equivalent. It SHALL NOT copy the location-based figure into a market-based column.

#### Scenario: No certificates held
- **WHEN** a final report is issued for a TR boundary with grid electricity
- **THEN** Scope 2 reads as location-based, with the statement "No market-based result"

### Requirement: Calculations write the new snapshot, and TR rules follow geography
Every new calculation SHALL write the new snapshot version. A draft or submitted record holding a calculated older version SHALL read as stale until it is saved again. The TR natural gas and refrigerant rules SHALL apply by the record's geography, whatever rows a release holds. Parameters on a record outside those rules SHALL be refused. A release a TR rule reads that lacks the parameter SHALL be answered as a library defect, not priced.

#### Scenario: A draft from before the new snapshot
- **WHEN** a draft with a calculated older snapshot is submitted
- **THEN** it is refused as stale, and saving it again clears the refusal

#### Scenario: Parameters off the TR rules
- **WHEN** a UK natural gas record carries an NCV
- **THEN** it is refused with `parameters_not_applicable`, and nothing is calculated

#### Scenario: A placeholder path in TR
- **WHEN** a TR natural gas record in m³ with no correction factor meets a placeholder m³ conversion
- **THEN** it is refused with `no_conversion`, not priced by the placeholder

### Requirement: Retained report datasets keep their own rule
A retained report dataset SHALL be recomputed under the categories of its own schema version, never a newer list. A new capture SHALL use the current version. A boundary version confirmed before a category existed SHALL yield a partial with that category's gap named, until a new version decides it. A dataset whose row and content disagree on the version, or that names a version the gate does not read, SHALL be refused.

#### Scenario: A dataset retained before Fugitive Gas
- **WHEN** a schema 1 dataset is issued after the category was added
- **THEN** it recomputes under its five categories, with its original fingerprint, and can still be final

#### Scenario: A new capture of an old confirmed version
- **WHEN** a version confirmed before the category existed is captured
- **THEN** the dataset is schema 2 and partial, with `applicability_undetermined` on Fugitive Gas

### Requirement: Snapshots stay immutable and readable
A calculation SHALL write its per-record inputs and parameters into a new snapshot version. Snapshots already committed SHALL be neither rewritten nor reinterpreted. Readers SHALL accept both the old and the new version. Loading the TR releases SHALL change no committed record's figure.

#### Scenario: Old snapshot after the load
- **WHEN** the TR releases load into a database holding committed placeholder-era records
- **THEN** every committed record's snapshot and figure are byte-identical to before

### Requirement: Typed natural gas inputs are bounded

A typed NCV on a TR natural gas record SHALL lie within the release's `billed_gcv_min` and `billed_gcv_max` scaled by its `reference_ncv ÷ reference_gcv`, about 7,299–9,396 kcal/Sm³ on the loaded releases, or it SHALL be refused with `ncv_out_of_range`. A `volumeCorrectionFactor` SHALL lie within 0.75–30, or it SHALL be refused with `volume_correction_out_of_range`. A release that lacks a row the range needs SHALL answer `parameter_missing`. Both bounds are plausibility limits, not factor values, and are provisional until the external review.

#### Scenario: A CSV decimal read as a small value

- **WHEN** a TR natural gas row carries the typed NCV `8.250`, read as 8.25
- **THEN** the dry run refuses that row as invalid, its message names the accepted range, and nothing is priced from it

#### Scenario: Values on the path today

- **WHEN** a record carries the default NCV, or a typed NCV of 8,080
- **THEN** it is priced as before, with the same snapshot inputs

#### Scenario: A valid bill whose effective NCV falls below the typed range

- **WHEN** a record carries a billed GCV of 10,427 kcal/Sm³, which derives an effective NCV near 7,244
- **THEN** it is priced as before, because the billed GCV has its own range

#### Scenario: A volume factor typed without its decimal point

- **WHEN** a record in m³ carries the factor 97
- **THEN** it is refused with `volume_correction_out_of_range`

#### Scenario: A stored figure

- **WHEN** an approved or locked record holds a value outside either bound
- **THEN** its snapshot stays as stored and readable

#### Scenario: An open draft outside the bound

- **WHEN** a draft holding an out-of-range value is submitted
- **THEN** the submit is refused, and saving it again names the bound it breaks
