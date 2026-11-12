# Proposal

## Why

QA reported BUG-R2-01 as a P1 blocker: one person cannot be assigned to several subsidiaries of the same parent company. The team's K1 answer (decision memo 2026-11-11) found that the data model already supports this. A Data Entry user holds any number of subsidiary grants. The User Management screen hides the feature, though:

- The access column reads "Bağlı şirket: 2" (EN "Subsidiaries: 2"). The names appear only in a hover tooltip.
- "Bağlı şirket erişimini düzenle" sits inside the "…" row menu, and it appears there only for Data Entry rows.
- In the invite dialog, the subsidiary checklist is a plain list. It shows no count, has no select-all and clear controls, and disappears without comment when another role is chosen.
- A Data Entry user with no grant can be invited. That user can do nothing, and the screen does not say why.

The team asked for multi-subsidiary assignment to be "clear and working" in the UI. This is change 2 of the six UAT2 changes (Next up, Decisions 2026-11-12).

## What Changes

- **Access column names the subsidiaries.**
  - For a Data Entry user, the column lists the names of the granted subsidiaries, in name order. The first three are shown; any others become "+N more" ("+N daha"). The full list stays in the tooltip.
  - A Data Entry user with no grant reads "Erişim verilmedi" / "None granted", styled as a warning.
  - Every other role still reads "Ana şirketin tamamı" / "Whole parent company".
- **"Erişimi düzenle" / "Edit access" becomes a visible button** in the access cell of every Data Entry row. The item leaves the "…" menu, which keeps the role, re-send and enable or disable actions.
- **The subsidiary picker is clearer.** One picker serves both the invite dialog and the access dialog. It has:
  - a heading;
  - a "n / m seçili" ("n of m selected") count;
  - "Tümünü seç" / "Select all" and "Temizle" / "Clear" controls;
  - an inline warning when no subsidiary is ticked, saying that the user cannot enter data until one is.

  The warning does not block saving.
- **The invite dialog states every role's access.** Choosing Consultant, Executive Viewer or Super Admin shows a note that the role sees the whole parent company and needs no subsidiary choice. Before, the picker disappeared with no explanation.
- **A role change to Data Entry leads to access.** After a user's role changes to Data Entry, the access dialog opens for that user. Before, the user was left with no grant and no prompt to add one.
- **Unchanged:**
  - The API, its contract and the access rules. Data Entry works only in granted subsidiaries; Consultant, Executive Viewer and Super Admin see the whole parent company. The owner confirmed on 2026-11-12 that consultants keep whole-organisation view in the pilot.
  - The `user_subsidiary_access` model.
  - Who may manage users: Super Admin only.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `organisation-hierarchy`: adds requirements for how a user's access to subsidiaries is presented and edited. The archived `uat2-team-decisions-copy` proposal named this capability as the home for K1's later changes. The requirements cover:
  - which roles' access depends on grants;
  - how the users list names granted subsidiaries;
  - the visible edit action;
  - the picker's count, select-all and empty-selection warning;
  - the per-role access note in the invitation;
  - the access step after a role change to Data Entry.

## Impact

- **Web:**
  - `apps/web/app/users/page.tsx`: the access cell, the row menu, `SubsidiaryChecklist`, `InviteDialog`, `RoleDialog` and `AccessDialog`.
  - `apps/web/lib/users-view.ts`: the access summary, which now resolves names and handles the overflow, and its spec.
  - `apps/web/messages/{en,tr}/users.json`.
- **E2E:** a new Playwright spec for the users screen. It covers the visible edit action, the multi-subsidiary invite and the names in the access column. No spec drives `/users` today.
- **Docs:** `docs/architecture/security.md`, where it describes the users screen. No `docs/api/` change is needed, because the API is unchanged.
- **API, shared types, Prisma, RLS:** none.
- **Status file:** the Current status entry after the change merges and deploys.
