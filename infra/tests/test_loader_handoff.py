"""Run the offline Node contract and mutation tests in Infrastructure CI."""
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]


class LoaderHandoffTests(unittest.TestCase):
    def test_loader_identity_and_private_command(self):
        result = subprocess.run(['node', '--test', 'infra/tests/loader-identity.test.mjs'], cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_loader_guard_mutants(self):
        result = subprocess.run([sys.executable, 'infra/tests/check_loader_mutations.py'], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
