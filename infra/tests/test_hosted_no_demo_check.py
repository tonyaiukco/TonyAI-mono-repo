"""The hosted no-demo check names exactly what the seed creates (LP2-04, #259 follow-up)."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SQL = (ROOT / 'infra/scripts/hosted_no_demo_check.sql').read_text()


class HostedNoDemoCheckTests(unittest.TestCase):
    def test_seed_accounts_and_demo_organisation_match_the_seed(self):
        seed = (ROOT / 'packages/db/prisma/seed.ts').read_text()
        emails = re.findall(r"ensureAuthUser\('([^']+)'", seed)
        self.assertGreaterEqual(len(emails), 5)
        self.assertEqual({email.split('@', 1)[1] for email in emails}, {'tonyai.local'})
        self.assertIn("like '%@tonyai.local'", SQL)
        organisation = re.search(r"const ORG_ID = '([0-9a-f-]{36})'", seed).group(1)
        self.assertIn("id = '" + organisation + "'", SQL)

    def test_demo_factor_source_and_internal_publishers_match_the_library(self):
        library = (ROOT / 'packages/db/prisma/factor-library.ts').read_text()
        source = re.search(r"const DEMO_SOURCE = '([^']+)'", library).group(1)
        self.assertIn("starts_with(source, '" + source + "')", SQL)
        types = (ROOT / 'packages/shared-types/src/index.ts').read_text()
        block = re.search(r'INTERNAL_FACTOR_PUBLISHERS = Object\.freeze\(\{(.*?)\}', types, re.S).group(1)
        publishers = re.findall(r":\s*'([^']+)'", block)
        self.assertEqual(len(publishers), 2)
        for publisher in publishers:
            self.assertIn("'" + publisher + "'", SQL)

    def test_the_check_only_reads(self):
        statements = re.sub(r'--[^\n]*', '', SQL).lower()
        # One statement only: the SQL editor shows the last statement's rows, and a SELECT writes nothing.
        self.assertTrue(statements.strip().startswith('with checks(') and statements.strip().endswith(';'))
        self.assertEqual(statements.count(';'), 1)
        for verb in ('insert', 'update', 'delete', 'truncate', 'drop', 'alter', 'grant', 'create', 'commit'):
            self.assertIsNone(re.search(r'\b' + verb + r'\b', statements), verb)


if __name__ == '__main__':
    unittest.main()
