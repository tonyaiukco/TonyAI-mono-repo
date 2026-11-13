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
A record whose window holds no figure SHALL NOT be checked against history. A record with no calculated figure of its own SHALL be reported as not checked. A record with a figure and no figure in its window is a first-period record. It SHALL be checked against its first-period ceiling where its category, unit and entry have one. It SHALL be flagged only when it is above that ceiling. Otherwise it SHALL stay unflagged, SHALL need no variance reason, and SHALL count among the records not checked.

#### Scenario: The first period of a series
- **WHEN** a record is the first of its series and is not above a first-period ceiling
- **THEN** it is not flagged and is reported as not checked, with no earlier period to compare

#### Scenario: A record without a figure
- **WHEN** a record's category produces no calculated figure
- **THEN** it is reported as not checked because it has no figure of its own

#### Scenario: A first-period record above its ceiling
- **WHEN** a record is the first of its series and its amount is above its first-period ceiling
- **THEN** it is flagged and is not counted among the records not checked

### Requirement: A first-period record is named on screen
Data Entry, the review sheet and the emissions record view SHALL name a first-period record below its ceiling as a first-period record, say there is no earlier period to compare it with, and ask for the evidence document and the unit to be checked, in Turkish and English. They SHALL NOT say that a number of periods is needed. The review queue row SHALL mark it, distinct from a flag. An unsaved preview states no verdict.

#### Scenario: A first-period record in review
- **WHEN** a consultant opens a submitted record that has a figure, no earlier period, and is not above its ceiling
- **THEN** the review sheet calls it a first-period record, says there is no history to compare with, and asks for the evidence document and the unit to be checked

#### Scenario: A first-period record in the review queue
- **WHEN** the review queue lists a first-period record next to a flagged record
- **THEN** both rows carry a mark, and the two marks differ

#### Scenario: A first-period record on Data Entry
- **WHEN** a user saves a record with no earlier period, below its ceiling, in Turkish
- **THEN** the anomaly note says "İlk dönem kaydı" and asks for the evidence document and the unit to be checked, and the record can be submitted without a variance reason

### Requirement: No check against a zero average
When the figures in the window average zero, the record SHALL NOT be checked against history, whether the window holds one, two or three figures. It SHALL be checked against its ceiling where its category, unit and entry have one, and flagged only above it. Otherwise it SHALL be reported as not checked and SHALL NOT be flagged.

#### Scenario: A single zero period
- **WHEN** a series holds one earlier period of 0 tCO2e, the record's figure is 500 tCO2e and its amount is not above its ceiling
- **THEN** the record is not flagged and is reported as not checked because the average is zero

#### Scenario: Three zero periods
- **WHEN** the three earlier figures are all 0 tCO2e and the record's amount is not above its ceiling
- **THEN** the record is reported as not checked because the average is zero

#### Scenario: A zero January does not let a February typo through
- **WHEN** a site's January of 0 kWh is committed and its February is saved as 50,000,000 kWh
- **THEN** February is flagged as above the plausibility ceiling, keeps its count of 1 and its average of 0, and needs a variance reason at submit

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

### Requirement: First-period ceilings
A first-period record SHALL be flagged when its amount is strictly above the ceiling for its category and unit. Ceilings do not depend on the facility type. They are plausibility guards, not emission factors. Scope 3 categories have none. The ceilings SHALL be:
- Electricity 1,000,000 kWh
- Natural Gas 250,000 Sm³ or 2,500,000 kWh
- Mobile Combustion 100,000 L or 100,000 kg
- marine gas oil 1,000 t
- Fugitive Gas 200,000 Sm³
- Fuel 100,000 L or 150,000 kg

#### Scenario: Electricity with an extra zero
- **WHEN** the first electricity record of a site is saved as 4,500,000 kWh
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: Exactly at the ceiling is not flagged
- **WHEN** the first electricity record of a site is saved as 1,000,000 kWh
- **THEN** it is not flagged

