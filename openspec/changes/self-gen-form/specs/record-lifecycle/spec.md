# Spec Delta

## ADDED Requirements

### Requirement: The review sheet shows a self-generation block
The review sheet SHALL show, read-only, the self-generation block an Electricity record carries: the source in the reader's language, the generated kWh, and the exported and facility consumption kWh when the block states them. A record without a block SHALL show no self-generation lines.

#### Scenario: Reviewing a record with a solar roof
- **WHEN** a reviewer opens the review sheet of a submitted Electricity record of 600,000 kWh whose block states solar and 400,000 generated kWh
- **THEN** the sheet shows the source as solar and 400,000 kWh generated, and no exported or facility consumption line

#### Scenario: The source in Turkish
- **WHEN** a reviewer whose language is Turkish opens that sheet
- **THEN** the source and the line labels are shown in Turkish

#### Scenario: A plain grid record
- **WHEN** a reviewer opens the review sheet of an Electricity record without a block
- **THEN** the sheet shows no self-generation line

### Requirement: A record read states whether a fuel-sourced block has its fuel record
Every read of a record and every answer to a write SHALL carry `generationFuelRecord`: `present` or `missing` for an Electricity record whose block names a fuel source, null otherwise. A match is a record that is not voided, in the same subsidiary and the same location (including none), in any period of the same reporting year: Natural Gas for `natural_gas_chp`, Fuel of type diesel for `diesel_generator`.

#### Scenario: The site has its gas record
- **WHEN** a quarterly Electricity record of a site for 2026 names `natural_gas_chp`, and the same site holds a monthly Natural Gas draft for January 2026
- **THEN** the record's `generationFuelRecord` is `present`

#### Scenario: No fuel record
- **WHEN** such an Electricity record's site holds no Natural Gas record for 2026
- **THEN** its `generationFuelRecord` is `missing`

#### Scenario: A fuel record at another site
- **WHEN** the only Natural Gas record of 2026 belongs to another site of the same subsidiary, or to the whole company
- **THEN** the site's Electricity record reads `missing`

#### Scenario: A voided fuel record
- **WHEN** the site's only Natural Gas record for 2026 is voided
- **THEN** the Electricity record reads `missing`

#### Scenario: A fuel record of another year
- **WHEN** the site's only Natural Gas record is for 2025
- **THEN** the 2026 Electricity record reads `missing`

#### Scenario: A fuel record of another subsidiary
- **WHEN** another subsidiary holds a Natural Gas record for 2026 and the record's own subsidiary holds none
- **THEN** the Electricity record reads `missing`, whichever subsidiaries the reader can access

#### Scenario: A diesel generator
- **WHEN** an Electricity record names `diesel_generator` and the same site and year hold a Fuel record of type diesel
- **THEN** the record reads `present`; a Mobile Combustion record for diesel alone leaves it `missing`

#### Scenario: The read fails after a write
- **WHEN** a submit's record is written and audited, and reading its fuel-record state then fails
- **THEN** the submit is refused as a whole: the record keeps its earlier status and no audit row is written

#### Scenario: A renewable source
- **WHEN** an Electricity record's block names solar or wind, or the record has no block
- **THEN** its `generationFuelRecord` is null

#### Scenario: The review queue
- **WHEN** a reviewer lists the review queue
- **THEN** each row carries its `generationFuelRecord`, and so does the answer to a review decision on it

### Requirement: The review sheet notes a missing fuel record
When a record's `generationFuelRecord` is `missing`, the review sheet SHALL show a notice that names the fuel record not found for the record's site and year. The notice SHALL NOT block or change any review action.

#### Scenario: A CHP record without gas
- **WHEN** a reviewer opens the sheet of an Electricity record with source natural gas CHP whose site has no Natural Gas record for the year
- **THEN** the sheet shows the notice, and the reviewer can still approve or reject the record

#### Scenario: The fuel record exists
- **WHEN** the site holds a Natural Gas record for the year
- **THEN** the sheet shows no such notice

#### Scenario: The notice after a review step
- **WHEN** the reviewer starts the review of such a record and the sheet stays open
- **THEN** the notice is still shown

#### Scenario: The fuel record appears while the queue is open
- **WHEN** the queue was read before the site's Natural Gas record was entered, and the reviewer then opens the sheet without reloading the page
- **THEN** the sheet shows no such notice

### Requirement: The review sheet notes an energy balance gap
When a block states the facility consumption, the review sheet SHALL show a notice under the rule Data Entry applies: the import, in kWh, differs from consumption − generation + exports by more than 5% of that expected import, or the expected import is zero or less while the import is above zero. The notice SHALL name both figures and SHALL NOT block any review action.

#### Scenario: A gap above 5%
- **WHEN** a reviewer opens the sheet of a record of 600,000 kWh that states 900,000 kWh of consumption and 400,000 generated kWh
- **THEN** the sheet notes an import of 600,000 kWh against an expected 500,000 kWh, and the reviewer can still approve the record

#### Scenario: A balanced record
- **WHEN** the record states 1,000,000 kWh of consumption and 400,000 generated kWh
- **THEN** the sheet shows no balance notice

#### Scenario: No facility consumption
- **WHEN** the block states no facility consumption
- **THEN** the sheet shows no balance notice
