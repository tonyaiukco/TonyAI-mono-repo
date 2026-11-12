# Design

## Context

The motivation is in proposal.md, under "Why". This section records the state of the code at `origin/main` 47a66caa.

- **Users page.** `apps/web/app/users/page.tsx` is a Super Admin–only screen. Other roles get a 403 card. Its `load()` reads two things:
  - `GET /users` (`listUsersPage`). Each `UserSummaryDTO` carries `subsidiaryIds` only, and only for data_entry.
  - `GET /subsidiaries` (`listSubsidiaries`). This read is not paged and returns every subsidiary in the tenant. The page builds `subsidiaryNames` (id → `legalName`) from it, which today feeds only the access cell's hover `title`.
- **Access summary.** `accessSummary` (`apps/web/lib/users-view.ts:29`) returns one of three keys: `wholeOrganisation`, `noAccess` or `accessCount {count}`. Its one unit test asserts `accessCount`.
- **Row menu.** The "…" menu (`page.tsx:284`) is hidden on the self row. Its `editAccess` item appears only for data_entry rows and calls `setAccessTarget(member)`.
- **Dialogs.**
  - `InviteDialog` (`page.tsx:436`) shows `SubsidiaryChecklist` only for data_entry. It sends `subsidiaryIds: []` for other roles.
  - `SubsidiaryChecklist` (`page.tsx:408`) is a bare checkbox list.
  - `RoleDialog` (`page.tsx:556`) saves the role and closes.
  - `AccessDialog` (`page.tsx:612`) saves through `PUT /users/:id/access`.
- **API.**
  - `AccessAdminService.replaceSubsidiaryAccess` and `inviteMember` already refuse grants for any role other than data_entry (`access_role_mismatch`), and audit every added and removed grant.
  - `setRole` drops grants when a user leaves data_entry.
  - The guard scopes data_entry to its same-organisation grants and every other role to the whole organisation (`auth.guard.ts:118`).
- **Tests.** Web Vitest runs in `node` and covers `lib/**/*.spec.ts` only; there are no component tests. No Playwright spec drives `/users`.

## Goals / Non-Goals

**Goals:**
- Make multi-subsidiary access visible and editable from the users list, and its selection legible, without changing who may do what.
- Keep all new presentation logic in `lib/users-view.ts`, so that DB-free Vitest covers it.

**Non-Goals:**
- Any API, shared-types, Prisma, RLS or audit change.
- Per-subsidiary scoping for consultants (owner, 2026-11-12: whole-organisation view in the pilot).
- One email across several organisations (K1 option C, after the pilot).
- Refusing a Data Entry user with no grant. See decision 4.
- A search box in the picker. The pilot holding has ten subsidiaries, and the scrolling list stays.

## Decisions

1. **Resolve names on the web, not in the DTO.**
   - The page already loads the tenant's full subsidiary list, which is unpaged and readable by a Super Admin. `accessSummary` takes that id → name map and returns the names, sorted with `Intl.Collator` in the UI locale (so "Ç" and "İ" sort correctly in Turkish). It shows at most three, with an overflow count, plus the full sorted list for the tooltip.
   - A grant whose id is missing from the map can appear only if the subsidiary list is stale. Such an id counts toward the overflow and is never shown as a raw UUID.
   - *Alternative:* add `subsidiaries: {id, legalName}[]` to `UserSummaryDTO`. This was rejected because it reshapes the shared-types contract and the users query, would need an architect review, and the page already has the data.
2. **The summary keeps its key-plus-values shape.**
   - The return value becomes a discriminated union: `wholeOrganisation`, `noAccess`, or `named {names, overflow, all}`. The cell renders the names joined with ", " and appends the `accessMore` message ("+{count} daha" / "+{count} more") when the overflow is greater than 0.
   - The `accessCount` catalogue key is removed, because nothing else uses it. A catalogue parity test, if one exists, keeps TR and EN aligned.
3. **The edit access action moves out of the menu.**
   - An outline `Button size="sm"` labelled "Erişimi düzenle" / "Edit access" sits in the access cell of every data_entry row. Its aria-label names the user ("Edit access for {name}"). It opens the existing `AccessDialog`.
   - The `editAccess` menu item is removed, so the action has one obvious place.
   - Disabled data_entry accounts keep the action, as the menu offers it today. The API allows the change and audits it.
   - *Alternative:* keep both the button and the menu item. This was rejected: two paths to one action is what made the menu item easy to miss.
4. **An empty selection is warned, not blocked.**
   - The picker shows an amber inline warning when nothing is ticked, and Save and Invite stay enabled. The API already accepts zero grants.
   - Blocking would also stop a legitimate flow: inviting a person before their subsidiary exists. Change 4 (`uat2-standalone-default-subsidiary`) creates a default subsidiary for standalone customers.
   - The list's warning-styled "None granted" covers the follow-up.
5. **One picker component.** `SubsidiaryChecklist` gains:
   - a heading;
   - the "n / m selected" count, as a `selectedCount` message with ICU plural;
   - "Select all" and "Clear" text buttons, each disabled when it would change nothing;
   - the empty warning.

   The count and the warning do not depend on the list. With no subsidiary at all, the picker still reads "0 of 0 selected" and still warns, next to the "no subsidiaries yet" line. An invitation sent before any subsidiary exists is exactly the case decision 4 keeps open.

   The picker draws its own heading, so the invite dialog's `inviteDialog.subsidiaries` label key is removed; the dialog passes `subsidiariesHelp` as the picker's help line. The selection helpers go into `lib/users-view.ts` (`toggleSubsidiary`, `selectAll`, `selectionCount`) as pure functions with specs. The invite dialog and the access dialog both use the same component.
6. **The invite dialog shows a role note.** For any role other than data_entry it shows a `roleAccessNote.<role>` line in place of the picker, saying that the role sees the whole parent company. The picker's selection state persists while the role toggles; only the submitted body drops it, which is today's behaviour.
7. **The role dialog hands off to access.**
   - The role save's completion receives the API's answer for the user. When the old role was not data_entry and the answer's role is, the page sets `accessTarget` to that answer, which carries `subsidiaryIds: []` because `setRole` grants nothing. Using the answer avoids building the user locally.
   - The two steps stay separate API calls, each audited. Combining them would need a new endpoint, which is a non-goal.
   - If the second step is skipped, the list's "None granted" marks the user.

## Risks / Trade-offs

- [The subsidiary list goes stale while the page is open, for example after a subsidiary is added in another tab] → Saves already call `load()`, which re-reads both lists. A name missing from the map is never shown as a UUID (decision 1).
- [Long legal names make the access cell wide] → Each name is truncated with CSS (`max-w` plus `truncate`), and the tooltip holds the full text. The cap of three names bounds the cell.
- [Removing the menu item breaks a user's habit] → The users screen has existed only since LP4-01, and QA reported that the item was hard to find. The visible button is the fix.
- [No component tests] → The pure helpers get Vitest specs, and one new Playwright spec covers the rendered behaviour against the running stack.

## Migration Plan

This is a web-only change: no migration, no runbook 03 preflight and no API redeploy dependency. It ships through the normal QA auto-deploy on merge. Rollback is a revert of the web image. QA retests BUG-R2-01 on hosted QA with a Data Entry user granted several subsidiaries.
