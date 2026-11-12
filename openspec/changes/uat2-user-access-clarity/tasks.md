# Tasks

## 1. Access summary with names (lib)

- [x] 1.1 In `apps/web/lib/users-view.ts`, change `accessSummary(member, names, locale)` to return one of `{key:"wholeOrganisation"}`, `{key:"noAccess"}` or `{key:"named", names, overflow, all}`:
  - Sort with `Intl.Collator` in the UI locale.
  - Show at most three names.
  - Count ids missing from the map in `overflow`, never as a UUID.
  - `all` is the full sorted list, for the tooltip.

  Verify with `users-view.spec.ts`. Replace the `accessCount` assertion and add cases for:
  - two grants in name order (Turkish collation, e.g. "Çorum" before "Denizli");
  - five grants → three names and an overflow of 2;
  - an id missing from the map;
  - zero grants → `noAccess`;
  - consultant, executive_viewer and super_admin → `wholeOrganisation`.
- [x] 1.2 Add pure selection helpers to `lib/users-view.ts`: `toggleSubsidiary`, `selectAllSubsidiaries` and `selectionState` (selected count, total, `allSelected`, `noneSelected`). Verify with specs: toggling on and off, select all on an empty list and on a full list, and a count that ignores ids not in the list.

## 2. Copy (TR + EN)

- [x] 2.1 In `apps/web/messages/{en,tr}/users.json` (follow the `localise-ui` skill):
  - Remove `accessCount`.
  - Add `accessMore` ("+{count} more" / "+{count} daha").
  - Change `actions.editAccess` to "Edit access" / "Erişimi düzenle", and add `actions.editAccessFor` ("Edit access for {name}" / "{name} için erişimi düzenle") as the aria-label.
  - Add the picker's copy: `picker.heading`, `picker.selectedCount` ("{count} of {total} selected" / "{count} / {total} seçili"), `picker.selectAll` ("Select all" / "Tümünü seç"), `picker.clear` ("Clear" / "Temizle") and `picker.emptyWarning` ("This user cannot enter data until at least one subsidiary is ticked." / "En az bir bağlı şirket işaretlenene kadar bu kullanıcı veri giremez.").
  - Add `roleAccessNote.{consultant,executive_viewer,super_admin}`: each says the role sees every subsidiary of the parent company and needs no subsidiary choice, in the tier names of `organisation-hierarchy`.

  Verify that both files have the same key set (a short `node -e` key-diff in the task log) and that `pnpm typecheck` passes.

## 3. Users screen

- [x] 3.1 Access cell in `apps/web/app/users/page.tsx`:
  - Render the `named` summary as names joined with ", ", each truncated, plus `accessMore` when the overflow is greater than 0, with `all` in the `title`.
  - Render `noAccess` with the warning style (amber text and icon).
  - On every data_entry row, add an outline small "Erişimi düzenle" button with the `editAccessFor` aria-label that opens `AccessDialog`.
  - Remove the `editAccess` item from the "…" menu.

  Verify with `pnpm typecheck` and the e2e in 4.1.
- [x] 3.2 Rebuild `SubsidiaryChecklist` on the 1.2 helpers. Add the heading, the `selectedCount` line, "Select all" and "Clear" (each disabled when it would change nothing) and the inline `emptyWarning` when nothing is ticked. Keep Save and Invite enabled. Keep the `noSubsidiaries` state. Use it unchanged in `InviteDialog` and `AccessDialog`. Verify with the e2e in 4.1.
- [x] 3.3 In `InviteDialog`, show `roleAccessNote.<role>` in place of the picker for every role other than data_entry. Keep the ticked selection in state while the role toggles; the request body still sends `[]` for other roles. Verify with the e2e in 4.1: choose Consultant, see the note; choose Data Entry again, and the earlier ticks are still there.
- [x] 3.4 Make `RoleDialog`'s save callback report the old and new role. When a user moves from another role to data_entry, open `AccessDialog` for that user with `subsidiaryIds: []`. Closing it leaves the role saved. Verify with the e2e in 4.1.
- [x] 3.5 Check loading, empty, error and 403 states: the access cell before subsidiaries load, an organisation with no subsidiaries, and a failed save toast in `AccessDialog`. Verify by exercising the page against the local stack (`pnpm dev`) as `admin@tonyai.local` in TR and EN.

## 4. End-to-end and docs

- [x] 4.1 Add `e2e/users-access.spec.ts` (follow the `e2e-flow` skill; log in as `admin@tonyai.local`). It must not create accounts:
  - **Edit and restore.** Read `entry@tonyai.local`'s grants through the API. Grant one more subsidiary from the row's visible "Erişimi düzenle" button. Assert that the access column names it and that the "…" menu has no edit access item. Restore the original grants in `afterEach`/`finally`.
  - **Picker without submit.** Open the invite dialog, then check the role note for Consultant, "Select all" → "n / n seçili", "Clear" → the empty warning, and that ticks persist across a role toggle. Cancel without inviting.
  - **Role change.** Change `review@tonyai.local` (consultant) to Data Entry. Assert that the access editor opens with the empty warning. Close it, and assert "Erişim verilmedi". Restore the consultant role in `finally`.
  - Run every check in both TR and EN for the copy.

  Verify that `pnpm e2e e2e/users-access.spec.ts` passes locally, with the int/e2e environment noted in memory (test password, rate limits).
- [x] 4.2 Update the users-screen description in `docs/architecture/security.md` (Account lifecycle). It must say:
  - the access column names a Data Entry user's subsidiaries;
  - edit access is a row action;
  - a role change to Data Entry opens the access editor;
  - grants mean nothing for other roles (consultants see the whole parent company in the pilot, owner 2026-11-12).

  Verify that no `docs/api/` file changes, because the API is unchanged.

## 5. Integration and review

- [x] 5.1 Run `pnpm typecheck`, `pnpm build`, `pnpm test` and the new e2e spec, plus the existing specs that visit `/users` or `/audit` (`admin-screens-turkish`, `bounded-reads`). Verify that all are green; anything that fails only locally is named in the PR, as recorded in memory.
- [x] 5.2 Run the review pass before the PR. This change touches no calc path, factor, RLS, tenant scoping, lifecycle or contract, so one `qa-auditor` pass is enough. It covers:
  - test coverage of the helpers and the e2e;
  - TR/EN copy and tier names against `organisation-hierarchy`;
  - that no API or shared-types file changed;
  - that a consultant row offers no access edit.

  Verify that findings are fixed, or filed under Open questions per the pre-pilot rule.
- [x] 5.3 Run `openspec validate uat2-user-access-clarity --strict` and verify that it passes.

## Workflow follow-up

- Commit and open the PR when the owner asks; the owner merges.
- After the merge, the QA auto-deploy runs. The owner or QA retests BUG-R2-01 on hosted QA with a Data Entry user granted several subsidiaries.
- Add the Current status entry and update Next up (change 2 done; next is `uat2-consultant-approval`), then archive with `/opsx:archive`.
