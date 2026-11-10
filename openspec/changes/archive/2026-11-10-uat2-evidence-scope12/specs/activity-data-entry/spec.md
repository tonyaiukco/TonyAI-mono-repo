# Spec Delta

## ADDED Requirements

### Requirement: Submit shows the evidence vault before sending
On Submit, the Data Entry form SHALL save the record first. If its category is evidence-required and it has no file, the form SHALL stay open on the saved draft with the evidence vault visible, tell the user in TR or EN to attach a file, and not send the submit request. The API's refusal SHALL remain the final word.

#### Scenario: A new mobile record is submitted without a file
- **WHEN** a data_entry user fills a new Mobile Combustion record and clicks Submit
- **THEN** the record is saved as a draft, the form stays open with the evidence vault visible, a toast asks for a file, and the record is not submitted

#### Scenario: The user attaches a file and submits again
- **WHEN** the user then uploads a file in the vault and clicks Submit
- **THEN** the record is submitted and the form resets

#### Scenario: An exempt category submits in one click
- **WHEN** a user fills a new Waste record and clicks Submit
- **THEN** the record is saved and submitted without asking for a file

#### Scenario: The required note fits the category
- **WHEN** the vault of a Mobile Combustion, Refrigerants or Fugitive Gas record has no file
- **THEN** it shows the "required" badge and a note, in TR and EN, naming evidence such as a fuel receipt or card, a service record or a leak report
