# Spec Delta

## MODIFIED Requirements

### Requirement: No check without history
A record whose window holds no figure SHALL be reported as not checked, never as within range. A record with no calculated figure of its own SHALL also be reported as not checked.

A record with a calculated figure whose window holds no figure is a **first-period record**. Data Entry, the review sheet and the emissions record view SHALL present it as follows, in Turkish and English:
- They SHALL name it a first-period record.
- They SHALL say that there is no earlier period to compare it with.
- They SHALL ask the user to check the evidence document and the unit.

They SHALL NOT say that a number of periods is needed. The review queue row SHALL mark a first-period record, distinct from the mark on a flagged record.

A first-period record SHALL stay unflagged, SHALL need no variance reason, and SHALL count among the records not checked.

#### Scenario: The first period of a series
- **WHEN** a record is the first of its series
- **THEN** it is not flagged and is reported as not checked, with no earlier period to compare

#### Scenario: A first-period record in review
- **WHEN** a consultant opens a submitted record that has a figure and no earlier period
- **THEN** the review sheet calls it a first-period record, says there is no history to compare with, and asks for the evidence document and the unit to be checked

#### Scenario: A first-period record in the review queue
- **WHEN** the review queue lists a first-period record next to a flagged record
- **THEN** both rows carry a mark, and the two marks differ

#### Scenario: A first-period record on Data Entry
- **WHEN** a user previews or saves a record with no earlier period in Turkish
- **THEN** the anomaly note says "İlk dönem kaydı" and asks for the evidence document and the unit to be checked, and the record can be submitted without a variance reason

#### Scenario: A record without a figure
- **WHEN** a record's category produces no calculated figure
- **THEN** it is reported as not checked because it has no figure of its own

### Requirement: Screens state what the verdict rests on
Data Entry, the review queue and the emissions record view SHALL state, for a short-history verdict, that it rests on limited history and on how many periods, with the average it was compared with. This SHALL hold for a flagged record and for one that is within range. A full-history verdict SHALL keep its present wording. The wording SHALL exist in Turkish and English.

#### Scenario: A flag on limited history says so
- **WHEN** a reviewer opens a record flagged on 2 earlier periods
- **THEN** the screen says the figure deviates by more than 50% against limited history of 2 periods, and shows their average

#### Scenario: A clean short-history verdict is not overstated
- **WHEN** a record was checked against 1 earlier period and is within range
- **THEN** the screen says it is within range against limited history of 1 period, not simply "within the expected range"

#### Scenario: No history is still named
- **WHEN** a record has no earlier period
- **THEN** the screen calls it a first-period record with no earlier period to compare, and does not say that three periods are needed
