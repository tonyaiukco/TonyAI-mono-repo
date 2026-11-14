# Design

## Context

See proposal.md (Why). The theme lives in `apps/web/app/globals.css`: a `:root` block of hex tokens, a `.dark` block that repeats the light values (dark mode is post-pilot, LP7), and an `@theme inline` block that maps `--color-input` to `var(--input)`. Thirteen shadcn components in `apps/web/components/ui/` use the token. In light mode only these read it: `border-input` (input, checkbox, textarea, select, radio-group, toggle, input-group) and `bg-input` (the switch's unchecked track). The `dark:` variants (`dark:bg-input/30` and others) never apply, because nothing in the app sets the `dark` class (`components/theme-provider.tsx` exists but nothing imports it).

The web package's Vitest runs in a Node environment over `lib/**/*.spec.ts`. It has no DOM rendering and no visual-regression tooling.

## Goals / Non-Goals

**Goals:**
- Fix the problem at the token, so every current and future form control inherits the fix.
- Guard the token with a test that runs in `pnpm test`, which gates CI.

**Non-Goals:**
- Per-component restyling, a larger checkbox, hover states or new tokens.
- A DOM or screenshot-based visual test harness.

## Decisions

**1. Change the shared `--input` token, not the register page.** One value fixes every form. A page-level class override would leave sign-in and data entry invisible and would split the look between screens. Alternative considered: override `border-input` only in `app/register/page.tsx`. Rejected because it treats the symptom on one screen.

**2. Use `#8E8E93`, not shadcn's default (the `--border` value `#D2D2D7`).** The owner chose it. `#8E8E93` is Apple's system grey, so it matches the theme's existing Apple-style neutrals (`#1D1D1F`, `#6E6E73`, `#D2D2D7`), and it is the lightest of those neutrals that reaches 3:1 on white (3.26:1; 3.12:1 on `#FAFAFA`). `#D2D2D7` reaches only 1.51:1, and `#A1A1A6` only 2.57:1. Card dividers keep `--border`, so control outlines are a step darker than structural lines. That helps a form read as a form.

**3. Set the same value in `.dark`.** `.dark` mirrors light today. Leaving `#FFFFFF` there would bring the bug back the day someone turns the class on before LP7 designs a real dark palette.

**4. Guard the token with a source-reading spec at `apps/web/lib/theme-contrast.spec.ts`.** The spec reads `app/globals.css`, extracts `--input`, `--card` and `--background` from each of `:root` and `.dark`, computes WCAG relative-luminance contrast, and asserts at least 3:1 for each pair, with the block and pair in the failure message. It sits under `lib/` because the Vitest `include` is `lib/**/*.spec.ts`. Alternative considered: a Playwright check of computed `border-color` on `/register`. Rejected for now, because CI does not run e2e on every PR and a computed-style check adds nothing the token check misses: every listed control takes its colour from the token.

## Risks / Trade-offs

- [The switch's unchecked track turns mid-grey instead of white] → No screen uses `Switch` today. If one does later, grey is shadcn's intended unchecked look.
- [A control on a muted surface (`#F2F2F5`, `#EBEBF0`) gets 2.92:1 or 2.74:1, just under 3:1] → Forms sit on cards or the page background today. The spec guards the surfaces controls actually use and does not claim the muted ones.
- [Grey borders make dense tables with inline inputs look heavier] → Accepted. Being able to see the controls matters more than lightness, and the change is one token if the owner wants a different grey after seeing QA.

## Migration Plan

Ship with the next web deploy to QA. Rollback is reverting the two token lines; no data or API is involved.
