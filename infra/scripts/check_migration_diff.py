#!/usr/bin/env python3
"""CI-only replay/schema diff plus a catalogue guard for Prisma's invisible index."""
import os
from pathlib import Path
import re
import subprocess
import sys

# Partial indexes are invisible to the pinned Prisma engine. An empty diff is
# safe only AFTER verifying this raw index in the replayed shadow database.
# An engine that emits this exact representation DROP is also allowed; the DROP
# is diagnostic output only and is NEVER executed or copied to a migration.
RAW_INDEX_DROP = 'DROP INDEX "activity_records_reporting_entity_period_category_key";'
INDEX_CONTRACT_SQL = '''BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
DO $contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid = tbl.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid = idx.relam
    WHERE ns.nspname = 'public' AND tbl.relname = 'activity_records'
      AND idx.relnamespace = tbl.relnamespace AND idx.relkind = 'i'
      AND idx.relname = 'activity_records_reporting_entity_period_category_key'
      AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indimmediate AND i.indnullsnotdistinct AND am.amname = 'btree'
      AND i.indexprs IS NULL
      AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) = '(status <> ''voided''::"ActivityRecordStatus")'
      AND (
        -- Transitional six-column branch: remove after LP3-03 PR B merges.
        (i.indnkeyatts = 6 AND i.indnatts = 6
         AND ARRAY(SELECT a.attname::text
                   FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_catalog.pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = k.attnum
                   ORDER BY k.ord) = ARRAY['subsidiary_id', 'location_id', 'reporting_year',
                                          'reporting_period', 'period_value', 'category']
         AND pg_catalog.pg_get_indexdef(i.indexrelid) = 'CREATE UNIQUE INDEX activity_records_reporting_entity_period_category_key ON public.activity_records USING btree (subsidiary_id, location_id, reporting_year, reporting_period, period_value, category) NULLS NOT DISTINCT WHERE (status <> ''voided''::"ActivityRecordStatus")')
        OR
        (i.indnkeyatts = 7 AND i.indnatts = 7
         AND ARRAY(SELECT a.attname::text
                   FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_catalog.pg_attribute a ON a.attrelid = tbl.oid AND a.attnum = k.attnum
                   ORDER BY k.ord) = ARRAY['subsidiary_id', 'location_id', 'reporting_year',
                                          'reporting_period', 'period_value', 'category', 'activity_type']
         AND pg_catalog.pg_get_indexdef(i.indexrelid) = 'CREATE UNIQUE INDEX activity_records_reporting_entity_period_category_key ON public.activity_records USING btree (subsidiary_id, location_id, reporting_year, reporting_period, period_value, category, activity_type) NULLS NOT DISTINCT WHERE (status <> ''voided''::"ActivityRecordStatus")')
      )
  ) THEN
    RAISE EXCEPTION 'Required live-record unique index contract is missing or changed';
  END IF;
END;
$contract$;
COMMIT;'''


def acceptable_diff(code, sql, *, index_verified=False):
    statements = re.sub(r'--[^\n]*', '', sql).strip()
    return index_verified and ((code == 0 and not statements) or (code == 2 and statements == RAW_INDEX_DROP))


def main():
    shadow = 'postgresql://postgres:ci-only@127.0.0.1:5432/tonyai_shadow'
    if os.environ.get('CI') != 'true' or os.environ.get('MIGRATION_SHADOW_URL') != shadow:
        sys.exit('Refusing anything except the dedicated CI shadow database.')
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run([
        'pnpm', 'exec', 'prisma', 'migrate', 'diff',
        '--from-migrations', 'prisma/migrations',
        '--to-schema-datamodel', 'prisma/schema.prisma',
        '--shadow-database-url', shadow, '--script', '--exit-code',
    ], cwd=root / 'packages/db', capture_output=True, text=True, check=False)
    # Inspect the same explicit shadow DB after replay. Never inspect a runtime
    # database or infer this invariant from Prisma's unsupported-index diff.
    contract = subprocess.run([
        'pnpm', 'exec', 'prisma', 'db', 'execute', '--url', shadow, '--stdin',
    ], input=INDEX_CONTRACT_SQL, cwd=root / 'packages/db', capture_output=True, text=True, check=False)
    if not acceptable_diff(result.returncode, result.stdout, index_verified=contract.returncode == 0):
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        print(contract.stderr, file=sys.stderr)
        sys.exit('Migration/schema drift, raw-index contract failure or replay failure.')
    print('PASS: raw-index catalogue contract verified; Prisma-visible schema matches (exact representation DROP allowed, never executed).')


if __name__ == '__main__':
    main()