#### Scenario: Natural gas by volume
- **WHEN** the first natural gas record of a site is saved as 300,000 Sm³
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: Stationary fuel by mass
- **WHEN** the first Fuel record of a site is saved as 120,000 kg
- **THEN** it is not flagged, because the Fuel ceiling in kg is 150,000 kg

#### Scenario: A Scope 3 record has no ceiling
- **WHEN** the first record of a Scope 3 series is saved with any amount
- **THEN** it is not flagged and is reported as a first-period record, not checked

### Requirement: Marine gas oil has its own ceiling
A first-period Mobile Combustion record of marine gas oil SHALL be checked against the marine gas oil ceiling of 1,000 t only, in kg or in tonnes, and never against the Mobile Combustion ceiling in kg.

#### Scenario: Marine gas oil between the two ceilings
- **WHEN** the first marine gas oil record of a vessel series is saved as 400,000 kg
- **THEN** it is not flagged

#### Scenario: Marine gas oil above its ceiling
- **WHEN** the first marine gas oil record of a series is saved as 1,200 tonnes
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: Road diesel by mass
- **WHEN** the first Mobile Combustion record of another fuel is saved as 120,000 kg
- **THEN** it is flagged as above the first-period ceiling

### Requirement: Other units reach the same ceiling by definition
An amount in another unit of a ceiling's unit family SHALL be compared through exact definitional equivalences only: MWh, GJ and therms with kWh, UK and US gallons with litres, and tonnes with kg. A metered cubic metre of natural gas that carries its own volume correction factor SHALL be compared as cubic metres × that factor with the Sm³ ceiling; without one, it SHALL be held to the Sm³ ceiling's number. No other limit value SHALL be introduced.

#### Scenario: Electricity in MWh
- **WHEN** the first electricity record of a site is saved as 1,200 MWh
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: Fuel in UK gallons
- **WHEN** the first Fuel record of a site is saved as 20,000 UK gallons
- **THEN** it is not flagged, because 20,000 UK gallons is 90,921.8 L

#### Scenario: Natural gas in metered cubic metres
- **WHEN** the first natural gas record of a site is saved as 260,000 m³ with no volume correction factor
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: Metered gas with a volume correction factor
- **WHEN** the first natural gas record of a site is saved as 240,000 m³ with a volume correction factor of 30
- **THEN** it is flagged, because 7,200,000 Sm³ is above 250,000 Sm³, although the m³ amount is not

### Requirement: Refrigerants are checked per equipment line
A first-period refrigerant record SHALL be flagged when any one of its equipment lines has an installed capacity strictly above 500 kg, or a refill strictly above its refill ceiling. The refill ceiling is 125% of the line's capacity, capped at 500 kg; for a line with no capacity it is 500 kg. The record's totals SHALL NOT be compared. A record with no equipment lines SHALL have no ceiling.

#### Scenario: One large line
- **WHEN** the first refrigerant record of a site holds lines of 120 kg and 650 kg
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: Many small lines
- **WHEN** the first refrigerant record of a site holds six lines of 100 kg each
- **THEN** it is not flagged, although the total is 600 kg

#### Scenario: A record without lines
- **WHEN** the first refrigerant record of a series has no equipment lines
- **THEN** it is not flagged and is reported as a first-period record, not checked

#### Scenario: A refill with an extra zero
- **WHEN** the first refrigerant record of a site holds a line of 10 kg capacity with a refill of 50,000 kg
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: A refill of exactly 125% of capacity
- **WHEN** the first refrigerant record of a site holds a line of 40 kg capacity with a refill of 50 kg
- **THEN** it is not flagged

#### Scenario: A refill just above 125% of capacity
- **WHEN** the first refrigerant record of a site holds a line of 40 kg capacity with a refill of 51 kg
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: A line with no capacity is held to 500 kg of refill
- **WHEN** the first refrigerant record of a site holds a line of 0 kg capacity with a refill of 400 kg, and another record a line of 0 kg capacity with a refill of 600 kg
- **THEN** the first is not flagged and the second is flagged

