# Spec Delta

## ADDED Requirements

### Requirement: The library lists its sealed releases with their seal date
The API SHALL list the library's sealed releases to any signed-in user, whatever their role or organisation. The list SHALL include withdrawn releases, because past figures still cite them. It SHALL NOT include a release that is not sealed.

Each release SHALL carry its seal date: the time the database recorded when the release was sealed. The API SHALL NOT take the seal date from the release file or from any user input.

Listing releases SHALL change nothing. It SHALL write no audit row.

#### Scenario: A data entry user lists releases
- **WHEN** a data_entry user requests the release list
- **THEN** each sealed release is returned with its publisher, edition, status and seal date

#### Scenario: A withdrawn release is still listed
- **WHEN** a sealed release has been withdrawn by an erratum
- **THEN** it is still listed, with its seal date and its withdrawn status

#### Scenario: An unauthenticated request
- **WHEN** a request without a valid session asks for the release list
- **THEN** it is refused as unauthenticated

### Requirement: Screens show the seal date of the release behind a figure
Data Entry's calculation preview (beside its source and in its conversion note), the emissions record view and the review sheet SHALL show, beside the release they name, that release's seal date as a date in the user's locale. The label SHALL be "Paketin mühürlenme tarihi" in Turkish and "Package sealed on" in English. An issued report SHALL keep what it was issued with.

#### Scenario: A previewed natural gas figure
- **WHEN** a user previews a TR natural gas record priced from the TR package
- **THEN** the conversion note names the release and says "Paketin mühürlenme tarihi" with the date that release was sealed

### Requirement: The seal date is found through the figure's release
The seal date SHALL be found through the release that the figure's calculation names. A stored calculation SHALL NOT be rewritten to carry it. Where a figure names no release, or one the release list does not hold, the screen SHALL show no seal date and no other date in its place.

#### Scenario: An approved record priced before this change
- **WHEN** a user opens an approved record whose stored calculation names a release
- **THEN** the emissions record view shows that release's seal date, and the stored calculation is unchanged

#### Scenario: A figure with no release
- **WHEN** a record's calculation names no release
- **THEN** no seal date is shown
