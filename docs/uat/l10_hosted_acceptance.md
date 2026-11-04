# L10 hosted acceptance checklist (QA)

QA runs this checklist on hosted QA to close the L10 gate. The live release is
`ci4-1` (source `bdf7646`) unless the owner announces another one. Fill in **every**
row: PASS, FAIL (with a defect report) or N/A (with a reason the owner accepts).
Procedure, scope and the automated probes are in
[runbook 11](../../infra/runbooks/11-qa-hosted.md#ci4-1-l10-acceptance-from-2026-11-04).

**Out of scope.** Numerical emission figures (LP4-02) and full recovery (G2/LP5-03).
No authoritative factor library is loaded, so categories with no factor show
"Not calculated" and refuse a preview with `no_factor`. That is the expected
result, not a defect. Never ask for placeholder factors to be loaded.

## Rules for every row

- Use only the two new synthetic holdings (H1, H2) and their own invited users.
  Do not change the five-person QA cohort or any other account. Users in different
  holdings need different email addresses.
- **Evidence:** a screenshot or the request/correlation ID, kept in the owner's
  private store. In the **Evidence** column write only its reference (for example
  `QA-H1-07.png`).
- Never record passwords, tokens, invitation or reset links, signed URLs or real
  personal data, here or in a screenshot. Redact before saving.
- Write the release the row ran on (the `ci…` suffix the owner announced) in
  **Release**. A row that ran on another release must be rerun or carry an
  owner-accepted note.
- **Suspected cross-tenant exposure:** stop, tell the owner privately at once,
  and keep minimal sanitized evidence.
- **Mail quota:** the Azure-managed sender allows 5 messages a minute and 10 an
  hour. Pace invitations and resets; a quota refusal is not a product defect.
- UI copy is checked in both languages. Rows name screens and messages by their
  English labels.

## 1. Accounts, roles and mail (H1, then H2)

| ID | Steps | Expected | Result | Evidence | Release |
|---|---|---|---|---|---|
| AC-01 | H1 first super_admin opens the invitation email and sets a password | Email arrives (check spam); the link opens the set-password screen; sign-in succeeds |  |  |  |
| AC-02 | H1 super_admin creates one subsidiary and one site, then invites a second super_admin, a data_entry (assigned to that subsidiary), a consultant and an executive_viewer | Four invitation emails arrive; each user signs in after setting a password |  |  |  |
| AC-03 | Open an already-used invitation link again | Refused; no second account and no password change |  |  |  |
| AC-04 | Request a password reset for the H1 consultant; complete it | Reset email arrives; the new password works; the old one is refused |  |  |  |
| AC-05 | Reuse that reset link after completing it | Refused |  |  |  |
| AC-06 | Request a reset; wait past its expiry without using it; then open it | Refused as expired (run at the end of the round) |  |  |  |
| AC-07 | H1 super_admin disables, then re-enables, the H1 consultant | While disabled, sign-in and existing sessions are refused (`account_disabled` / `session_revoked`); after re-enabling, sign-in works |  |  |  |
| AC-08 | Repeat AC-01 and AC-02 for H2, at least for its first and second super_admin | As AC-01/02 |  |  |  |
| AC-09 | Check every email above in TR and EN (the user's language setting) | Subject and body in the chosen language; no raw message keys |  |  |  |

## 2. Role permissions (H1)

| ID | Steps | Expected | Result | Evidence | Release |
|---|---|---|---|---|---|
| RL-01 | data_entry opens a subsidiary that is not assigned to them | Not visible or refused; no data shown |  |  |  |
| RL-02 | consultant tries to create, edit or approve a record | Refused (`record_create_forbidden` or equivalent); review/read works |  |  |  |
| RL-03 | executive_viewer tries any mutation (record, subsidiary, user) | Every attempt refused; read and export work |  |  |  |
| RL-04 | data_entry or consultant tries to create, edit or delete a subsidiary | Refused; only super_admin manages subsidiaries |  |  |  |

## 3. Record lifecycle, approval and lock (H1)

| ID | Steps | Expected | Result | Evidence | Release |
|---|---|---|---|---|---|
| RC-01 | data_entry creates a **Water** record in an unlocked month | Saved as draft; shows "Not calculated" (`no_emission_factor`), **never 0** |  |  |  |
| RC-02 | Submit it without evidence | Refused with `evidence_required` |  |  |  |
| RC-03 | Attach a valid evidence file (PDF or image, under 10 MiB); submit as the author | Submitted |  |  |  |
| RC-04 | A different user (not the author) tries to submit another draft by data_entry | Refused with `record_author_forbidden` |  |  |  |
| RC-05 | The first super_admin authors and submits a record, then tries to approve it | Refused with `self_approval_forbidden` |  |  |  |
| RC-06 | The second super_admin approves the data_entry record from RC-03 | Approved; the approver is recorded |  |  |  |
| RC-07 | Reject a submitted record with a reason; the author edits and resubmits it | Rejected with the reason visible; resubmission works |  |  |  |
| RC-08 | super_admin locks a month that holds no pending or rejected record | Locked |  |  |  |
| RC-09 | Try to create, edit or delete a record in the locked month (any role) | Refused with `period_locked` |  |  |  |
| RC-10 | Try to lock a month that holds a rejected record | Refused |  |  |  |
| RC-11 | Electricity: open the calculation preview for a UK or TR site | Refused with `no_factor` and coverage shown; no figure, no placeholder value |  |  |  |
| RC-12 | Audit log after RC-01 to RC-09 | One row for each create, update, submit, approve, reject, lock and evidence action; no row can be edited or deleted from the UI |  |  |  |
| RC-13 | data_entry tries to save a Natural Gas, Fuel or Electricity record for a UK or TR site | Not saved with a figure: refused with `no_factor` (coverage shown) or the category is not offered; never a placeholder value |  |  |  |

## 4. Evidence and files (H1)

| ID | Steps | Expected | Result | Evidence | Release |
|---|---|---|---|---|---|
| EV-01 | Upload a file over 10 MiB, then a disallowed type (for example `.exe`) | Both refused with a clear message |  |  |  |
| EV-02 | Download the evidence from RC-03 | Downloads; the link stops working about 60 seconds later |  |  |  |
| EV-03 | Paste a downloaded evidence link into a signed-out browser after expiry | Refused |  |  |  |

## 5. Reports (H1)

| ID | Steps | Expected | Result | Evidence | Release |
|---|---|---|---|---|---|
| RP-01 | Export PDF, XLSX and CSV for the year holding the RC records | All three download and open |  |  |  |
| RP-02 | Check Scope 3 in each export | Water is absent from the ledger, totals and CSV; PDF and XLSX state Scope 3 "Not covered" |  |  |  |
| RP-03 | Check covered rows with no factor, if any | Shown as "Not calculated", never as a number |  |  |  |
| RP-04 | Issue a report (dataset), then download the same issued PDF twice | Both downloads give the same file; the issuance appears in history |  |  |  |
| RP-05 | executive_viewer downloads the issued report | Works (read/export only) |  |  |  |
| RP-06 | Repeat RP-01 in the other language | Headings, labels and statuses in that language; numbers and dates formatted for it |  |  |  |

## 6. Localisation (any holding)

| ID | Steps | Expected | Result | Evidence | Release |
|---|---|---|---|---|---|
| LO-01 | Walk the dashboard, data entry, review, reports, inventory boundary, users and settings in TR, then EN | No untranslated text, raw message keys or mixed languages on a screen |  |  |  |
| LO-02 | Trigger three refusals above (RC-02, RC-05, RC-09) in each language | Each message is specific and translated, not a generic error |  |  |  |
| LO-03 | Enter a decimal quantity in TR format (`1.234,5`) and in EN format (`1,234.5`) | Both are stored as the same quantity |  |  |  |

## 7. Isolation between holdings (H1 and H2)

These rows need known objects in **both** holdings: subsidiaries, records, evidence
and an issued report. A random ID that returns 404 does not prove isolation.

| ID | Steps | Expected | Result | Evidence | Release |
|---|---|---|---|---|---|
| IS-01 | H2 super_admin opens the URL of an H1 subsidiary, record, evidence and issued report (IDs the owner provides) | Each refused or not found; no H1 data shown |  |  |  |
| IS-02 | H2 lists subsidiaries, records, users and audit | Only H2 objects |  |  |  |
| IS-03 | H1 super_admin invites an address already used in H2 | Refused (`email_unavailable`); no cross-holding account |  |  |  |
| IS-04 | Repeat IS-01 from H1 against H2 objects | Same as IS-01 |  |  |  |

## Sign-off

| Item | Value |
|---|---|
| QA lead |  |
| Dates (Europe/Istanbul) |  |
| Releases covered |  |
| Rows PASS / FAIL / N/A |  |
| Defects raised (IDs) |  |
