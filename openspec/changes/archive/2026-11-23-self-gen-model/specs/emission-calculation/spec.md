# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
