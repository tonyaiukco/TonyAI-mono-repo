# Tasks

## 1. Password show/hide (BUG-09)

- [x] 1.1 Add `apps/web/lib/password-visibility.ts` (`passwordVisibility(visible)` → input type and label key) with `password-visibility.spec.ts`. Verify: `pnpm --filter web test` passes and the spec covers both states.
- [x] 1.2 Add `apps/web/components/auth/password-input.tsx` on `InputGroup`, `InputGroupInput` and `InputGroupButton` (design D1). It takes the input props through, and the button has `type="button"`, `aria-pressed`, a localised `aria-label` and the Eye/EyeOff icon. Add `auth.password.show` and `auth.password.hide` to `messages/{en,tr}/auth.json`. Verify: typecheck passes, and `lib/i18n/messages.spec.ts` (catalogue parity) passes.
- [x] 1.3 Use `PasswordInput` for `#password` on `app/login/page.tsx` and for `#new-password` and `#repeat-password` on `app/auth/set-password/set-password-form.tsx`, keeping each `id`, `autoComplete`, `required`, `aria-invalid` and `disabled`. Verify: typecheck passes, and the e2e login helper and `e2e/smoke.spec.ts` pass unchanged.
- [x] 1.4 Add a Playwright spec (`e2e/password-visibility.spec.ts`) for the `web-form-controls` scenarios, in EN and TR:
  - sign-in starts masked;
  - the toggle reveals and re-masks with its label switching;
  - Enter and Space on the toggle do not submit;
  - the two set-password fields toggle independently.

  Verify: the spec passes locally against built servers.

## 2. Generator metadata (BUG-10 remnant)

- [x] 2.1 Remove `generator: 'v0.app'` from `STATIC_METADATA` in `apps/web/app/layout.tsx`. Verify: `pnpm build` passes, and the sign-in page's served HTML (`curl` of `/login`) has no `name="generator"` meta tag, while the title and icon links are still present.

## 3. Draft and void wording (BUG-R2-12 remnant)

- [x] 3.1 Update the copy in design D2:
  - `messages/{en,tr}/bulkUpload.json`: every `summary.draftOne`, `summary.draftMany`, `applyConfirmOne` and `applyConfirmMany`, under both units;
  - `messages/{en,tr}/emissions.json`: `void.stopsCounting`.

  Verify: `grep -rn "sayılmaz\|counts towards no total\|stops counting" apps/web/messages` returns nothing, and catalogue parity passes.
- [x] 3.2 Update `apps/web/lib/void-view.spec.ts`, which asserts `/stops counting/i`, to assert the new sentence. Rename the title of the e2e test `e2e/void-record.spec.ts` "the withdrawn figure stops counting…" so it no longer quotes the old copy, if it asserts nothing on the text. Verify: `pnpm --filter web test` passes, and `e2e/void-record.spec.ts` passes.

## 4. Docs, status and checks

- [x] 4.1 Update `docs/roadmap_docs/project_status_roadmap_phases.md`:
  - a Current status entry, under the ten-entry rule;
  - Next up, item 4: change 1 of round 3 done;
  - Open questions: remove the two R2-12 notes this change settles, the bulk draft wording and `emissions.void.stopsCounting`.

  Also update `docs/architecture/` if the shared control belongs in its frontend notes. Verify: Current status holds at most ten entries.
- [x] 4.2 Run typecheck, lint, `pnpm build` and `pnpm test`. In a browser, at desktop width and at 375 px, check sign-in and set-password in EN and TR: the toggle sits inside the field border, focus shows the green ring, and an invalid set-password field keeps its red border around the button. Verify: every command passes, and the browser check is recorded for the PR body.
- [x] 4.3 Run `openspec validate uat3-ui-polish --strict`. Verify: it passes.

## Workflow follow-up

- Branch `feat/uat3-ui-polish` off `origin/main`. Commit and push on the owner's word. The owner merges, and the QA deploy runs on merge.
- Archive with `/opsx:archive`, syncing the `web-form-controls` and `record-lifecycle` deltas, then record the PR number.