#### Scenario: The 500 kg cap applies to a large line's refill
- **WHEN** the first refrigerant record of a site holds a line of 400 kg capacity with a refill of 501 kg
- **THEN** it is flagged, although the refill is below 125% of its capacity

### Requirement: The ceiling applies only where history cannot judge
A record whose window holds at least one figure, averaging above zero, SHALL be checked against history only, and never against a ceiling, whatever its amount.

#### Scenario: The second period is judged by history
- **WHEN** a site's first electricity month of 4,000,000 kWh was submitted with a reason, and its second month of 4,100,000 kWh is saved
- **THEN** the second month is checked against the first, on limited history of 1 period, and is not flagged

#### Scenario: A zero average falls back to the ceiling
- **WHEN** a series holds one earlier period of 0 tCO2e and the record is above its ceiling
- **THEN** the record is flagged as above the plausibility ceiling, and its refusal at submit carries `basis` `ceiling`

### Requirement: A ceiling flag needs a variance reason at submit
Submitting a record flagged as above its ceiling (a first period, or earlier periods averaging zero), with no variance reason, SHALL be refused with `variance_reason_required`, and the record SHALL stay as it was. Submit, bulk submit and the bulk import warning SHALL treat a ceiling flag exactly as a flag on history.

#### Scenario: A ceiling flag blocks submit
- **WHEN** the author submits a first-period record above its ceiling with no variance reason
- **THEN** the request is refused with `variance_reason_required` and the record stays a draft

#### Scenario: A reason lets it through
- **WHEN** the author submits the same record with a variance reason
- **THEN** the record is submitted, flagged, with its reason

#### Scenario: Bulk import warns about a ceiling
- **WHEN** an imported row is the first period of its series, is above its ceiling and carries no variance reason
- **THEN** the import reports that the row would be blocked at submit, and its message names the plausibility ceiling and says the row has no usable history

### Requirement: The refusal names its basis
A single submit's `variance_reason_required` refusal SHALL carry the parameter `basis`. Its value SHALL be `ceiling` for a ceiling flag (a first period, or earlier periods averaging zero) and `history` for a flag on full or limited history. Data Entry's refusal text SHALL say which applies, in Turkish and English. A bulk submit refusal's message SHALL name the basis too.

#### Scenario: A ceiling refusal on Data Entry
- **WHEN** a Turkish user submits a first-period record above its ceiling with no variance reason
- **THEN** the refusal carries `basis` `ceiling` and its text says the figure has no usable history and is above the plausibility ceiling, not that it deviates from a historical average

#### Scenario: A history refusal keeps its meaning
- **WHEN** a record flagged on 2 earlier periods is submitted with no variance reason
- **THEN** the refusal carries `basis` `history` and its text says the figure deviates from the historical average

#### Scenario: Bulk submit names the ceiling
- **WHEN** a ceiling-flagged draft with no variance reason is sent in a bulk submit
- **THEN** it is refused with `variance_reason_required`, and the refusal's message names the plausibility ceiling

### Requirement: Screens state a ceiling flag
For a ceiling flag, Data Entry, the review sheet and the emissions record view SHALL say, in Turkish and English, that it is above its ceiling and why history cannot judge it: no earlier period, or a zero average. They SHALL show the amount and the ceiling, or a refrigerant line's capacity or refill and its limit, and ask for the evidence and the unit to be checked. No history average SHALL be named. The review queue row SHALL carry the flag mark.

#### Scenario: A reviewer opens a ceiling flag
- **WHEN** a consultant opens a submitted first-period record of 1,500 MWh of electricity
- **THEN** the review sheet says it is above the first-period ceiling of 1,000 MWh, that there is no earlier period, and asks for the evidence and the unit to be checked, beside the author's variance reason

#### Scenario: A ceiling flag over a zero average
- **WHEN** a reviewer opens a record flagged above its ceiling whose earlier periods average zero
- **THEN** the sheet says the earlier periods average zero and the figure is above the plausibility ceiling, and does not call it a first-period record

