import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from check_migration_diff import acceptable_diff, RAW_INDEX_DROP

class MigrationDiffTests(unittest.TestCase):
    def test_only_exact_known_index_representation_exception(self):
        self.assertTrue(acceptable_diff(0, '-- This is an empty migration.'))
        self.assertTrue(acceptable_diff(2, '-- DropIndex\n' + RAW_INDEX_DROP))
        for code, sql in [(1, ''), (2, ''), (0, RAW_INDEX_DROP),
                          (2, RAW_INDEX_DROP + '\nALTER TABLE storage_intents ALTER created_at SET DEFAULT now();'),
                          (2, RAW_INDEX_DROP.replace('activity_records', 'audit_log'))]:
            with self.subTest(sql=sql): self.assertFalse(acceptable_diff(code, sql))
