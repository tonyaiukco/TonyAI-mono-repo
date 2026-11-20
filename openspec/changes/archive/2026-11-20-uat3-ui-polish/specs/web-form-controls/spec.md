# Spec Delta

## ADDED Requirements

### Requirement: Password fields offer a show/hide toggle
Every password field in the web app SHALL carry a toggle that reveals the typed characters and hides them again. Today these are sign-in and the two set-password fields. The field SHALL start hidden. The toggle SHALL be a keyboard-reachable button labelled, in the user's language, with the action it will take. Using it SHALL keep the typed value and the field's autocomplete hint, and SHALL never submit the form.

#### Scenario: Revealing the sign-in password
- **WHEN** a visitor types a password on the sign-in page and presses the toggle
- **THEN** the typed characters are shown as text
- **AND** the toggle's label changes from "Show password" to "Hide password" ("Şifreyi göster" to "Şifreyi gizle" in Turkish)

#### Scenario: Hiding it again
- **WHEN** the visitor presses the toggle a second time
- **THEN** the characters are masked again and the typed value is unchanged

#### Scenario: The toggle never submits
- **WHEN** a visitor focuses the toggle with the keyboard and presses Enter or Space
- **THEN** the password's visibility changes and the sign-in form is not submitted

#### Scenario: Set-password fields toggle independently
- **WHEN** a user on the set-password screen reveals the first password field
- **THEN** that field shows its characters and the repeat field stays masked

#### Scenario: A field starts masked
- **WHEN** the sign-in page or the set-password screen first renders
- **THEN** every password field is masked
