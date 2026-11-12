# Spec Delta

## ADDED Requirements

### Requirement: A refrigerant record names the evidence it accepts
When a refrigerant record has no file, its Evidence section SHALL list, in Turkish and English, four accepted documents: the equipment inventory list (signed or stamped), the authorised service maintenance or periodic inspection form, the nameplate photo or technical specification page, and the annual refill or maintenance invoice where there is one. Other evidence-required categories SHALL keep the general note.

#### Scenario: A refrigerant record without a file
- **WHEN** a user enters a refrigerant record and has not chosen or attached a file
- **THEN** the Evidence section lists the four accepted documents

#### Scenario: A natural gas record without a file
- **WHEN** a user enters a natural gas record and has not attached a file
- **THEN** the Evidence section shows the general note, not the refrigerant list

### Requirement: A shortcut attaches one document to the year's gas records
Refrigerant records SHALL stay one record per gas. A saved refrigerant record SHALL offer, in its Evidence section, a shortcut that attaches one document to the other gas records of its year, when its subsidiary and reporting year hold at least two refrigerant records the user may attach files to.

#### Scenario: Three gases for one facility
- **WHEN** a user has saved R-410A, R-32 and FM200 records for one subsidiary and 2025, none with a file yet, and chooses the shortcut on the R-410A record
- **THEN** the records table opens its attach step with the three records ticked, and one chosen file is attached to all three

#### Scenario: A gas record that already has a file
- **WHEN** the R-410A record already holds a file and the user chooses the shortcut on it
- **THEN** R-32 and FM200 are ticked and R-410A is not, though the user may tick it

#### Scenario: Only one gas that year
- **WHEN** the saved refrigerant record is the only attachable refrigerant record for its subsidiary and year
- **THEN** the shortcut is not offered

### Requirement: The shortcut uses the existing attach step
The shortcut SHALL open the records table's existing one-new-file-to-several-records step, with that subsidiary's same-year refrigerant records that the user may attach files to and that hold no file yet ticked in advance, so that no record receives a second copy unasked. The user SHALL be able to tick or untick any record the step allows. The upload SHALL follow that step's rules (one subsidiary, all or nothing). The shortcut SHALL NOT link an already stored file to another record.

#### Scenario: A record the user cannot attach to
- **WHEN** a same-year refrigerant record is one the user may not attach files to
- **THEN** it is not ticked and cannot be ticked
