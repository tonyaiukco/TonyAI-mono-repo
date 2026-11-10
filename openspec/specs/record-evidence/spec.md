# record-evidence Specification

## Purpose
Record evidence decides which activity categories need a supporting file, such as an invoice, meter reading, fuel receipt or service record, before a record joins the inventory, and enforces that rule at every point where a record is committed.

## Requirements

### Requirement: Evidence-required categories
Every Scope 1 and Scope 2 category SHALL require evidence: Electricity, Natural Gas, Fuel, Mobile Combustion, Refrigerants and Fugitive Gas. Water SHALL also require evidence, because it has no factor or anomaly check and its reading is verified only by its file. No other Scope 3 category SHALL require evidence.

#### Scenario: Every Scope 1 and 2 category requires evidence
- **WHEN** the category list is checked against each category's scope
- **THEN** every Scope 1 and Scope 2 category is evidence-required

#### Scenario: Water is the only Scope 3 category that requires evidence
- **WHEN** the Scope 3 categories are checked
- **THEN** Water is evidence-required, and Purchased Goods, Waste, Business Travel, Commuting and Logistics are not

### Requirement: Submit needs a file in an evidence-required category
Submitting a draft or rejected record in an evidence-required category with no attached file SHALL be refused with the stable code `evidence_required`, naming the category. Nothing SHALL change and no audit row SHALL be written. The check SHALL run after the period-lock check and before the activity-type (C8) and freshness (K11) checks.

#### Scenario: A mobile record without a file is refused
- **WHEN** the author submits a Mobile Combustion draft with no evidence attached
- **THEN** the request is refused with `evidence_required` and category Mobile Combustion, and the record stays a draft

#### Scenario: Refrigerants and Fugitive Gas are refused the same way
- **WHEN** the author submits a Refrigerants or Fugitive Gas draft with no evidence attached
- **THEN** the request is refused with `evidence_required` naming that category

#### Scenario: A rejected record is resubmitted without a file
- **WHEN** the author resubmits a rejected Refrigerants record that still has no file
- **THEN** the request is refused with `evidence_required`

#### Scenario: One file is enough
- **WHEN** the author submits a Mobile Combustion draft with one evidence file attached
- **THEN** the record becomes submitted

#### Scenario: An exempt category submits without a file
- **WHEN** the author submits a Waste draft with no evidence attached
- **THEN** the record becomes submitted

#### Scenario: Evidence is named before a missing activity type
- **WHEN** a Mobile Combustion draft has no file and no activity type
- **THEN** the refusal is `evidence_required`, not the missing activity type

### Requirement: Approve needs a file in an evidence-required category
Approving a submitted or under-review record in an evidence-required category with no attached file SHALL be refused with a stable approve-specific code, naming the category and telling the approver to reject the record so its author can attach a file. Nothing SHALL change and no audit row SHALL be written. The check SHALL run after the self-approval and period-lock checks and before the C8 and K11 checks. No record SHALL be exempt by its creation date or audit history.

#### Scenario: A record submitted before the rule cannot be approved without a file
- **WHEN** a super_admin who did not create it approves a submitted Mobile Combustion record that has no evidence attached
- **THEN** the request is refused with the approve-specific evidence code naming Mobile Combustion, and the record stays submitted

#### Scenario: An under-review record is refused the same way
- **WHEN** a super_admin approves an under-review Fugitive Gas record that has no evidence attached
- **THEN** the request is refused with the approve-specific evidence code

#### Scenario: The approver returns the record and the author fixes it
- **WHEN** the refused record is rejected, its author attaches a file and submits it again
- **THEN** a super_admin who did not create it can approve it

#### Scenario: An exempt category approves without a file
- **WHEN** a super_admin approves a submitted Waste record that has no evidence attached
- **THEN** the record becomes approved

#### Scenario: Self-approval and period lock are named first
- **WHEN** the record's creator approves it, or its period is locked, and it has no file
- **THEN** the refusal is the self-approval or period-lock refusal, not the evidence one

#### Scenario: Evidence is named before C8 and K11 at approve
- **WHEN** a record with no file also has no activity type or a stale figure
- **THEN** the refusal is the approve-specific evidence code

### Requirement: Bulk paths treat evidence-required rows alike
A bulk-imported row in an evidence-required category SHALL carry the `evidence_required` warning. An import batch's "send drafts" action and bulk submit SHALL hold back every record in an evidence-required category that has no attached file, and SHALL send one that has a file.

#### Scenario: An imported mobile row warns
- **WHEN** a bulk file row names Mobile Combustion or Fugitive Gas
- **THEN** the row is imported as a draft with the `evidence_required` warning

#### Scenario: Send drafts holds back a refrigerant draft without a file
- **WHEN** an import batch holds a Refrigerants draft with no file and a Waste draft
- **THEN** sending the batch's drafts submits the Waste draft and leaves the Refrigerants draft as a draft

#### Scenario: A draft that gained a file is sent
- **WHEN** a Mobile Combustion draft from a batch has a file attached
- **THEN** bulk submit and the batch's send action submit it

### Requirement: Committed records without a file are incomplete
The dashboard's tracking matrix SHALL treat a committed record in an evidence-required category with no attached file as incomplete. (The completeness panel counts invoice-tracked categories only, which the three K3 categories are not.)

#### Scenario: An approved refrigerant record without a file
- **WHEN** an approved Refrigerants record for a month has no evidence attached
- **THEN** that month's cell is not complete, and its figure still counts

#### Scenario: The same record with a file
- **WHEN** the approved Refrigerants record has one evidence file
- **THEN** the cell can be complete
