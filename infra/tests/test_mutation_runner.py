"""The R3 mutation runner's own behaviour, on a synthetic source tree; no R3 suite runs."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import r3_mutations as runner

FAKE = 'infra/scripts/fake.py'
SCRIPT = "BARRIER = ''\nDELAY = 0.0\nKILL = 1\nKEEP = 1\nLEFT = 1\nRIGHT = 1\nDRIFT = False\n"
# The only R3 test in the synthetic tree. Each run logs the values it saw once it finishes;
# mutants sharing a BARRIER group wait until both run at once, each in its own copy.
TEST = '''import os, sys, time, unittest
from pathlib import Path
sys.path.insert(0, 'infra/scripts')
import fake

class Fake(unittest.TestCase):
    def test_fake(self):
        log = Path(os.environ['FAKE_LOG'])
        if fake.BARRIER:
            (log.parent / f'{fake.BARRIER}.{os.getpid()}').touch()
            deadline = time.monotonic() + 20
            while len(list(log.parent.glob(fake.BARRIER + '.*'))) < 2:
                self.assertLess(time.monotonic(), deadline, 'the mutants never ran at the same time')
                time.sleep(0.02)
        time.sleep(fake.DELAY)
        with log.open('a') as stream: stream.write(f'{fake.KILL}{fake.KEEP}{fake.LEFT}{fake.RIGHT}\\n')
        self.assertEqual(fake.KILL, 1)
        # Two mutants applied to one tree would show both values.
        self.assertNotEqual((fake.LEFT, fake.RIGHT), (2, 2))
        if fake.DRIFT and Path.cwd().name == os.environ['FAKE_DRIFT_COPY']:
            Path('infra/tests/drift.txt').write_text('outside the restored mutation')
'''


class MutationRunner(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory(prefix='r3-runner-test-')
        self.addCleanup(work.cleanup)
        self.source, self.output, self.log = Path(work.name) / 'src', Path(work.name) / 'report.json', Path(work.name) / 'runs.log'
        for name in runner.SOURCE_DIRS: (self.source / name).mkdir(parents=True)
        (self.source / FAKE).write_text(SCRIPT)
        (self.source / 'infra/tests/test_r3_fake.py').write_text(TEST)
        (self.source / 'infra/tests/selfhost_init_entry.test.mjs').write_text("import test from 'node:test';\ntest('fake', () => {});\n")
        (self.source / '.github/workflows/fake.yml').write_text('name: fake\n')
        environment = patch.dict(os.environ, {'FAKE_LOG': str(self.log)})
        environment.start(); self.addCleanup(environment.stop)

    def run_mutations(self, mutations, workers=3):
        with patch('sys.stdout'):
            return runner.main(self.output, workers, self.source, [(FAKE, *mutation) for mutation in mutations])

    def runs(self):
        return self.log.read_text().split() if self.log.exists() else []

    def test_results_keep_registry_order_and_name_survivors(self):
        mutations = [('slow-killed', 'DELAY = 0.0\nKILL = 1', 'DELAY = 1.5\nKILL = 2'), ('fast-killed', 'KILL = 1', 'KILL = 3'),
                     ('survivor', 'KEEP = 1', 'KEEP = 2'), ('left', 'LEFT = 1', "LEFT = 2\nBARRIER = 'lr'"), ('right', 'RIGHT = 1', "RIGHT = 2\nBARRIER = 'lr'")]
        self.assertTrue(self.run_mutations(mutations))
        report = json.loads(self.output.read_text())
        self.assertEqual([r['name'] for r in report['mutations']], [m[0] for m in mutations])
        self.assertEqual([r['result'] for r in report['mutations']], ['KILLED', 'KILLED', 'SURVIVED', 'SURVIVED', 'SURVIVED'])
        self.assertEqual((report['killed'], report['survived'], report['invalid']), (2, ['survivor', 'left', 'right'], 0))
        self.assertEqual((report['baseline'], report['node_baseline'], report['source_unchanged']), ('PASS', 'PASS', True))
        self.assertEqual(report['source_sha256'], runner.source_hashes(self.source))
        self.assertEqual(set(report), {'baseline', 'node_baseline', 'mutations', 'killed', 'survived', 'invalid', 'source_sha256', 'source_unchanged'})
        self.assertEqual(report['mutations'][2]['diagnostic'], '')
        self.assertIn('AssertionError', report['mutations'][0]['diagnostic'])
        # The slow mutant finished after the fast one; the report still follows the registry.
        runs = self.runs()
        self.assertEqual(sorted(runs), sorted(['1111', '2111', '3111', '1211', '1121', '1112']))
        self.assertLess(runs.index('3111'), runs.index('2111'))

    def test_all_killed_returns_false(self):
        self.assertFalse(self.run_mutations([('killed', 'KILL = 1', 'KILL = 2')], workers=1))
        self.assertEqual(json.loads(self.output.read_text())['survived'], [])

    def test_a_copy_whose_source_drifts_fails_the_run(self):
        # Two drifting mutants meet, so they hold both copies at once and the chosen copy always drifts:
        # copy 0 supplies the reported hashes, and a drift in any other copy must fail the run too.
        drift = 'DRIFT = False', "DRIFT = True\nBARRIER = 'drift'"
        mutations = [('fast-killed', 'KILL = 1', 'KILL = 3'), ('drift-a', *drift), ('drift-b', *drift), ('survivor', 'KEEP = 1', 'KEEP = 2')]
        for copy in '01':
            with self.subTest(copy=copy), patch.dict(os.environ, {'FAKE_DRIFT_COPY': copy}):
                for marker in self.log.parent.glob('drift.*'): marker.unlink()
                with self.assertRaisesRegex(ValueError, 'changed outside the restored mutations'):
                    self.run_mutations(mutations, workers=2)
                self.assertFalse(self.output.exists())

    def test_a_copy_that_differs_when_made_fails_before_any_test_runs(self):
        copy = runner.shutil.copytree
        def drifting(source, target, **kwargs):
            copy(source, target, **kwargs)
            if Path(target).parents[1].name == '1': (Path(target) / 'extra.txt').write_text('not in copy 0')
        with patch.object(runner.shutil, 'copytree', drifting), self.assertRaisesRegex(ValueError, 'differ before any test ran'):
            self.run_mutations([('survivor', 'KEEP = 1', 'KEEP = 2')], workers=2)
        self.assertEqual((self.runs(), self.output.exists()), ([], False))

    def test_unmatched_anchor_fails_before_any_test_runs(self):
        # 'T = 1' matches LEFT and RIGHT; only a source-sha- mutant expects two sites.
        for name, before in (('missing', 'ABSENT = 1'), ('twice', 'T = 1'), ('source-sha-once', 'KILL = 1')):
            with self.subTest(name):
                with self.assertRaisesRegex(ValueError, 'Unmatched mutation: ' + name):
                    self.run_mutations([('survivor', 'KEEP = 1', 'KEEP = 2'), (name, before, 'X = 2')])
                self.assertEqual((self.runs(), self.output.exists()), ([], False))

    def test_a_source_sha_mutant_changes_both_sites(self):
        self.run_mutations([('source-sha-both', 'T = 1', 'T = 2')])
        self.assertEqual(json.loads(self.output.read_text())['mutations'][0]['result'], 'KILLED')
        self.assertIn('1122', self.runs())

    def test_a_syntax_error_is_never_a_kill(self):
        with self.assertRaises(SyntaxError):
            self.run_mutations([('survivor', 'KEEP = 1', 'KEEP = 2'), ('syntax', 'KILL = 1', 'KILL = (')])
        self.assertEqual((self.runs(), self.output.exists()), ([], False))

    def test_a_mutant_over_its_timeout_fails_the_run(self):
        with patch.object(runner, 'MUTANT_TIMEOUT', 1), self.assertRaises(runner.subprocess.TimeoutExpired):
            self.run_mutations([('slow', 'DELAY = 0.0', 'DELAY = 5.0')])
        self.assertFalse(self.output.exists())

    def test_failing_baseline_fails_the_run(self):
        node = self.source / 'infra/tests/selfhost_init_entry.test.mjs'
        for broken, source in ((self.source / FAKE, SCRIPT.replace('KILL = 1', 'KILL = 0')),
                               (node, "import test from 'node:test';\ntest('fake', () => { throw new Error('node baseline'); });\n")):
            with self.subTest(broken.name):
                original = broken.read_text(); broken.write_text(source)
                self.addCleanup(broken.write_text, original)
                with self.assertRaises(SystemExit):
                    self.run_mutations([('survivor', 'KEEP = 1', 'KEEP = 2')])
                self.assertFalse(self.output.exists())
                broken.write_text(original)

    def test_at_least_one_worker(self):
        with self.assertRaisesRegex(ValueError, 'At least one mutation worker'):
            self.run_mutations([('survivor', 'KEEP = 1', 'KEEP = 2')], workers=0)


if __name__ == '__main__':
    unittest.main()
