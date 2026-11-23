# emission-calculation Specification

## Purpose
Emission calculation turns one activity record into kgCO2e from the release in force, records every value it used in an immutable snapshot, and refuses rather than approximates.

## Requirements

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
Every new calculation SHALL write the new snapshot version. A draft or submitted record calculated on an older version SHALL read as stale until saved again. The TR natural gas and refrigerant rules SHALL apply by the record's geography, whatever a release holds. Parameters on a record outside those rules SHALL be refused, except an Electricity record's self-generation block, accepted in any geography. A TR rule's release lacking the parameter SHALL be answered as a library defect, never priced.

#### Scenario: A draft from before the new snapshot
- **WHEN** a draft with a calculated older snapshot is submitted
- **THEN** it is refused as stale, and saving it again clears the refusal

#### Scenario: Parameters off the TR rules
- **WHEN** a UK natural gas record carries an NCV
- **THEN** it is refused with `parameters_not_applicable`, and nothing is calculated

#### Scenario: A placeholder path in TR
- **WHEN** a TR natural gas record in m³ with no correction factor meets a placeholder m³ conversion
- **THEN** it is refused with `no_conversion`, not priced by the placeholder

#### Scenario: A self-generation block outside TR
- **WHEN** an Electricity record outside TR carries a valid self-generation block
- **THEN** it is not refused with `parameters_not_applicable`, and it is priced or refused exactly as the same record without the block

#### Scenario: Another category's parameters on an Electricity record
- **WHEN** an Electricity record carries an NCV or an equipment list
- **THEN** it is refused with `record_parameters_invalid` (HTTP 400), and nothing is calculated

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
- **THEN** the gross bill's calculation inputs name the gross-to-net ratio, and the factor appendix gives each set of conversion steps a line of its own (net and gross, kWh and MWh), in whatever order the records come, so no step is hidden or lent to another record; the Excel sheet names each line's conversion

#### Scenario: A ratio that would raise the quantity
- **WHEN** the factor's release holds a `reference_ncv` that is not below its `reference_gcv`
- **THEN** a gross kWh record is refused with `parameter_missing`, and nothing is priced

### Requirement: An Electricity record may carry a self-generation block
An Electricity record MAY carry a self-generation block in its parameters: `generationTopology`, `selfGenerationSource` (`solar`, `wind`, `natural_gas_chp` or `diesel_generator`), `selfGeneratedKwh`, and optionally `exportedToGridKwh` and `facilityConsumptionKwh`. The kWh fields SHALL be read as kWh whatever the record's unit. A record without the block SHALL stay a plain grid record, priced and snapshotted as before.

#### Scenario: A solar roof behind the meter
- **WHEN** a TR Electricity record of 600,000 kWh is created with topology `A`, source `solar` and 400,000 generated kWh
- **THEN** the record is accepted and stores the block in its parameters

#### Scenario: A record without the block
- **WHEN** 4,180.56 kWh of TR electricity is calculated for 2025 with no parameters
- **THEN** the result is 1,814.36 kgCO2e (±0.5%) and the snapshot holds no record inputs, as before this change

#### Scenario: A block of nulls is no block
- **WHEN** an Electricity record is saved with every self-generation field null
- **THEN** it is stored and priced as a plain grid record

#### Scenario: A bulk upload row
- **WHEN** an Electricity row is imported by bulk upload
- **THEN** it is accepted as a plain grid record, and the template offers no self-generation column

### Requirement: A self-generation block names its topology, source and generation
When any self-generation field is present, `generationTopology`, `selfGenerationSource` and `selfGeneratedKwh` SHALL all be present. A block missing one of them SHALL be refused with `parameters_required` (HTTP 400), naming the missing input. Nothing SHALL be assumed for a missing source.

#### Scenario: A block without a source
- **WHEN** an Electricity record carries topology `A` and 400,000 generated kWh but no source
- **THEN** it is refused with `parameters_required` naming `selfGenerationSource`, and nothing is calculated or written

#### Scenario: A block without the generated kWh
- **WHEN** an Electricity record carries topology `A` and source `wind` only
- **THEN** it is refused with `parameters_required` naming `selfGeneratedKwh`

#### Scenario: Exports stated alone
- **WHEN** an Electricity record carries only `exportedToGridKwh`
- **THEN** it is refused with `parameters_required` naming `generationTopology`

