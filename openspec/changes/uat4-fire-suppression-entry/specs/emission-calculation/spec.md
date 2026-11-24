# Spec Delta

## ADDED Requirements

### Requirement: Fire suppression capacity method
A Türkiye Fire Suppression record SHALL be one gas on an annual period, in kilograms, with one line per device. It SHALL be priced exactly as a refrigerant record is: each line on its refill when the refill is above zero, otherwise on capacity × the device's default leak rate, and the record as the sum of its lines' masses × the gas's factor.

#### Scenario: An FM200 system with no refill
- **WHEN** a Fire Suppression record of HFC-227ea with a fire suppression system line of 40 kg and no refill is calculated for 2025
- **THEN** the result is 2,880.00 kgCO2e (±0.5%) and the snapshot records leak rate 0.02 as the default

#### Scenario: An FM200 system with a refill
- **WHEN** a Fire Suppression record of HFC-227ea with a fire suppression system line of 50 kg and a refill of 35 kg is calculated for 2025
- **THEN** the result is 126,000.00 kgCO2e (±0.5%) and the snapshot records that the line was priced on its refill

#### Scenario: A CO2 extinguisher
- **WHEN** a Fire Suppression record of CO2 with a fire extinguisher line of 6 kg and no refill is calculated for 2025
- **THEN** the result is 0.24 kgCO2e (6 kg × 0.04 × 1) and the snapshot records leak rate 0.04 as the default

#### Scenario: An SF6 breaker
- **WHEN** a Fire Suppression record of SF6 with a transformer breaker gas line of 10 kg and no refill is calculated for 2025
- **THEN** the result is 25.20 kgCO2e (10 kg × 0.0001 × 25,200)

#### Scenario: A monthly fire suppression record
- **WHEN** a Türkiye Fire Suppression record names a monthly period
- **THEN** it is refused, because the leak rates are yearly

#### Scenario: A record with no equipment line
- **WHEN** a Türkiye Fire Suppression record carries no equipment line
- **THEN** it is refused with `parameters_required`, and nothing is calculated

### Requirement: A fire suppression record holds only its three devices
The equipment lines of a Fire Suppression record SHALL name only the fire extinguisher, the fire suppression system or the transformer breaker gas, each at most once, always at its default leak rate. The API and the database SHALL refuse any other device and any alternative rate on the category. A Refrigerants record SHALL keep accepting the devices it accepts today.

#### Scenario: A cooling device on a fire suppression record
- **WHEN** a Fire Suppression record names a split air conditioner line
- **THEN** it is refused with `record_parameters_invalid` (HTTP 400), and nothing is calculated

#### Scenario: An alternative rate on a fire suppression record
- **WHEN** a Fire Suppression record names a fire extinguisher line with the alternative leak rate
- **THEN** it is refused with `record_parameters_invalid` (HTTP 400)

#### Scenario: A write that passes by the API
- **WHEN** a row of category Fire Suppression with a chiller line is written to the database directly
- **THEN** the database refuses it

#### Scenario: A refrigerant record with a fire device
- **WHEN** an existing Refrigerants draft of HFC-227ea with a fire suppression system line is saved again
- **THEN** it is accepted and priced as before

### Requirement: A dry powder or foam record is calculated as zero
A Fire Suppression record of the dry powder or foam option SHALL be priced from that option's own factor row, whose value is zero. It SHALL be a calculated record with a figure of 0 kgCO2e, a snapshot that names its factor, its release and its equipment lines, and the standing of that release. It SHALL NOT be an uncalculated record, and a missing factor SHALL never be read as zero.

#### Scenario: Dry powder extinguishers
- **WHEN** a Fire Suppression record of the dry powder or foam option with a fire extinguisher line of 12 kg is calculated for 2025
- **THEN** the result is 0.00 kgCO2e, calculated, and the snapshot names the factor and the release that priced it

#### Scenario: A final report holding a zero record
- **WHEN** a counted final is issued for a boundary whose Fire Suppression records are all of the dry powder or foam option, priced by an authoritative release
- **THEN** those records count as calculated and authoritative, and they do not make Scope 1 partial

#### Scenario: No factor is not a zero
- **WHEN** a Fire Suppression record of any gas is calculated where no live release prices its category and year
- **THEN** it is refused with `no_factor`, and no figure is stored

### Requirement: Report datasets gain schema version 3 with Fire Suppression
A new report dataset SHALL be captured under schema version 3, whose categories are those of version 2 plus Fire Suppression. A dataset of schema 1 or 2 SHALL be recomputed under its own categories and SHALL keep its fingerprint. A boundary version confirmed before the category existed SHALL yield a partial with `applicability_undetermined` on Fire Suppression, until a new version decides it.

#### Scenario: A dataset retained before Fire Suppression
- **WHEN** a schema 2 dataset is issued after the category was added
- **THEN** it recomputes under its six categories, with its original fingerprint, and can still be final

#### Scenario: A new capture of an old confirmed version
- **WHEN** a boundary version confirmed before the category existed is captured
- **THEN** the dataset is schema 3 and partial, with `applicability_undetermined` on Fire Suppression

#### Scenario: A version that decides the category
- **WHEN** a new boundary version marks Fire Suppression included or excluded with its reason and is confirmed and captured
- **THEN** the dataset carries no gap for Fire Suppression

### Requirement: A boundary attributes fire suppression annually
An inventory boundary SHALL attribute the Fire Suppression category to the annual cadence only, in the editor and in the API, because its one pricing, the capacity method, is yearly. A monthly or quarterly policy for it SHALL be refused. Other categories keep every cadence; the evidence cadence is a separate field.

#### Scenario: A monthly fire suppression policy
- **WHEN** a declaration attributes Fire Suppression monthly or quarterly
- **THEN** the API refuses it and the editor does not offer it

#### Scenario: An annual fire suppression policy
- **WHEN** a declaration attributes Fire Suppression annually with an annual record behind it
- **THEN** it is accepted, and a capture carries no missing, overlapping or unmapped record for it

### Requirement: Reports list fire suppression as its own category
Live and issued reports SHALL list Fire Suppression records under their own category, apart from Refrigerants, in Scope 1. PDF and XLSX SHALL name the category and its gases in the report's Turkish or English; CSV SHALL use English. An equipment line's calculation-inputs text SHALL follow the wording refrigerant lines use.

#### Scenario: Two categories in one report
- **WHEN** a report covers a refrigerant record of R-410A and a fire suppression record of CO2 for one subsidiary and year
- **THEN** each is listed under its own category, and the category totals do not mix them

#### Scenario: A Turkish report
- **WHEN** a Turkish PDF or XLSX lists a fire suppression record of the dry powder or foam option
- **THEN** the category and the option are named in Turkish, and its figure reads zero

#### Scenario: A withdrawn record names its gas
- **WHEN** an issued PDF or XLSX lists a withdrawn fire suppression record of the dry powder or foam option
- **THEN** it names the category and the option, so withdrawn records of one period stay apart

#### Scenario: A small figure is not shown as zero
- **WHEN** the Data Entry preview or an issued PDF shows a CO2 extinguisher of 6 kg, 0.00024 tCO2e
- **THEN** it reads 0.00024, never 0, while a dry powder or foam record reads 0

#### Scenario: A refill-priced fire suppression line
- **WHEN** a report lists a fire suppression record with a system line of 50 kg capacity and 35 kg refill
- **THEN** its calculation inputs give 35 kg as the released mass, name the 50 kg capacity and the rate, and say the estimate was not added
