# Spec Delta

## Purpose

Defines what the inventory's main total counts, how Scope 3 appears beside it, and how each screen labels figures that rest on non-authoritative factors.

## ADDED Requirements

### Requirement: The main total counts Scope 1 and 2 only

Emissions totals, shares, trends and subsidiary totals, target progress and intensity numerators SHALL count Scope 1 and Scope 2. A Scope 3 record stays recordable and SHALL NOT change any of them.

#### Scenario: A year with all three scopes

- **WHEN** a year holds 10 t Scope 1, 20 t Scope 2 and 5 t Scope 3
- **THEN** the total reads 30 t, the Scope 3 figure reads 5 t on its own, and intensity and target progress use 30 t

#### Scenario: Live reports and the dashboard agree

- **WHEN** the same year is read on Emissions, the dashboard and a live report
- **THEN** all three show the same main total

### Requirement: Scope 3 is shown separately and labelled

A screen that shows a Scope 3 figure SHALL show it apart from the main total and SHALL label it as not covered by the total. A Scope 3 category's share of the total SHALL read as not applicable.

#### Scenario: Scope 3 tile

- **WHEN** Emissions shows the Scope 3 tile
- **THEN** its hint says the figure is not covered and is outside the total

#### Scenario: Filtering to a Scope 3 category

- **WHEN** the user selects only Scope 3
- **THEN** the screen shows the Scope 3 figures, with the main total's absence explained, and does not read as an empty year

### Requirement: No comparison without a Scope 1 or 2 figure

Target progress and intensity SHALL answer "no comparison" when their selection has no calculated Scope 1 or 2 figure. They SHALL NOT report 0 t, 100% or on track from Scope 3 records.

#### Scenario: A year with only Scope 3 figures

- **WHEN** a target's latest committed year holds only calculated Scope 3 records
- **THEN** its progress, percent and status are empty

#### Scenario: A Scope 3 target

- **WHEN** a target's scope is Scope 3
- **THEN** its row stays and its progress reads "not covered"

#### Scenario: Intensity on a Scope 3 selection

- **WHEN** intensity is read for a Scope 3 only selection
- **THEN** it returns no metric, and the panel says why

### Requirement: Each screen labels its own non-authoritative figures

The dashboard, each target row and each intensity card SHALL warn when the figures they show rest on non-authoritative factors, counted over the same records that produced the figure. When no such figure is present, the warning SHALL NOT appear.

#### Scenario: A target reads another year than the selection

- **WHEN** the selected year is authoritative and a target's own latest year holds a placeholder figure
- **THEN** that target's row warns and the selected year's dashboard does not

#### Scenario: Authoritative figures only

- **WHEN** every figure a screen shows is authoritative now
- **THEN** no placeholder warning appears there

#### Scenario: A Scope 3 placeholder

- **WHEN** only a Scope 3 figure is non-authoritative
- **THEN** a target or intensity reading Scope 1 and 2 does not warn
