# report-finals Specification

## Purpose
Defines what makes an issued report final, and what live and issued reports say about Scope 3, so no document claims more than its data supports.

## Requirements

### Requirement: A final needs at least one included obligation

An inventory issuance with no included obligation SHALL be partial and SHALL name the gap `no_included_obligation`. The database SHALL refuse a final row with no included obligation from any writer.

#### Scenario: Every category excluded

- **WHEN** a confirmed boundary excludes every category with its reason and a dataset is issued
- **THEN** the issuance is partial, names `no_included_obligation`, and carries no final badge

#### Scenario: A direct write

- **WHEN** any writer inserts a final issuance whose dataset has no included obligation
- **THEN** the database refuses the row

### Requirement: Retained data stays valid

The rule SHALL NOT change a retained dataset's fingerprint or a stored issuance. A dataset captured before the rule SHALL stay issuable, as partial when it has no included obligation.

#### Scenario: A dataset captured earlier

- **WHEN** an all-excluded dataset captured before this rule is issued
- **THEN** it issues as partial, and its fingerprint still verifies

#### Scenario: An existing final

- **WHEN** an all-excluded final issued before this rule is read
- **THEN** it is returned unchanged until a later final supersedes it

#### Scenario: A restore

- **WHEN** a data-only restore in replica mode loads a dump holding such a final
- **THEN** the row loads as it was, its `issued_at` included

### Requirement: A counted final reconciles on real factors

A final on authoritative TR releases with counted records SHALL show the same figure in its dataset, PDF, XLSX and CSV.

#### Scenario: Electricity and billed natural gas

- **WHEN** TR records for 2025 are approved and locked, with every obligation met, and a final is issued
- **THEN** the status is final with no gap, every counted calculation is authoritative, and the outputs reconcile to figures derived independently from the cited release

### Requirement: An issued report states an earlier data year

An issued PDF and workbook SHALL state how many counted figures use a factor from a data year before the reporting year.

#### Scenario: ETKB's 2025 factor

- **WHEN** a final counts 2025 electricity on ETKB's factor, whose data year is 2024
- **THEN** its PDF and workbook say so, and it is no gap

### Requirement: The live Scope 3 line states its standing

A live PDF's and XLSX's Scope 3 line SHALL say so when any of its tonnes rest on non-authoritative factors, and it SHALL stay outside the inventory's total. An issued report SHALL keep Scope 3 as "Not covered" with no figure.

#### Scenario: A placeholder Scope 3 figure on a live report

- **WHEN** a live report's Scope 3 records include a non-authoritative figure
- **THEN** the PDF's and XLSX's Scope 3 line states it, in the report's language

#### Scenario: An issued report

- **WHEN** a report is issued
- **THEN** its output shows Scope 3 as "Not covered" with no figure
