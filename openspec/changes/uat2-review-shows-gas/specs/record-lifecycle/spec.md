# Spec Delta

## ADDED Requirements

### Requirement: The review queue row names the record's activity type
Each review queue row SHALL name the record's activity type beside its category, using the activity-type label that Data Entry uses, in the user's language (Turkish or English). This SHALL hold for every category that has activity types. A record with no activity type, or in a category without activity types, SHALL show its category alone. The row's anomaly and first-period markers SHALL be unchanged.

#### Scenario: Two refrigerant records of one site differ only by gas
- **WHEN** the review queue lists two submitted Refrigerants records of the same site and year, one for R-410A and one for R-32
- **THEN** one row reads "Refrigerants (R-410A)" and the other "Refrigerants (R-32)", so the reviewer can tell them apart

#### Scenario: Another typed category
- **WHEN** the review queue lists a submitted Fuel record for diesel
- **THEN** its row names the category with the diesel label, as Data Entry's records table does

#### Scenario: The type in Turkish
- **WHEN** a user whose language is Turkish opens the review queue
- **THEN** the category and the activity type are shown with their Turkish labels

#### Scenario: A record without an activity type
- **WHEN** the review queue lists a record whose activity type is empty, or whose category has no activity types
- **THEN** its row shows the category alone, with no empty brackets

#### Scenario: A flagged refrigerant record keeps its mark
- **WHEN** the review queue lists an anomaly-flagged Refrigerants record for R-410A
- **THEN** its row names R-410A and still carries the flag mark

### Requirement: The review sheet names the record's activity type
The review sheet's title SHALL name the record's activity type beside its category, as the queue row does, before the period and year. A record with no activity type SHALL keep the title it has today.

#### Scenario: Opening a refrigerant record
- **WHEN** a reviewer opens the review sheet of an annual 2026 Refrigerants record for R-410A
- **THEN** the sheet's title reads "Refrigerants (R-410A) · Annual 2026" in English, and the Turkish equivalent in Turkish

#### Scenario: Opening a record without a type
- **WHEN** a reviewer opens the review sheet of a record with no activity type
- **THEN** the title shows the category, period and year as before

### Requirement: An activity type outside the catalogue is shown as stored
On the review queue row and the review sheet, an activity type that is not in its category's catalogue list SHALL be shown as stored, not hidden. A record whose stored type is the factor lookup's `unspecified` value SHALL show the "not specified" wording that Data Entry uses, in Turkish or English, never the raw value.

#### Scenario: An unknown stored type
- **WHEN** the review queue lists a record whose activity type is not in its category's catalogue list
- **THEN** its row shows the category followed by the stored value

#### Scenario: A stored `unspecified` type
- **WHEN** the review queue lists a Fuel record whose stored activity type is `unspecified`
- **THEN** its row shows the category followed by the "not specified" wording, not the raw value

#### Scenario: A legacy record entered before fuels were tracked
- **WHEN** the review queue lists a Fuel record written before activity types existed, whose activity type is empty
- **THEN** its row shows the category alone