### Requirement: Only behind-the-meter topology A is accepted
A self-generation block SHALL be accepted only with `generationTopology` `A`. Topology `B` or `C` SHALL be refused with `parameters_not_applicable` (HTTP 400), and the database SHALL hold no block with another topology.

#### Scenario: Topology B is not offered yet
- **WHEN** an Electricity record carries topology `B` with a source and generated kWh
- **THEN** it is refused with `parameters_not_applicable`, and nothing is calculated or written

#### Scenario: A direct write of topology C
- **WHEN** a writer other than the API sets an Electricity record's parameters to a block with topology `C`
- **THEN** the database refuses the write

### Requirement: Self-generation fields are bounded
Generated and exported kWh SHALL be numbers from 0 to 1e300, exports SHALL NOT exceed the generation, and facility consumption SHALL be a number from 1e-300 to 1e300. Anything else, an unnamed source or topology, or an undefined field SHALL be refused with `record_parameters_invalid` (HTTP 400), and the database SHALL refuse the same shapes.

#### Scenario: Exports above generation
- **WHEN** an Electricity record carries 400,000 generated kWh and 500,000 exported kWh
- **THEN** it is refused with `record_parameters_invalid`, and nothing is written

#### Scenario: An unknown source
- **WHEN** an Electricity record carries source `biogas`
- **THEN** it is refused with `record_parameters_invalid`

#### Scenario: A negative generation
- **WHEN** an Electricity record carries `selfGeneratedKwh` of −1
- **THEN** it is refused with `record_parameters_invalid`

#### Scenario: Exports equal to generation
- **WHEN** an Electricity record carries 400,000 generated kWh and 400,000 exported kWh
- **THEN** the block is accepted

#### Scenario: A direct write past the bounds
- **WHEN** a writer other than the API sets a block whose exports exceed its generation, or one without a source
- **THEN** the database refuses the write

### Requirement: Self-generation never changes the Scope 2 figure
An Electricity record's Scope 2 figure SHALL be its value, the kWh imported from the grid, × the grid factor of its reporting year, location-based. A self-generation block SHALL NOT change that figure: generated kWh SHALL never be priced, exported kWh SHALL never be subtracted, and the source SHALL NOT change the record's scope. The figure SHALL never be negative.

#### Scenario: GV-SG-1, a solar site
- **WHEN** a TR 2025 Electricity record of 600,000 kWh carries topology `A`, source `solar`, 400,000 generated kWh and a facility consumption of 1,000,000 kWh
- **THEN** the result is 260,400 kgCO2e (±0.5%) in Scope 2, equal to the same record without the block

#### Scenario: GV-SG-2, a gas CHP site as two records
- **WHEN** a TR 2025 Electricity record of 600,000 kWh carries source `natural_gas_chp`, and the site's TR 2025 Natural Gas record holds 500,000 Sm³ at the default NCV
- **THEN** the Electricity record is 260,400 kgCO2e in Scope 2, the Natural Gas record is 969,167 kgCO2e in Scope 1, and together they are 1,229,567 kgCO2e (each ±0.5%)

#### Scenario: Exports do not offset the import
- **WHEN** a TR 2025 Electricity record of 600,000 kWh carries 400,000 generated kWh and 400,000 exported kWh
- **THEN** the result is still 260,400 kgCO2e

#### Scenario: A record in MWh
- **WHEN** a TR 2025 Electricity record of 600 MWh carries a block with 400,000 generated kWh
- **THEN** the result is 260,400 kgCO2e, and the generated kWh is not rescaled

### Requirement: The snapshot echoes the numeric self-generation inputs
A calculation of an Electricity record with a self-generation block SHALL record `selfGeneratedKwh`, and `exportedToGridKwh` and `facilityConsumptionKwh` when given, as record inputs with origin `user`. The topology and the source SHALL stay in the record's parameters. The snapshot version SHALL NOT change, and no existing record SHALL read as stale because of this change.

#### Scenario: A block with every field
- **WHEN** an Electricity record with 400,000 generated, 50,000 exported and 1,000,000 consumed kWh is calculated
- **THEN** the snapshot lists the three values by name with origin `user`, and names neither the topology nor the source

#### Scenario: A block with the required fields only
- **WHEN** an Electricity record with topology, source and 400,000 generated kWh is calculated
- **THEN** the snapshot lists `selfGeneratedKwh` only

#### Scenario: Records calculated before this change
- **WHEN** a draft or submitted Electricity record calculated before this change is read after it
- **THEN** it does not read as stale, and its figure and snapshot are unchanged
