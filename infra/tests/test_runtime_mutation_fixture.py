"""Exercise repository-relative tests in the actual disposable mutation fixture."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_selfhost_runtime_mutations import copy_fixture, run


class RuntimeMutationFixtureTests(unittest.TestCase):
    def test_copied_network_cli_and_terraform_contract_pass_before_mutation(self):
        with tempfile.TemporaryDirectory(prefix='tonyai-fixture-regression-') as directory:
            target = copy_fixture(Path(directory))
            result = subprocess.run(
                [sys.executable, '-B', '-m', 'unittest', 'discover',
                 '-s', str(target / 'tests'), '-p', 'test_selfhost_app_network.py'],
                cwd=directory, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_control_run_and_its_cli_children_leave_no_bytecode(self):
        with tempfile.TemporaryDirectory(prefix='tonyai-fixture-bytecode-') as directory:
            target = copy_fixture(Path(directory))
            result = run(target)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(list(target.rglob('*.pyc')), [])


if __name__ == '__main__':
    unittest.main()
