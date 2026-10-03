#!/usr/bin/env python3
"""CI-only migration replay/schema comparison with one documented Prisma exception."""
import os
from pathlib import Path
import re
import subprocess
import sys

# Prisma cannot represent the raw NULLS NOT DISTINCT unique index. This exact
# DROP is diagnostic output only and is NEVER executed or copied to a migration.
RAW_INDEX_DROP = 'DROP INDEX "activity_records_reporting_entity_period_category_key";'


def acceptable_diff(code, sql):
    statements = re.sub(r'--[^\n]*', '', sql).strip()
    return (code == 0 and not statements) or (code == 2 and statements == RAW_INDEX_DROP)


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
    if not acceptable_diff(result.returncode, result.stdout):
        print(result.stdout)
        print(result.stderr, file=sys.stderr)
        sys.exit('Migration/schema drift or replay failure; review before upgrading Prisma.')
    print('PASS: migration chain matches schema (only the documented raw-index representation exception allowed).')


if __name__ == '__main__':
    main()
