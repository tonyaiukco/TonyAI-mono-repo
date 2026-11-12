# anomaly-check Specification

## Purpose
The anomaly check compares a record's calculated emissions with the same reporting entity's earlier periods, flags a figure that is far from that history, and makes the author explain a flagged figure before it is submitted. It also governs what each screen and export says about how much history a verdict rests on.

## Requirements

### Requirement: Comparable history
A record's history SHALL be the records of the same subsidiary, location, category, activity type and period granularity, in an earlier reporting period, whose status is submitted, under review, approved or locked. A record with no location is its own series, apart from any site. The record being checked SHALL never count as its own history.

#### Scenario: A draft does not count as history
- **WHEN** the only earlier record of a series is a draft, a rejected record or a voided record
- **THEN** the record being checked has no history

#### Scenario: A quarter does not seed a month
- **WHEN** a monthly record is checked and the same entity and category hold only quarterly records
- **THEN** the monthly record has no history

#### Scenario: A site and the whole company are separate series
- **WHEN** a record entered for a site is checked and earlier records exist only for the whole company
- **THEN** the site record has no history

#### Scenario: History crosses the year
- **WHEN** a January record is checked and the previous December holds a submitted record of the same series
- **THEN** December counts as the most recent earlier period

### Requirement: The window is the three most recent earlier periods
The check SHALL look at the three most recent earlier periods of the history and no further. An earlier record with no calculated figure SHALL occupy one of those three places and SHALL be left out of the average. The check SHALL NOT reach further back to replace it. How long ago a period was SHALL NOT exclude it.

#### Scenario: Only the newest three are used
- **WHEN** a series holds four earlier periods with figures
- **THEN** the average is taken over the three most recent, and the oldest is ignored

#### Scenario: A period without a figure is not replaced
- **WHEN** the three most recent earlier periods are 10 tCO2e, a record with no figure, and 10 tCO2e, and an older period holds 40 tCO2e
- **THEN** the record is checked against an average of 10 tCO2e over 2 periods

#### Scenario: An old period still counts when nothing newer exists
- **WHEN** a 2026 record is checked and the only earlier period of its series is from 2024
- **THEN** the 2024 period is its history

### Requirement: Full-history check
When the window holds three figures, the record SHALL be compared with their average. It SHALL be flagged when its figure differs from that average by more than 50%, above or below. A difference of exactly 50% SHALL NOT flag it.

#### Scenario: A figure far above the average is flagged
- **WHEN** the three earlier figures average 10 tCO2e and the record's figure is 16 tCO2e
- **THEN** the record is flagged

#### Scenario: A figure far below the average is flagged
- **WHEN** the three earlier figures average 10 tCO2e and the record's figure is 4 tCO2e
- **THEN** the record is flagged

#### Scenario: Exactly 50% is not flagged
- **WHEN** the three earlier figures average 10 tCO2e and the record's figure is 15 tCO2e
- **THEN** the record is checked and not flagged

### Requirement: Short-history check
When the window holds one or two figures, the record SHALL be compared with the average of those figures, under the same 50% rule as the full-history check. The verdict SHALL record how many periods it rested on, so that it can be told apart from a full-history verdict.

#### Scenario: One earlier period is enough
- **WHEN** a series holds one earlier period of 10 tCO2e and the record's figure is 16 tCO2e
- **THEN** the record is flagged, on limited history of 1 period

#### Scenario: Two earlier periods are averaged
- **WHEN** a series holds two earlier periods of 8 and 12 tCO2e and the record's figure is 14 tCO2e
- **THEN** the record is checked against 10 tCO2e over 2 periods and is not flagged

#### Scenario: The second period of a new site is checked
- **WHEN** a new site's first month is submitted and its second month is entered
- **THEN** the second month is checked against the first, on limited history of 1 period

### Requirement: No check without history
A record whose window holds no figure SHALL be reported as not checked, never as within range. A record with no calculated figure of its own SHALL also be reported as not checked. A record with a figure and no figure in its window is a first-period record: it SHALL stay unflagged, SHALL need no variance reason, and SHALL count among the records not checked.

