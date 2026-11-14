# Proposal

## Why

On `qa.tonyai.io/register` the consent checkbox cannot be seen at all, and the text fields disappear into the white card until one is focused. The cause is one theme token: `--input` in `apps/web/app/globals.css` is `#FFFFFF`. shadcn/ui draws form-control borders with that token (`border-input`), so on a white card every border has a 1:1 contrast and only the faint `shadow-xs` remains. The value has been white since the scaffold (2026-06-30), so every form in the web app has the same problem: sign-in, data entry, users, subsidiaries. Registration is now live on hosted QA, and it is the first screen a new pilot company sees.

## What Changes

- Set the `--input` token to `#8E8E93` in both `:root` and `.dark` of `apps/web/app/globals.css`. Every control that draws its border with the token gets a visible border: text input, checkbox, textarea, select trigger, radio group, toggle and input group. The contrast is 3.26:1 on the white card and 3.12:1 on the `#FAFAFA` page background, which meets the 3:1 that WCAG 2.1 SC 1.4.11 (non-text contrast) asks of a control's boundary.
- Add a unit spec that reads `globals.css` and fails if `--input` falls below 3:1 against `--card` or `--background` in either block, so the token cannot silently return to an invisible value.
- Nothing else changes: component markup, sizes, layout, fonts, the green focus ring and the destructive (invalid) border all stay the same. The unchecked `switch` track, which fills with `bg-input`, turns grey instead of white; no screen uses `switch` today.

## Capabilities

### New Capabilities
- `web-form-controls`: how the web app's form controls look before anyone interacts with them, so a visitor can find every field and checkbox without focusing it first.

### Modified Capabilities
<!-- None: the registration page's requirement already asks for the fields and the consent checkbox; this change makes them perceivable everywhere, which belongs to the new capability. -->

## Impact

- Code: `apps/web/app/globals.css` (two lines and the comment above them); a new spec at `apps/web/lib/theme-contrast.spec.ts`.
- Screens: every form in `apps/web` shows grey control borders where it showed none. There is no API, data, schema or type change.
- Out of scope: dark mode (post-pilot, LP7; `.dark` keeps mirroring the light values), other theme tokens, and a component-rendering or visual-regression setup.
