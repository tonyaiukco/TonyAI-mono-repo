# Spec Delta

## Purpose

The dashboard's data collection matrix shows each subsidiary and category's collection status for the selected reporting year, and leads from a cell to the place where that pair is entered or reviewed.

## ADDED Requirements

### Requirement: A matrix cell opens its summary with working links
Choosing a matrix cell, by click or keyboard, SHALL open a popover instead of navigating. The popover SHALL show the cell's category, status and counts. It SHALL offer two links: "Open in Data Entry", for that subsidiary, category and year, and "View record history", which opens Emissions on its History tab filtered to that subsidiary, category and year. No text in the cell's summary SHALL look like a link unless it is one.

#### Scenario: Opening Data Entry from a cell
- **WHEN** a user clicks the Natural Gas cell of TonyAI Energy for 2026 and then "Open in Data Entry"
- **THEN** Data Entry opens with that subsidiary, the Natural Gas category and the year 2026 selected

#### Scenario: Opening the record history from a cell
- **WHEN** a user clicks a cell and then "View record history"
- **THEN** Emissions opens on its History tab, listing only that subsidiary's records in that category and year, whatever their status

#### Scenario: Keyboard use
- **WHEN** a user focuses a cell and presses Enter
- **THEN** the popover opens with focus inside it, and Escape closes it and returns focus to the cell

#### Scenario: No dead link
- **WHEN** the popover is open
- **THEN** every link-styled text in it navigates when chosen

### Requirement: A cell's accessible name is unchanged by the popover
A matrix cell's accessible name SHALL keep its current form: subsidiary and category first, then status and counts. Assistive technology SHALL read the same summary that it reads today.

#### Scenario: Name prefix
- **WHEN** a screen reader reaches the Natural Gas cell of TonyAI Energy
- **THEN** its name starts with "TonyAI Energy Natural Gas" and still contains the status and invoice counts
