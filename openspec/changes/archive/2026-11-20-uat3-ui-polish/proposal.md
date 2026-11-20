# Proposal

## Why

Three small UAT findings from rounds 1 and 2 are still open, and none is a defect: BUG-09, the BUG-10 remnant and the BUG-R2-12 remnant. Under the pre-pilot rule they would wait until after the pilot. The owner made them an exception on 2026-11-20 (Decisions 2026-11-20, D9; `uat3-decisions`) so they ship before the pilot, together, in one small web-only change.

## What Changes

- **BUG-09: show/hide on password fields.**
  - The sign-in password field gets a toggle that reveals and hides what was typed.
  - The same toggle goes on the two fields of the set-password screen (invitation and reset). These are the only other password inputs in the app, and one shared control keeps the three consistent. *Assumption: BUG-09 named the sign-in screen only. The owner may narrow the change to that field.*
  - The toggle is a real button with a localised label (TR/EN) that states its current action. It never submits the form, and it keeps the typed value and the browser's password-manager hints (`autocomplete`).
- **BUG-10 remnant: generator metadata.** The root layout's static metadata still declares `generator: 'v0.app'`, the scaffold's leftover, so every page's HTML carries `<meta name="generator" content="v0.app">`. The entry is removed. The localised title and the brand icons are already done: the title in LP3-01, the icons in `9e2a75cf` (2026-11-14).
- **BUG-R2-12 remnant: draft and void wording.** BUG-R2-12 replaced the dashboard's informal "counts towards nothing" with "not included in the calculation" (*hesaplamaya dahil edilmedi*). Two places still use the counting phrasing:
  - **Bulk upload's draft notes and apply confirmations:** "gönderilene kadar hiçbir toplama sayılmaz" / "counts towards no total".
  - **The void dialog's effect line:** "…sayılmaz hale gelir" / "It stops counting towards totals…".

  Both move to the *dahil edilmez* / "not included" wording. The meaning is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-form-controls`: adds a requirement that password fields offer a show/hide toggle.
- `record-lifecycle`: the requirement *A withdrawn record is described as not included in the calculation* is widened. It now covers the void dialog's effect line and bulk upload's draft wording, not only the dashboard and Emissions.

## Impact

- **Web only:**
  - `apps/web/app/login/page.tsx`;
  - `apps/web/app/auth/set-password/set-password-form.tsx`;
  - a shared password input under `apps/web/components/`;
  - `apps/web/app/layout.tsx`;
  - `apps/web/messages/{en,tr}/auth.json`, `bulkUpload.json` and `emissions.json`.
- **Tests:**
  - `apps/web/lib/void-view.spec.ts`, which asserts "stops counting";
  - unit tests for the new control;
  - the e2e login helper, which fills `#password` and must keep working;
  - a Playwright check of the toggle.
- **Not touched:** the API, shared types, Prisma, the factor library, and the record behaviour.
- **Deploy:** an image change. The QA deploy runs on merge.
