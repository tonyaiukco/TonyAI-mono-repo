# Spec Delta

## Purpose

Controls who may be given an account and who may set its password: invitations that would reveal an existing account are bounded and audited, and a password is set only through an email link, with reauthentication for older sessions and an audit row.

## ADDED Requirements

### Requirement: A refused invitation is audited

When an invitation is refused because the address already has an account, the system SHALL write an `invite_refused` audit row for the inviting administrator's organisation, naming the actor and the reason and never the address, in addition to answering `email_unavailable`.

#### Scenario: An address with an account

- **WHEN** a `super_admin` invites an address that has a profile in any organisation
- **THEN** the answer is 409 `email_unavailable`, no profile or invitation is created, and one `invite_refused` audit row without the address is written

#### Scenario: A new address

- **WHEN** a `super_admin` invites an address that has no account
- **THEN** the invitation is created as before and no `invite_refused` row is written

### Requirement: Refusals are bounded per organisation

Once an organisation has 5 `invite_refused` rows within the last hour, the system SHALL refuse every further invitation from that organisation with 429 `invite_refusals_exhausted` and a `Retry-After` until the oldest ages out, before looking the address up, until fewer than 5 remain in the window. A refusal for this reason SHALL write no `invite_refused` row and create nothing.

#### Scenario: The sixth probe

- **WHEN** an organisation with 5 `invite_refused` rows in the last hour sends another invitation, for a new or an existing address
- **THEN** both answer 429 `invite_refusals_exhausted`, with the same body, and nothing is written

#### Scenario: Another organisation

- **WHEN** a different organisation invites while the first is over its bound
- **THEN** its invitation is handled normally

#### Scenario: The window passes

- **WHEN** the organisation's refusals fall below 5 within the last hour
- **THEN** its invitations are handled normally again

### Requirement: The set-password screen serves only an email-link session

The set-password screen SHALL offer a password field only to a session that an invitation or recovery link opened in the same browser tab within the last hour, for the same user, checked when the screen loads and again when the password is submitted. Any other visitor, signed in or not, SHALL be told to use the link from their email and SHALL be offered no field. This is a screen behaviour: the server-side control on a password change is the authentication service's reauthentication.

#### Scenario: From an invitation or recovery link

- **WHEN** a person opens their email link, continues, and lands on the set-password screen
- **THEN** the screen offers the password fields

#### Scenario: A signed-in visitor without a link

- **WHEN** a signed-in user opens `/auth/set-password` directly, or after more than an hour, or in another tab
- **THEN** the screen offers no password field and says to use the link from their email

### Requirement: An older session needs reauthentication to change the password

The authentication service SHALL require the emailed reauthentication code for a password change from a session older than 24 hours, locally and on every hosted environment, and a hosted deploy's readback SHALL fail when the setting differs.

#### Scenario: A stolen older session

- **WHEN** a client holding a session older than 24 hours asks the authentication service to change the password without a reauthentication code
- **THEN** the change is refused and the password stays as it was

#### Scenario: The email-link flows

- **WHEN** a person sets a password from an invitation or recovery link
- **THEN** no reauthentication code is asked for

#### Scenario: Configuration drift

- **WHEN** a hosted environment's authentication settings do not require reauthentication
- **THEN** the deploy's readback fails

### Requirement: A set password is audited

After the authentication service accepts a new password from the set-password screen, the web app SHALL record it with the API for the user the screen checked, with that session's token, and the API SHALL write one `password_set` audit row as that user, carrying the flow (`invite` or `recovery`) and nothing about the password. The row is the web app's report, not the authentication service's.

#### Scenario: A password set

- **WHEN** a person saves a password from an invitation or recovery link
- **THEN** one `password_set` audit row names them as the actor, with the flow

#### Scenario: The record fails

- **WHEN** the API cannot be reached after the password was saved
- **THEN** the password stays set, the person goes on, and the attempt is repeated a bounded number of times