#### Scenario: A refrigerant line above the ceiling
- **WHEN** a user saves a first-period refrigerant record with a 650 kg line
- **THEN** Data Entry says an equipment line of 650 kg is above the 500 kg ceiling and asks for a variance reason

#### Scenario: A refill above its limit
- **WHEN** a user saves a first-period refrigerant record with a line of 10 kg capacity and a refill of 50,000 kg
- **THEN** Data Entry says the line's refill of 50,000 kg is above its limit of 12.5 kg, 125% of its 10 kg capacity, and asks for a variance reason

#### Scenario: The review queue marks it as a flag
- **WHEN** the review queue lists a ceiling-flagged record and a first-period record below its ceiling
- **THEN** the first carries the flag mark and the second the first-period mark

### Requirement: The matrix, dashboard and exports treat a ceiling flag as a flag
A ceiling flag SHALL turn its tracking-matrix cell amber and raise the dashboard alert, like any flag. It SHALL NOT be counted among records not checked. The anomaly column of every report and CSV export SHALL state that the record is above the ceiling, and whether history had no earlier period or earlier periods averaging zero, in the export's language.

#### Scenario: A ceiling flag in the matrix
- **WHEN** a committed record flagged as above its first-period ceiling sits in a tracking cell
- **THEN** the cell is amber, the dashboard lists an alert for it, and the cell's not-checked count leaves it out

#### Scenario: A ceiling flag in a CSV
- **WHEN** a record flagged as above its first-period ceiling is exported
- **THEN** its anomaly cell says yes and names the first-period ceiling

#### Scenario: A zero-average ceiling flag in a CSV
- **WHEN** a record flagged above its ceiling over earlier periods averaging zero is exported
- **THEN** its anomaly cell says yes, names the plausibility ceiling and says the earlier periods average zero

### Requirement: Verdicts scored before the ceiling are kept
No committed record SHALL be re-scored because the ceilings were introduced. A committed, unflagged record above its ceiling SHALL keep its verdict while history still cannot judge it and its stored count and average are the ones history gives. The consistency tools SHALL report it as a known difference, not drift. A draft or rejected record SHALL be checked against the ceiling at its next save, and the re-score tool MAY rewrite it.

#### Scenario: An approved first-period record from before the change
- **WHEN** a record approved before this change, the first of its series and above its ceiling, is opened
- **THEN** it is reported as a first-period record, not checked, and its verdict is unchanged

#### Scenario: A zero-average record from before the change
- **WHEN** a record approved before this change, above its ceiling and stored unflagged with one earlier period and an average of 0, is checked by the consistency tools
- **THEN** it is reported as a known difference, not drift, while its earlier periods still average zero

#### Scenario: A NULL stored count is not excused
- **WHEN** a committed record above its ceiling is stored unflagged with no count, or with three earlier periods and no average, where history gives a count and an average
- **THEN** the consistency probe and the re-score tool both report it as drift

#### Scenario: The probe on an upgraded database
- **WHEN** the consistency probe runs on a database that holds such committed records
- **THEN** it lists them as a known difference and does not report drift for them

#### Scenario: The re-score tool does not flag a record in review
- **WHEN** the re-score tool runs with apply on a submitted first-period record above its ceiling that carries no variance reason
- **THEN** the record's stored verdict is unchanged

#### Scenario: A draft meets the ceiling at its next save
- **WHEN** a draft saved before the change, the first of its series and above its ceiling, is saved again
- **THEN** it is flagged as above the first-period ceiling

#### Scenario: A broken stored average is not excused
- **WHEN** a committed record is stored unflagged with no earlier period but an average of 99, and is above its ceiling
- **THEN** the consistency tools report it as drift, not as a known difference

#### Scenario: A flag with no earlier period is not excused
- **WHEN** a committed record is stored as flagged with no earlier period while its amount is not above its ceiling
- **THEN** the consistency tools report it as drift