#### Scenario: The first period of a series
- **WHEN** a record is the first of its series
- **THEN** it is not flagged and is reported as not checked, with no earlier period to compare

#### Scenario: A record without a figure
- **WHEN** a record's category produces no calculated figure
- **THEN** it is reported as not checked because it has no figure of its own

### Requirement: A first-period record is named on screen
Data Entry, the review sheet and the emissions record view SHALL name a first-period record as one, say there is no earlier period to compare it with, and ask the user to check the evidence document and the unit, in Turkish and English. They SHALL NOT say that a number of periods is needed. The review queue row SHALL mark it, distinct from a flag. The verdict is worked out when the record is saved, as every verdict is; an unsaved preview states none.

#### Scenario: A first-period record in review
- **WHEN** a consultant opens a submitted record that has a figure and no earlier period
- **THEN** the review sheet calls it a first-period record, says there is no history to compare with, and asks for the evidence document and the unit to be checked

#### Scenario: A first-period record in the review queue
- **WHEN** the review queue lists a first-period record next to a flagged record
- **THEN** both rows carry a mark, and the two marks differ

#### Scenario: A first-period record on Data Entry
- **WHEN** a user saves a record with no earlier period in Turkish
- **THEN** the anomaly note says "İlk dönem kaydı" and asks for the evidence document and the unit to be checked, and the record can be submitted without a variance reason

### Requirement: No check against a zero average
When the figures in the window average zero, the record SHALL be reported as not checked, whether the window holds one, two or three figures. It SHALL NOT be flagged.

#### Scenario: A single zero period
- **WHEN** a series holds one earlier period of 0 tCO2e and the record's figure is 500 tCO2e
- **THEN** the record is not flagged and is reported as not checked because the average is zero

#### Scenario: Three zero periods
- **WHEN** the three earlier figures are all 0 tCO2e
- **THEN** the record is reported as not checked because the average is zero

### Requirement: A flagged record needs a variance reason at submit
Submitting a flagged record with no variance reason SHALL be refused with the stable code `variance_reason_required`, and the record SHALL stay as it was. This SHALL hold for a flag on limited history exactly as for a flag on full history. The verdict SHALL be worked out again at submit, against the history as it stands then. Approval SHALL NOT check the flag.

#### Scenario: A limited-history flag blocks submit
- **WHEN** the author submits a record flagged on 1 earlier period, with no variance reason
- **THEN** the request is refused with `variance_reason_required` and the record stays a draft

#### Scenario: A reason lets it through
- **WHEN** the author submits the same record with a variance reason
- **THEN** the record is submitted, flagged, with its reason

#### Scenario: Submit judges today's history
- **WHEN** a draft was saved as not checked, an earlier period of its series is then submitted, and the draft is submitted with a figure more than 50% from that period
- **THEN** the submit is refused with `variance_reason_required`

#### Scenario: Bulk submit checks each record in period order
- **WHEN** drafts for January (10 tCO2e) and February (16 tCO2e) of a new series are sent together and February has no variance reason
- **THEN** January is submitted and February is refused for a missing variance reason

#### Scenario: Bulk import warns before the draft is created
- **WHEN** an imported row would be flagged on limited history and carries no variance reason
- **THEN** the import reports that the row would be blocked at submit

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

### Requirement: The matrix and the dashboard treat every flag alike
A flag on limited history SHALL turn its tracking-matrix cell amber and raise the dashboard alert exactly as a full-history flag does. The count of records not checked for anomalies SHALL include only records reported as not checked.

#### Scenario: A limited-history flag turns the cell amber
- **WHEN** a committed record flagged on 1 earlier period sits in a tracking cell
- **THEN** the cell is amber and the dashboard lists an alert for it

