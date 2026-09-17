-- Canonicalise the stored spelling of activity_records.activity_unit.
--
-- Until this migration the column held whatever the caller wrote, whitespace-
-- normalised only: `kw h`, `KWH` and `MWH` were each priced correctly (the
-- calculation snapshot records `normalizedUnit`) but stored as three different
-- units, which split a GROUP BY and left `unitSymbol` on the raw text. From
-- now on the API stores the vocabulary's value (`kWh`, `MWh`, `cubic_metres`,
-- …) and this brings the rows already stored onto the same rule.
--
-- Hand-written: no schema change. The alias table mirrors
-- `apps/api/src/calculations/normalization.ts` (`UNIT_ALIAS_SPELLINGS`) and
-- `ACTIVITY_UNITS` in `@tonyai/shared-types` as of 2026-09-17; it is a frozen
-- snapshot, as every migration is.
--
-- The key is built the way the engine builds its lookup key: trim, collapse
-- whitespace to `_`, lowercase. Postgres's `\s` does not include NBSP, U+2028,
-- U+2029 or U+FEFF, which JavaScript's does, so those are mapped to spaces
-- first — a row stored before #121 could carry them.
--
-- `calculation` (the immutable snapshot, incl. `inputUnit`) is untouched, and
-- `updated_at` is left alone: this is a spelling, not an edit, and no user can
-- be named for an audit row.
WITH aliases(alias_key, stored) AS (
  VALUES
    ('cubic_meters', 'cubic_metres'),
    ('cubic_metre', 'cubic_metres'),
    ('cubic_metres', 'cubic_metres'),
    ('m3', 'cubic_metres'),
    ('m³', 'cubic_metres'),
    ('gj', 'gj'),
    ('kilometre', 'kilometres'),
    ('kilometres', 'kilometres'),
    ('km', 'kilometres'),
    ('kw_h', 'kWh'),
    ('kwh', 'kWh'),
    ('mwh', 'MWh'),
    ('l', 'litres'),
    ('liter', 'litres'),
    ('liters', 'litres'),
    ('litre', 'litres'),
    ('litres', 'litres'),
    ('nm3', 'normal_cubic_metres'),
    ('nm³', 'normal_cubic_metres'),
    ('normal_cubic_metre', 'normal_cubic_metres'),
    ('normal_cubic_metres', 'normal_cubic_metres'),
    ('passenger_kilometre', 'passenger_kilometres'),
    ('passenger_kilometres', 'passenger_kilometres'),
    ('pkm', 'passenger_kilometres'),
    ('scm', 'standard_cubic_metres'),
    ('sm3', 'standard_cubic_metres'),
    ('sm³', 'standard_cubic_metres'),
    ('standard_cubic_metre', 'standard_cubic_metres'),
    ('standard_cubic_metres', 'standard_cubic_metres'),
    ('t', 'tonnes'),
    ('therm', 'therms'),
    ('therms', 'therms'),
    ('tonne', 'tonnes'),
    ('tonnes', 'tonnes'),
    ('uk_gallon', 'uk_gallons'),
    ('uk_gallons', 'uk_gallons'),
    ('us_gallon', 'us_gallons'),
    ('us_gallons', 'us_gallons')
)
UPDATE activity_records AS ar
SET activity_unit = a.stored
FROM aliases AS a
WHERE lower(
        regexp_replace(
          regexp_replace(
            translate(ar.activity_unit, E'   ﻿', '    '),
            '^\s+|\s+$', '', 'g'),
          '\s+', '_', 'g')
      ) = a.alias_key
  AND ar.activity_unit <> a.stored;
