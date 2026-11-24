# Spec Delta

## ADDED Requirements

### Requirement: Fire suppression is its own Scope 1 entry
Data Entry SHALL offer a Fire Suppression category in Scope 1, labelled in Turkish and English, beside Refrigerants. Under the Türkiye rules its form SHALL be annual and SHALL ask for one gas and, per equipment line, a device, an installed capacity and a refilled mass, showing the total capacity in kilograms as the record's quantity. It SHALL say that a line with a refill is priced on the refill alone and that the capacity estimate is used only without a refill.

#### Scenario: The entry is offered
- **WHEN** a user opens the category list on Data Entry in Turkish or in English
- **THEN** Fire Suppression is listed as its own category, and the list still holds Refrigerants

#### Scenario: The form of a fire suppression record
- **WHEN** a user picks Fire Suppression for a Türkiye subsidiary
- **THEN** the period is annual, the form asks for a gas and for equipment lines, and the total installed capacity is shown in kilograms

#### Scenario: The form says how a refill is priced
- **WHEN** a user opens the equipment lines of a fire suppression record in Turkish or in English
- **THEN** the help text says a refill, when there was one, is the line's leak, and the capacity estimate applies only without a refill

### Requirement: The fire suppression entry lists three devices
A fire suppression equipment line SHALL offer exactly three devices: fire extinguisher, fire suppression system and transformer breaker gas. Each SHALL show its default leak rate and SHALL offer no alternative rate. A record SHALL hold at most one line per device.

#### Scenario: The device list
- **WHEN** a user opens the device list of a fire suppression line
- **THEN** it holds the fire extinguisher, the fire suppression system and the transformer breaker gas, and no air-conditioning or refrigeration device

#### Scenario: No alternative leak rate
- **WHEN** a user picks any of the three devices
- **THEN** the line shows that device's default leak rate and offers no other rate

#### Scenario: A device is entered once
- **WHEN** a user has a fire extinguisher line and adds another line
- **THEN** the new line cannot take the fire extinguisher again

### Requirement: The fire suppression entry lists its gases
The gas list of a fire suppression record SHALL hold CO2, FM200 (HFC-227ea), SF6 and "Dry powder / foam (no greenhouse gas)", labelled in Turkish and English. It SHALL NOT hold a refrigerant gas.

#### Scenario: The gas list
- **WHEN** a user opens the gas list of a new fire suppression record
- **THEN** it holds CO2, FM200 (HFC-227ea), SF6 and the dry powder or foam option, and no R-numbered refrigerant

#### Scenario: A CO2 extinguisher
- **WHEN** a user picks CO2 and a fire extinguisher line of 6 kg with no refill, where the library prices the category
- **THEN** the preview shows the figure for 6 kg × 4% of CO2

### Requirement: A gas outside the list cannot be entered
The gas list of a fire suppression record SHALL end with an "Other gas" item. Choosing it SHALL state, in Turkish and English, that a gas the factor library does not price cannot be entered and is never estimated. While it is chosen the form SHALL show no preview, SHALL NOT save, and SHALL send nothing to the API.

#### Scenario: Another gas is chosen
- **WHEN** a user picks "Other gas" on a fire suppression record
- **THEN** the form states that the gas cannot be entered until the library prices it, and the preview and the save are held

#### Scenario: The user returns to a listed gas
- **WHEN** the user then picks FM200 (HFC-227ea)
- **THEN** the statement goes and the form previews and saves as usual

### Requirement: The dry powder or foam option records a zero figure
Choosing "Dry powder / foam (no greenhouse gas)" SHALL keep the equipment lines and the evidence section, and the preview SHALL show a figure of zero with a statement, in Turkish and English, that the agent holds no greenhouse gas. The record SHALL be saved, submitted and reviewed as any fire suppression record.

#### Scenario: Dry powder extinguishers
- **WHEN** a user picks the dry powder or foam option and a fire extinguisher line of 12 kg, where the library prices the category
- **THEN** the preview shows 0 tCO2e and says the agent holds no greenhouse gas, and the record can be saved

#### Scenario: The record counts as entered
- **WHEN** a dry powder or foam record is saved for a subsidiary and year
- **THEN** the records table lists it with a figure of zero, and the tracking matrix no longer shows the Fire Suppression cell as missing

### Requirement: Capacity and refill are entered in grams or kilograms
Each fire suppression equipment line SHALL carry an explicit unit selector, grams or kilograms, that applies to both its capacity and its refill. A new line SHALL start on grams. Changing a line's unit SHALL clear that line's capacity and refill, so that a figure is never re-read in another unit. The refrigerant entry SHALL keep kilograms and SHALL show no selector.