#### Scenario: A checked record leaves the not-checked count
- **WHEN** a cell holds one record checked on 2 earlier periods and one record with no earlier period
- **THEN** the cell reports 1 record not checked

### Requirement: Exports state what the verdict rests on
The anomaly column of every report and CSV export SHALL state a short-history verdict's basis beside its outcome, in the export's language. A record that was not checked SHALL name the reason. Full-history verdicts SHALL keep their present cells.

#### Scenario: A flagged short-history record in a CSV
- **WHEN** a record flagged on 1 earlier period is exported
- **THEN** its anomaly cell says yes and names limited history of 1 period

#### Scenario: A clean short-history record in a CSV
- **WHEN** a record checked on 2 earlier periods and within range is exported
- **THEN** its anomaly cell says it was within range against limited history of 2 periods, and is not left empty

### Requirement: The verdict is stored with the record
A record SHALL carry its verdict: the flag, how many periods it rested on, and the average. The verdict SHALL be worked out when the record is created, updated or submitted, and not when it is read. No action in the application on an earlier period SHALL change a later record's stored verdict. Only the operator's re-score tool rewrites a stored verdict. It SHALL NOT rewrite an approved or locked record, and SHALL NOT give a record in review a flag while that record carries no variance reason.

#### Scenario: An earlier period changes afterwards
- **WHEN** a record was submitted as within range, and the earlier period it was compared with is then recalled and edited
- **THEN** the submitted record's stored verdict is unchanged

#### Scenario: The re-score tool repairs a record that is still open
- **WHEN** an operator runs the re-score tool with apply, and a draft, rejected, submitted or under-review record's stored verdict no longer matches its history
- **THEN** that record's verdict is rewritten with an audit row, and an approved or locked record in the same state is reported and left unchanged

#### Scenario: The re-score tool does not hand a reviewer an unanswered flag
- **WHEN** February is submitted as not checked, January is committed afterwards more than 50% away, and the re-score tool runs with apply
- **THEN** February is reported as a record the rule would now flag, its stored verdict is unchanged, and the tool reports that drift remains

#### Scenario: A record in review that already explains itself is repaired
- **WHEN** the same February record carries a variance reason
- **THEN** the re-score tool writes the flag and the average it was judged against

#### Scenario: Recall keeps the verdict until the next save
- **WHEN** an author recalls a submitted record
- **THEN** the draft shows the verdict it was submitted with, until it is saved or submitted again

### Requirement: Verdicts scored before the short-history check are kept
An unflagged record scored on one or two periods before the short-history check existed SHALL keep its not-checked verdict and SHALL say that it was scored before that check existed. No committed record SHALL be re-scored because the rule changed. An approved or locked record's verdict SHALL never be rewritten. The consistency tools SHALL report these earlier verdicts as a known difference and not as drift.

#### Scenario: An approved record from before the change
- **WHEN** a record approved before the change, with 2 earlier periods and no stored average, is opened
- **THEN** it is reported as not checked, scored before the short-history check existed, and its verdict is unchanged

#### Scenario: A draft from before the change is checked at its next save
- **WHEN** a draft scored before the change is saved or submitted
- **THEN** it is checked under the short-history rule

#### Scenario: A flagged row in the earlier shape is not excused
- **WHEN** a committed record holds a flag beside a count of 1 or 2 and no average, which no version of the rule ever wrote
- **THEN** the consistency tools report it as drift, not as a known difference

#### Scenario: A stored verdict is checked whole, not by its flag alone
- **WHEN** a committed record is stored as flagged on 1 earlier period with no average, and the rule flags it today as well
- **THEN** the consistency probe reports it as drift, because its stored average is not the rule's

#### Scenario: A stale count or average is drift although the flag still holds
- **WHEN** a committed record's stored count or average no longer matches its history, and its flag does
- **THEN** the consistency probe reports it as drift

#### Scenario: The consistency probe on an upgraded database
- **WHEN** the probe runs on a database that holds committed records scored before the change
- **THEN** it lists them as a known difference and does not report drift for them
