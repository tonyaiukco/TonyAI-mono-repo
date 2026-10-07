---
name: localise-ui
description: Put a TonyAI screen's copy into the TR/EN catalogues, add a stable API error code end to end (registry → throw → catalogue → test), and read or show numbers and dates by the user's locale. Use when building or touching any user-facing screen, toast, email or report copy, or when an API refusal needs its own wording on screen. Not for new resources (tenant-api-module) or report assembly (report-generation) — those call this for their copy.
---

# localise-ui

The foundation is LP3-01: `use-intl` catalogues on the web, a `code` on every
API error, locale-aware numeric input. The canonical exemplar is the Data Entry
form (`apps/web/app/data-entry/page.tsx`) and its error toasts. README
"Localisation and error codes" holds the decisions; this file holds the steps.

## Rules (must hold)

- **Turkish lives only in `apps/web/messages/tr/*.json`** (and, later, a
  module's `i18n/tr.json` on the API). Keys, code, comments, docs and commit
  messages stay English. Tests may carry Turkish strings as fixtures.
- **No user-facing literal in a component.** Every sentence, label, placeholder,
  aria-label and toast goes through `useTranslations("<namespace>")`.
- **English catalogue text is the text the screen showed before** — the e2e
  suite asserts it. Translate by moving the string, not by rewording it.
- **Never show `error.message` for a code you know.** Toast through
  `useErrorToast()` / `useDescribeError()` (`apps/web/lib/i18n/hooks.ts`); branch
  on `error.code`, never on the sentence (a regex on a message breaks silently
  the day the sentence is reworded).
- **A not-found code names a kind of thing, carries no params, and is the same
  for another organisation's id as for a missing one.** Use
  `ResourceNotFoundError(code)`; never put an id, a count or anything read
  before the tenant check into a 404.
- **A refusal that depends on the resource comes after the tenant check.**
  Now that each refusal has its own code, a 403 such as
  `record_author_forbidden` or `self_approval_forbidden` thrown before the
  record is loaded through the caller's accessible set would tell a foreign id
  from a missing one. Role-only refusals (`record_create_forbidden`, a
  `super_admin` gate) do not look at the resource and may come first.
- **Params are canonical values** (a `PERIOD_VALUES` or `CATEGORIES` entry, a
  year) — never caller text, never an id. The web translates the vocabularies.
- **A 5xx says nothing about its cause** — the filter replaces it; do not try
  to word one.
- **Quantities never change with the language.** Input is read by
  `parseLocaleDecimal` / `checkActivityValue` and sent as a JSON number; a
  field's text is re-rendered with `reformatDecimalInput` on a language change;
  CSV stays dot-only and XLSX numbers stay numbers.
- **Look for invisible characters before committing.** Writing `​` or
  ` ` through an edit tool can put the character itself in the file. Build
  such characters with `String.fromCharCode`, then scan every changed file.

## Recipe A — a screen's copy

1. Pick the namespace: the screen's own (`dataEntry`, `onboarding`, …), or
   `common` / `nav` for shared words. A new namespace is a new
   `apps/web/messages/en/<ns>.json` and `tr/<ns>.json` pair, wired into
   `apps/web/messages/index.ts` (both objects).
2. Move each string into `en/<ns>.json` unchanged; write `tr/<ns>.json` with the
   same keys and the same `{arguments}`. Keys are camelCase.
3. In the component: `const t = useTranslations("<ns>")`, then `t("key")` or
   `t("key", { name })`. Keys are type-checked against the English catalogue.
4. Canonical values shown to a user (category, period) are labelled with
   `useTranslations("categories")(value)` / `("periods")(\`values.${v}\`)` —
   the value itself stays what is stored and sent.
5. Numbers: `formatNumber(value, locale, options)`; dates:
   `Intl.DateTimeFormat(LOCALE_FORMAT_TAGS[locale], …)` in the viewer's time
   zone. Never `"en-GB"` hard-coded on a localised screen.
6. A numeric input is `type="text" inputMode="decimal"` read with
   `checkActivityValue` (or `parseLocaleDecimal` and your own range rule), with
   its refusal and `readAs` hint from the `numbers` namespace.
7. Run `pnpm --filter @tonyai/web test`: `messages.spec.ts` fails on a missing
   or extra key, a mismatched argument, an empty message or an invisible
   character.

## Recipe B — an API refusal with its own wording

1. **Contract** (`packages/shared-types/src/index.ts`, a shared slot): add the
   code to `DOMAIN_ERROR_STATUS` with its status — snake_case, never renamed
   afterwards. If its sentence names values, add them to `API_ERROR_PARAMS`.
2. **API:** throw `new XxxException(errorBody('the_code', englishSentence,
   params?))` (`apps/api/src/common/api-error.ts`) — or give an existing error
   class that body in its constructor so `instanceof` readers keep working. A
   404 is `new ResourceNotFoundError('thing_not_found')` (add its sentence to
   `NOT_FOUND_MESSAGES`).
3. **Catalogues:** `errors.codes.the_code` in `en/errors.json` and
   `tr/errors.json`, naming exactly the declared params.
4. **Tests:** add the thrower to `THROWERS` in
   `apps/api/src/common/api-error.spec.ts` (it fails until every domain code
   has one, and checks status, code and params); `messages.spec.ts` checks the
   catalogue side. If the code must be told apart on a screen, test that
   branch in the screen's view module (see `lib/record-lifecycle-view.spec.ts`).
5. Build shared-types before the API typechecks against it:
   `pnpm --filter @tonyai/shared-types build`.

## Recipe C — server-side copy (emails, reports; LP4-01, LP4-03)

Follow D16 (README "Localisation and error codes"): the report's language is a
generation parameter defaulting to the requester's `profiles.language` and is
recorded in its audit row; an email uses the recipient's; an invitation the
inviter's choice, stored on it. Keep the module's copy in
`apps/api/src/<module>/i18n/{en,tr}.json`, render with `createTranslator` from
`use-intl/core`, and give the module a parity spec like `messages.spec.ts`.
CSV headers stay English machine keys and CSV numbers dot-decimal.

## Not yet localised (LP4-04 owns them)

Every screen but Data Entry's entry form and the app shell; Data Entry's
sub-panels (bulk upload, recent imports, coverage, previous submissions,
evidence, additional context, anomaly notes); activity-type and unit labels,
geography names; about 60 API refusals that still carry only a generic code.
