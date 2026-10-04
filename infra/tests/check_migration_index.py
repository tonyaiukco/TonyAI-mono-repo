#!/usr/bin/env python3
"""Exercise the actual index catalogue guard with rolled-back CI-only mutations."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/scripts'))
from check_migration_diff import INDEX_CONTRACT_SQL


def main():
    shadow = 'postgresql://postgres:ci-only@127.0.0.1:5432/tonyai_shadow'
    if os.environ.get('CI') != 'true' or os.environ.get('MIGRATION_SHADOW_URL') != shadow:
        sys.exit('Refusing anything except the dedicated CI shadow database.')
    def check(sql):
        return subprocess.run(['pnpm', 'exec', 'prisma', 'db', 'execute', '--url', shadow, '--stdin'],
                              cwd=ROOT / 'packages/db', input=sql, text=True, capture_output=True, check=False)
    if check(INDEX_CONTRACT_SQL).returncode:
        sys.exit('FAIL: real index control must pass before testing mutants.')
    name = 'activity_records_reporting_entity_period_category_key'
    drop = 'DROP INDEX public.' + name + ';'
    valid = ('CREATE UNIQUE INDEX ' + name + ' ON public.activity_records '
             '(subsidiary_id, location_id, reporting_year, reporting_period, period_value, category) '
             'NULLS NOT DISTINCT WHERE status <> \'voided\';')
    variants = [
        ('missing index', ''),
        ('wrong index name', valid.replace(name, 'activity_records_wrong_key')),
        ('nonunique index', valid.replace('UNIQUE ', '').replace('NULLS NOT DISTINCT ', '')),
        ('NULLS DISTINCT', valid.replace('NULLS NOT DISTINCT ', '')),
        ('missing key', valid.replace('location_id, ', '')),
        ('reordered keys', valid.replace('subsidiary_id, location_id', 'location_id, subsidiary_id')),
        ('extra key', valid.replace('period_value, category)', 'period_value, category, id)')),
        ('expression key', valid.replace('reporting_year,', '(reporting_year + 0),')),
        ('no predicate', valid.replace(" WHERE status <> 'voided'", '')),
        ('reversed predicate', valid.replace("status <> 'voided'", "status = 'voided'")),
        ('different predicate', valid.replace("'voided'", "'rejected'")),
        ('narrowed predicate', valid.replace("status <> 'voided'", "status <> 'voided' AND status <> 'draft'")),
        ('different sort order', valid.replace('reporting_year,', 'reporting_year DESC,')),
        ('wrong table', 'CREATE TABLE public.index_decoy (LIKE public.activity_records); ' + valid.replace('ON public.activity_records', 'ON public.index_decoy')),
        ('wrong schema', 'CREATE SCHEMA index_decoy; CREATE TABLE index_decoy.activity_records (LIKE public.activity_records); ' + valid.replace('ON public.activity_records', 'ON index_decoy.activity_records')),
    ]
    for label, create in variants:
        # Each connection owns a transaction; failure or explicit ROLLBACK leaves
        # the original replayed schema intact. No migration files are edited.
        sql = INDEX_CONTRACT_SQL.replace('BEGIN READ ONLY;', 'BEGIN;\n' + drop + '\n' + create).replace('COMMIT;', 'ROLLBACK;')
        result = check(sql)
        if result.returncode == 0 or 'Required live-record unique index contract is missing or changed' not in result.stdout + result.stderr:
            sys.exit('FAIL: mutant survived or failed for an unrelated reason: ' + label)
        if check(INDEX_CONTRACT_SQL).returncode:
            sys.exit('FAIL: rollback did not preserve the control index: ' + label)
        print('KILLED: ' + label, flush=True)
    print(f'PASS: {len(variants)} live index mutants rejected; original index retained.')


if __name__ == '__main__':
    main()
