# Spec Delta

## MODIFIED Requirements

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
Data Entry, the review sheet and the emissions record view SHALL name a first-period record that is not above its ceiling as a first-period record. They SHALL say there is no earlier period to compare it with, and ask the user to check the evidence document and the unit, in Turkish and English. They SHALL NOT say that a number of periods is needed. The review queue row SHALL mark it, distinct from a flag. The verdict is worked out when the record is saved, as every verdict is; an unsaved preview states none.

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

## ADDED Requirements

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
