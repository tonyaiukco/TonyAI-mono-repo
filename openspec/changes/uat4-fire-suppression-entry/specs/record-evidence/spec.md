# Spec Delta

## MODIFIED Requirements

### Requirement: Evidence-required categories
Every Scope 1 and Scope 2 category SHALL require evidence: Electricity, Natural Gas, Fuel, Mobile Combustion, Refrigerants, Fire Suppression and Fugitive Gas. Water SHALL also require evidence, because it has no factor or anomaly check and its reading is verified only by its file. No other Scope 3 category SHALL require evidence.

#### Scenario: Every Scope 1 and 2 category requires evidence
- **WHEN** the category list is checked against each category's scope
- **THEN** every Scope 1 and Scope 2 category is evidence-required

#### Scenario: Water is the only Scope 3 category that requires evidence
- **WHEN** the Scope 3 categories are checked
- **THEN** Water is evidence-required, and Purchased Goods, Waste, Business Travel, Commuting and Logistics are not

#### Scenario: A fire suppression draft without a file is refused
- **WHEN** the author submits a Fire Suppression draft with no evidence attached, the dry powder or foam option included
- **THEN** the request is refused with `evidence_required` naming Fire Suppression

### Requirement: A refrigerant record names the evidence it accepts
When a refrigerant record has no file, its Evidence section SHALL list, in Turkish and English, four accepted documents: the equipment inventory list (signed or stamped), the authorised service maintenance or periodic inspection form, the nameplate photo or technical specification page, and the annual refill or maintenance invoice where there is one. Evidence-required categories other than Refrigerants and Fire Suppression SHALL keep the general note.

#### Scenario: A refrigerant record without a file
- **WHEN** a user enters a refrigerant record and has not chosen or attached a file
- **THEN** the Evidence section lists the four accepted documents

#### Scenario: A natural gas record without a file
- **WHEN** a user enters a natural gas record and has not attached a file
- **THEN** the Evidence section shows the general note, not the refrigerant list

## ADDED Requirements

### Requirement: A fire suppression record names the evidence it accepts
When a fire suppression record has no file, its Evidence section SHALL list, in Turkish and English, three accepted documents: the equipment tracking sheet, the system drawings, and photographs of the equipment or its label. It SHALL NOT show the refrigerant list.

#### Scenario: A fire suppression record without a file
- **WHEN** a user enters a fire suppression record and has not chosen or attached a file
- **THEN** the Evidence section lists the three accepted documents

#### Scenario: A dry powder or foam record without a file
- **WHEN** a user enters a fire suppression record of the dry powder or foam option with no file
- **THEN** the Evidence section lists the same three documents

### Requirement: The year's-records shortcut serves fire suppression records
A saved fire suppression record SHALL offer the shortcut refrigerant records have: one document attached to the other fire suppression records of its subsidiary and reporting year, when at least two of them are records the user may attach files to. The shortcut SHALL stay inside one category: it SHALL NOT tick a refrigerant record from a fire suppression record, or the reverse.

#### Scenario: Three fire suppression records for one facility
- **WHEN** a user has saved CO2, FM200 and dry powder or foam records for one subsidiary and 2025, none with a file yet, and chooses the shortcut on the CO2 record
- **THEN** the records table opens its attach step with the three records ticked, and one chosen file is attached to all three

#### Scenario: A refrigerant record of the same year
- **WHEN** the same subsidiary and year also hold an R-410A refrigerant record
- **THEN** the shortcut on the CO2 record does not list it

#### Scenario: Only one fire suppression record that year
- **WHEN** the saved fire suppression record is the only attachable one for its subsidiary and year
- **THEN** the shortcut is not offered
