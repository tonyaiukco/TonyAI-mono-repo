import contextlib
import io
import os
import re
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from check_migration_diff import acceptable_diff, RAW_INDEX_DROP, INDEX_CONTRACT_SQL, main
from check_migration_index import main as check_mutations


class MigrationDiffTests(unittest.TestCase):
    def test_diff_always_requires_independent_index_verification(self):
        for code, sql in [(0, ''), (0, '-- This is an empty migration.'), (2, RAW_INDEX_DROP)]:
            with self.subTest(code=code):
                self.assertFalse(acceptable_diff(code, sql))
                self.assertFalse(acceptable_diff(code, sql, index_verified=False))
                self.assertTrue(acceptable_diff(code, sql, index_verified=True))

    def test_only_empty_or_exact_known_representation_with_verified_index(self):
        self.assertTrue(acceptable_diff(2, '-- DropIndex\n' + RAW_INDEX_DROP, index_verified=True))
        for code, sql in [(1, ''), (2, ''), (0, RAW_INDEX_DROP),
                          (2, RAW_INDEX_DROP + '\nALTER TABLE storage_intents ALTER created_at SET DEFAULT now();'),
                          (2, RAW_INDEX_DROP.replace('activity_records_reporting_entity_period_category_key', 'activity_records_different_key')),
                          (2, RAW_INDEX_DROP.replace('activity_records', 'audit_log'))]:
            with self.subTest(sql=sql): self.assertFalse(acceptable_diff(code, sql, index_verified=True))

    def test_catalogue_failure_blocks_empty_and_drop_even_after_successful_replay(self):
        shadow = 'postgresql://postgres:ci-only@127.0.0.1:5432/tonyai_shadow'
        for code, sql in [(0, ''), (2, RAW_INDEX_DROP)]:
            for contract_code in (0, 1):
                replies = [SimpleNamespace(returncode=code, stdout=sql, stderr=''),
                           SimpleNamespace(returncode=contract_code, stdout='', stderr='')]
                with self.subTest(code=code, contract=contract_code), patch.dict(os.environ, CI='true', MIGRATION_SHADOW_URL=shadow), patch('check_migration_diff.subprocess.run', side_effect=replies) as run, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    if contract_code:
                        with self.assertRaises(SystemExit): main()
                    else: main()
                    replay, contract = run.call_args_list
                    self.assertEqual(replay.args[0][replay.args[0].index('--shadow-database-url')+1], shadow)
                    self.assertEqual(contract.args[0], ['pnpm', 'exec', 'prisma', 'db', 'execute', '--url', shadow, '--stdin'])
                    self.assertEqual(contract.kwargs['input'], INDEX_CONTRACT_SQL)

    def test_index_contract_requires_only_the_seven_column_key(self):
        # LP3-03 (K2): the transitional six-column branch is gone; the catalogue
        # guard names exactly one key, ending in activity_type.
        self.assertIn('i.indnkeyatts = 7 AND i.indnatts = 7', INDEX_CONTRACT_SQL)
        self.assertIsNone(re.search(r'indn(key)?atts\s*=\s*6\b', INDEX_CONTRACT_SQL))
        self.assertIsNone(re.search(r'\bOR\b', INDEX_CONTRACT_SQL))
        self.assertEqual(INDEX_CONTRACT_SQL.count('pg_get_indexdef'), 1)
        self.assertEqual(INDEX_CONTRACT_SQL.count("'category', 'activity_type']"), 1)
        self.assertIn('period_value, category, activity_type) NULLS NOT DISTINCT WHERE', INDEX_CONTRACT_SQL)
        self.assertNotIn('period_value, category) NULLS', INDEX_CONTRACT_SQL)

    def test_both_commands_refuse_non_ci_or_other_database_before_connecting(self):
        shadow = 'postgresql://postgres:ci-only@127.0.0.1:5432/tonyai_shadow'
        for entrypoint in (main, check_mutations):
            for ci, url in [('false', shadow), ('true', shadow.replace('tonyai_shadow', 'postgres')), ('true', shadow.replace('127.0.0.1', 'remote.invalid'))]:
                with self.subTest(command=entrypoint, ci=ci, url=url), patch.dict(os.environ, CI=ci, MIGRATION_SHADOW_URL=url), patch('subprocess.run') as run:
                    with self.assertRaises(SystemExit): entrypoint()
                    run.assert_not_called()