#### Scenario: A new line starts on grams
- **WHEN** a user adds an equipment line to a fire suppression record
- **THEN** the line's unit selector shows grams

#### Scenario: A unit change clears the line
- **WHEN** a user has typed 6000 as a line's capacity in grams and switches that line to kilograms
- **THEN** the line's capacity and refill are cleared, and other lines are unchanged

#### Scenario: The refrigerant entry has no selector
- **WHEN** a user opens the equipment lines of a refrigerant record
- **THEN** capacity and refill are asked in kilograms with no unit selector

### Requirement: Gram figures are converted before preview and save
A line entered in grams SHALL be converted to kilograms, as the gram figure divided by 1,000, before the preview and before the save. The form SHALL show the kilogram figure beside a gram field. The record's quantity, its stored lines and every other screen SHALL be in kilograms.

#### Scenario: A gram capacity
- **WHEN** a user enters a capacity of 6000 on a line in grams
- **THEN** the form shows 6 kg beside the field, the total shows 6 kg, and the preview is the one for 6 kg

#### Scenario: A small refill in grams
- **WHEN** a user enters a refill of 35 on a line in grams and saves
- **THEN** the stored line holds a refill of 0.035 kg

#### Scenario: Lines in different units
- **WHEN** a record has an extinguisher line of 6000 in grams and a system line of 50 in kilograms
- **THEN** the total installed capacity is 56 kg

### Requirement: An opened fire suppression record shows kilograms
A stored fire suppression record SHALL open with each line in kilograms, as stored, and with that line's selector on kilograms. A line added to an opened record SHALL start on grams.

#### Scenario: A record entered in grams is opened again
- **WHEN** a user opens a record whose extinguisher line was entered as 6000 g
- **THEN** the line shows 6 with the selector on kilograms

#### Scenario: A line added to an opened record
- **WHEN** the user adds a line to that record
- **THEN** the new line's selector shows grams

### Requirement: The refrigerant entry offers cooling equipment and refrigerant gases
For a new record the refrigerant entry SHALL NOT offer HFC-227ea or SF6, and for a new line it SHALL NOT offer the fire extinguisher, the fire suppression system or the transformer breaker gas. An existing refrigerant record SHALL keep its own gas and its lines' devices selectable and editable, and SHALL be neither moved nor refused.

#### Scenario: A new refrigerant record
- **WHEN** a user starts a new refrigerant record
- **THEN** the gas list holds no HFC-227ea and no SF6, and a new line's device list holds the six cooling and refrigeration devices only

#### Scenario: An existing record with a fire device
- **WHEN** a user opens a refrigerant draft of HFC-227ea that holds a fire suppression system line
- **THEN** the gas and the line's device are shown and stay selected, and the draft can be edited and saved

#### Scenario: The stored device belongs to its own line
- **WHEN** the user switches that line to a chiller and adds a new line
- **THEN** the original line can take the fire suppression system back, and the new line offers the six cooling and refrigeration devices only

#### Scenario: A copied refrigerant record is checked as a new one
- **WHEN** a user copies a voided refrigerant record of HFC-227ea with a fire suppression system line to a new draft
- **THEN** the gas and that line's device are cleared, and the user picks them from the lists a new record is offered

### Requirement: A bulk file names fire suppression equipment in kilograms
The bulk upload SHALL accept Fire Suppression equipment rows through the refrigerant columns, in kilograms, one record per subsidiary, location, year and gas. A row naming a device outside the three SHALL refuse its whole record with its row, writing none of its lines; other records import record by record, as the bulk contract does. The template SHALL list the category, its gases and devices, in kilograms.

#### Scenario: Two devices of one gas
- **WHEN** a bulk file holds two Fire Suppression rows of CO2 for one subsidiary and year, a fire extinguisher of 6 kg and a fire suppression system of 45 kg
- **THEN** one record of 51 kg with two lines is formed, as the form's record would be

#### Scenario: An air conditioner on a fire suppression row
- **WHEN** a Fire Suppression row names a split air conditioner
- **THEN** the row is refused with its row number, and none of its record's lines is written

#### Scenario: A refused record beside a valid one
- **WHEN** a bulk file holds a valid CO2 record and an SF6 record one of whose lines names a split air conditioner
- **THEN** the CO2 record is imported and the SF6 record is refused whole, with its row, none of its lines written
