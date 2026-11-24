# Design

## Context

See `proposal.md` for the motivation. What shapes the approach:

- **Icon.** `app/layout.tsx` links `/icon-light-32x32.png`, `/icon-dark-32x32.png`, `/icon.svg` and `/apple-icon.png`. No `favicon.ico` exists in `app/` or `public/`. `proxy.ts` already leaves `favicon.ico` out of its matcher, so the request reaches Next and finds nothing.
- **Gas basis.** `gasInputs.cvBasis` is `CvBasis | null` in the page's state. It is set to null in three places: the unit-narrowing effect, the "net figure left the TR rules" effect, and `basisAfterUnitChange`. `CalorificBasisChoice` shows null as "neither selected", and null blocks the preview and the save (`basis_missing`). The API refuses a kWh or MWh gas record without a basis (400 `parameters_required`); bulk upload requires the column.
- **Context fields.** `lib/context-fields.ts` holds one field set per category group; the values are saved in the record's `input` JSON, which the write DTOs accept as any object (`@IsObject()`), and which the calculation never reads. Electricity already has a free-text `utility_provider`. The review sheet shows nothing from `input` today. Field ids are stored and are never renamed.
- **Records table.** `RecordsTable` is mounted full width under the form grid and Bulk upload (`app/data-entry/page.tsx`), which on a real screen is several viewports below the header.

## Goals / Non-Goals

**Goals:**
- Each of the four fixes is the smallest change that meets its acceptance line in the v4 report.
- The form never selects net by itself, on any path, and that is true by construction, not by auditing every setter.
- No migration, no new route, no change to a calculated figure of an existing record.

**Non-Goals:**
- A default basis in the API or in bulk upload: a file or a client that states no basis is still refused (no silent assumption, INC-2.5 §1.3).
- Invoice number and supplier as real columns, as search filters, or in reports and exports.
- Fixing the light and dark icon PNGs being the same file (filed, not a defect).
- Moving the records table. BUG-R2-05 put it under the form on purpose; this change adds a way to reach it.

## Decisions

### 1. `app/favicon.ico`, built from the existing 32 px mark

Next serves `app/favicon.ico` at `/favicon.ico` by file convention and adds its link tag itself. The file is an ICO container around the existing `icon-light-32x32.png` bytes (ICO has allowed embedded PNG since Windows Vista; every current browser reads it), written by a short script kept out of the repository. The explicit `icons` block in `layout.tsx` stays as it is.

*Alternative:* a route handler that redirects `/favicon.ico` to the SVG. Rejected: a redirect is one more request on every cold tab and some bookmark tools do not follow it.

### 2. One derived default for the basis, not a new value in each setter

The held state stays `CvBasis | null`, meaning "the basis the record stores or the author picked". A new pure function in `lib/record-inputs-view.ts` gives the basis the form acts on:

```
effectiveGasBasis(held) = held ?? 'gross'      // only where the choice is shown
```

The choice, the preview request and the save all read the effective basis. The three places that clear the held basis keep doing so; each of them now lands on gross without being edited. A stored basis is held, so it wins. Net can only ever come from the record or from the author's click.

`basis_missing` stays in the code as the refusal the API can still return; the form can no longer reach it by itself.

Two consequences, kept on purpose (review, 2026-11-24):

- **A form carried to a new record keeps its basis.** Opening a record without Edit and changing its period, year or site turns the form into a new record with every field as it was (`nowEnteringNew`); a held net stays with the figure it describes, as on a copy. Clearing it would price that figure as gross without a word, and a company whose supplier bills net would have to choose net again every month.
- **A unit detour off a stored-net record is path-dependent.** kWh → MWh keeps the held basis; a detour through a volume unit clears it, and coming back restores the record's own basis only on the record's own unit. On the other energy unit the form holds none and shows gross. It errs toward the bill's usual figure and is visible before save.

*Alternative:* set `'gross'` where each setter sets null. Rejected: three sites today, and the next one added would silently reintroduce "neither selected" or, worse, be written as net.

