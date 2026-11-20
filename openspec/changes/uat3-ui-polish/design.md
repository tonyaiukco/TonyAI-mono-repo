# Design

## Context

See `proposal.md`. This section records the current state, checked on `main` at `a9fbd00d`.

- **Password fields.** There are three: sign-in (`apps/web/app/login/page.tsx`, `#password`, uncontrolled, `autoComplete="current-password"`) and set-password (`apps/web/app/auth/set-password/set-password-form.tsx`, `#new-password` and `#repeat-password`, controlled, `autoComplete="new-password"`). Each is a plain shadcn `Input type="password"`. Register has no password field: the invitation email leads to set-password.
- **Existing parts.** shadcn's `input-group.tsx` (`InputGroup`, `InputGroupInput`, `InputGroupAddon`, `InputGroupButton`) is present but unused by any screen. `lucide-react` provides `Eye` and `EyeOff`.
- **Web unit tests** run in Node on `lib/**/*.spec.ts` only (no DOM), so screen behaviour is covered with Playwright.
- **The e2e login helper** fills `#password` (`e2e/helpers.ts`), and the smoke spec reads `#password`.
- **Metadata.** `STATIC_METADATA` in `apps/web/app/layout.tsx` holds `generator: 'v0.app'` beside the icons. The title and description come from `generateMetadata`.
- **Copy.** The informal phrasing lives in these catalogue keys, read through `lib/bulk-upload-view.ts` and `lib/void-view.ts`:
  - `bulkUpload.json`: `summary.draftOne`, `summary.draftMany`, `applyConfirmOne`, `applyConfirmMany`, under both the row and the record units;
  - `emissions.json`: `void.stopsCounting`.

  `lib/void-view.spec.ts` asserts `/stops counting/i`.

## Goals / Non-Goals

**Goals:**
- One password control, used by all three fields, with the same behaviour and labels.
- Wording that meets the widened `record-lifecycle` requirement in both languages, without changing what any message means.

**Non-Goals:**
- Any change to the form layout, validation, password rules, or the sign-in and set-password flows.
- Other metadata (title, description, icons, Open Graph).
- Rewording any other message that mentions totals.

## Decisions

### D1 — A shared `PasswordInput` built on the existing input group

`apps/web/components/auth/password-input.tsx` wraps `InputGroup`, `InputGroupInput` and an end-aligned `InputGroupButton`:
- It takes every `Input` prop. It keeps `id`, `name`, `autoComplete`, `required`, `aria-invalid`, `disabled`, `value` and `onChange`, so controlled and uncontrolled callers both work and every label `htmlFor` still points at the input.
- It holds a `visible` state that switches the input's `type` between `password` and `text`.
- The button is `type="button"`, so it never submits. It has `aria-pressed={visible}` and an `aria-label` from `auth.password.show` or `auth.password.hide`, and shows `Eye` or `EyeOff` with `aria-hidden`.
- It is disabled when the input is disabled (set-password before its session loads).

**Why the input group:** it already draws the field's border, focus ring and invalid state around the button (`web-form-controls`), so no new styling is needed. Rejected: an absolutely positioned icon over a bare `Input`, which needs its own padding and focus styling.

**Unit-testable part:** the type and the label key for a given state come from a pure `passwordVisibility(visible)` in `apps/web/lib/password-visibility.ts`, with a Node spec.

### D2 — Copy

| Key (en / tr) | Old | New |
| :-- | :-- | :-- |
| `bulkUpload` drafts, en | "…it counts towards no total and does not appear in the review queue until…" | "…it is not included in any total and does not appear in the review queue until…" |
| `bulkUpload` drafts and apply confirmations, tr | "…gönderilene kadar hiçbir toplama sayılmaz ve inceleme kuyruğunda görünmez." | "…gönderilene kadar hesaplamaya dahil edilmez ve inceleme kuyruğunda görünmez." |
| `emissions.void.stopsCounting`, en | "It stops counting towards totals, reports and invoice coverage." | "It is no longer included in totals, reports or invoice coverage." |
| `emissions.void.stopsCounting`, tr | "Toplamlara, raporlara ve fatura kapsamına sayılmaz hale gelir." | "Toplamlara, raporlara ve fatura kapsamına artık dahil edilmez." |

New keys: `auth.password.show` ("Show password" / "Şifreyi göster") and `auth.password.hide` ("Hide password" / "Şifreyi gizle"). The key `void.stopsCounting` keeps its name, so `void-view.ts` does not change. Its spec asserts the new sentence.

### D3 — Remove only the generator entry

`generator` is deleted from `STATIC_METADATA`. Next.js then emits no generator tag, as it adds none by default. Icons and the localised title are untouched.

## Risks / Trade-offs

- **A revealed password could be shoulder-surfed** → the field starts masked, reveal is an explicit press, and nothing persists the state. A reload or remount masks it again.
- **Password managers key on `type="password"`** → the type is `password` on every render until the user presses the toggle, and `autocomplete` never changes.
- **The Turkish copy was owner-reviewed** (Decisions 2026-10-25) → the new lines use the BUG-R2-12 wording the team already accepted ("hesaplamaya dahil edilmez"). The owner reads them in review before merge.
- **A change to the input wrapper could break e2e selectors** → the input keeps `id="password"`, and the login helper and smoke spec are part of the verification.
