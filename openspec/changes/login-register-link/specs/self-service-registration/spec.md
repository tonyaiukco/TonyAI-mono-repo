# Spec Delta

## ADDED Requirements

### Requirement: The sign-in page links to registration while it is open
The sign-in page SHALL show a link to the registration page, in Turkish and English, while the environment's registration is open, and SHALL show no such link where registration is off or its state cannot be read. The link SHALL lead to the registration page of the same web app. Signing in SHALL NOT depend on the registration state being known.

#### Scenario: Registration is open
- **WHEN** a signed-out visitor opens the sign-in page of an environment whose registration is open
- **THEN** the page shows the registration link, and following it opens the registration page on the same host

#### Scenario: Registration is off
- **WHEN** a signed-out visitor opens the sign-in page of an environment whose registration is off
- **THEN** the page shows the sign-in form with no registration link and no message about registration

#### Scenario: The registration state cannot be read
- **WHEN** the sign-in page cannot read whether registration is open
- **THEN** the page shows no registration link and no error, and the visitor can still sign in

#### Scenario: Language
- **WHEN** a visitor whose interface language is Turkish opens the sign-in page while registration is open
- **THEN** the registration link is in Turkish