*Alternative:* default in the API. Rejected: it would also default bulk rows and API clients, which the spec forbids.

### 3. Gross first, in plain words, with the unit in the label

The radio order becomes gross, net in the component (the shared `CV_BASES` order is not changed: the bulk dry run and the review sheet use it). Labels take the record's unit: "{unit} on the bill (upper calorific value)" / "Net {unit} (lower calorific value)"; TR "Faturadaki {unit} (üst ısıl değer)" / "Net {unit} (alt ısıl değer)". The help line says why gross is selected and when to change it. The derived-net line ("Priced on ≈ … net: × 0.9011 …") is unchanged and is now visible from the first keystroke, which is the "correction shown to the user" the report asks for. The review sheet and the bulk dry run keep their short "gross" / "net" words.

### 4. Two `input` keys, validated, with one supplier lookup

- Keys: `invoice_no` and `supplier`, in the style of the existing ids. Added to every field set in `context-fields.ts` except that Electricity gets only `invoice_no`: its `utility_provider` already is the supplier, and a stored id cannot be renamed.
- `@tonyai/shared-types` gets the two key names, their limits (64 and 200 characters) and `recordSupplier(category, input)`, which returns `supplier`, or `utility_provider` for Electricity. The web form (`maxLength`), the review sheet and the API all use them.
- The write DTOs add one validator on `input`: when either key is present it must be a string within its limit after trimming; an empty string is stored as absent. Other keys in `input` are not touched, so every existing record still saves.
- Electricity's `utility_provider` is a supplier only on an Electricity record, and the key is older than the rule. Its bound is therefore not the DTO's but the record service's, asked of the effective category with the stored `input` beside it (`electricitySupplierIssues(category, input, stored)`): a value the record already holds is left alone, so an old record's other fields can still be edited; a new or changed one is refused (review of `3ebe20d5`).
- A text, date or note field's label is tied to its input (`htmlFor` and `id`).
- The review sheet adds two rows, each shown only when its value is present.

*Alternative:* nullable columns `invoice_no` and `supplier` on `activity_records`. Rejected for this change: a migration, RLS and runtime-grant review, and a contract review for two optional labels. If WP9's fuel batches need to query by invoice number, that package adds the column and backfills from `input`; the key names here are chosen so that backfill is a straight copy.

### 5. The top control is a button in the page header

A button under the page title, shown when a subsidiary is selected, reading "View or edit your entries (12)". Its count is the subsidiary's whole record count: the table's own total when no filter narrows it, otherwise one more count request, sent apart from the table's requests and kept with the subsidiary it was read for, so a slow count never holds the rows back (review of `3ebe20d5`). On click it scrolls the table's section into view (`scrollIntoView`, smooth unless `prefers-reduced-motion`) and focuses the table's heading (`tabIndex={-1}`), so keyboard and screen-reader users land there too. It is a button, not a hash link: the page keeps form state in memory and a hash change must not be mistaken for navigation.

## Risks / Trade-offs

- **A user leaves gross selected on a figure that is net** → the result is understated by about 10%, where before the form refused to guess. This is the team's stated trade (a net figure on a Turkish gas bill is rare; a gross figure marked net is the common mistake, and overstates by about 11%). Mitigation: the net quantity the figure is priced on is shown beside the choice before save, the basis is on the review sheet, and the audit row holds it.
- **The default hides a missing stored basis** → not reachable: the API has never stored a kWh or MWh gas record without one.
- **`input` validation refuses a client that sends a non-string under these names** → only the web writes `input`, and it has never used these two names.
- **The e2e spec for the gas bill asserts "neither selected"** → rewritten in this change; the unit spec for `basisAfterUnitChange` stays valid because the held state is unchanged.

## Migration Plan

No data migration. Deploy is the usual merge to `main` and QA auto-deploy. Rollback is a revert of the PR; records saved meanwhile keep a valid `cvBasis` and two harmless `input` keys.
