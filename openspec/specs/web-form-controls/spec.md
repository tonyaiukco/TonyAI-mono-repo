# web-form-controls Specification

## Purpose
Keeps the web app's form controls perceivable before anyone interacts with them, so a visitor can find every field, checkbox and selector on a screen without focusing it first.

## Requirements

### Requirement: Form controls show their boundary at rest
The web app SHALL draw a visible boundary around every text field, text area, select trigger, checkbox, radio button, toggle and input group while the control is idle, unfocused and empty. The boundary SHALL contrast at least 3:1 with the card surface and with the page background the control sits on.

#### Scenario: Registration fields are visible before focus
- **WHEN** a signed-out visitor opens the registration page
- **THEN** every text field on the form shows its border before any field is focused
- **AND** the border's contrast with the white card is at least 3:1

#### Scenario: The consent checkbox is visible before it is ticked
- **WHEN** a signed-out visitor opens the registration page
- **THEN** the unticked consent checkbox shows its box outline
- **AND** the outline's contrast with the white card is at least 3:1

#### Scenario: Other forms share the same boundary
- **WHEN** a signed-in user opens a screen with a form, such as sign-in or data entry
- **THEN** its idle text fields, select triggers and text areas show the same border as the registration page

#### Scenario: A theme value too light to see is caught
- **WHEN** the form-control border colour is set below 3:1 contrast against the card or the page background
- **THEN** the web app's unit tests fail and name the failing pair

### Requirement: Interaction states keep their current look
Making the idle boundary visible SHALL NOT change how a control looks when focused, ticked, invalid or disabled: focus keeps its green ring, a ticked checkbox stays filled with the primary colour, an invalid control keeps its destructive border, and a disabled control stays dimmed.

#### Scenario: Focus still shows the green ring
- **WHEN** a visitor focuses a text field on the registration page
- **THEN** the field shows the green focus border and ring, as before the change

#### Scenario: An invalid registration code keeps its red border
- **WHEN** a visitor submits a malformed registration code
- **THEN** the code field shows the destructive border and the error message, as before the change

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
