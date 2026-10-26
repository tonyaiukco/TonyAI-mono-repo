"""The R3 mutation runner's own behaviour, on a synthetic source tree; no R3 suite runs."""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import r3_mutations as runner

FAKE = 'infra/scripts/fake.py'
SCRIPT = "BARRIER = ''\nDELAY = 0.0\nKILL = 1\nKEEP = 1\nLEFT = 1\nRIGHT = 1\nDRIFT = False\nLEAK = 0\n"
# The only R3 test in the synthetic tree. Each run logs the values it saw once it finishes;
# mutants sharing a BARRIER group wait until both run at once, each in its own copy.
TEST = '''import os, sys, time, unittest
from pathlib import Path
sys.path.insert(0, 'infra/scripts')
import fake

class Fake(unittest.TestCase):
    def test_fake(self):
        log = Path(os.environ['FAKE_LOG'])
        # Each run starts from an empty private fixture root; a leaking mutant leaves a locked tree there.
        fixtures = Path(os.environ['R3_PK_FIXTURE_ROOT'])
        self.assertEqual(sorted(fixtures.iterdir()), [], 'the previous run was not swept')
        if fake.LEAK == 7:  # the per-run base swapped for a link to a look-alike tree: refuse too
            outside = Path(os.environ['FAKE_OUTSIDE'])
            with open(os.environ['FAKE_LEAKS'], 'a') as stream: stream.write(f'{fixtures} {Path.cwd()}\\n')
            base = fixtures.parent
            base.rename(str(base) + '.moved')
            (outside / fixtures.name).mkdir(parents=True)
            (outside / fixtures.name / 'file').write_text('kept')
            base.symlink_to(outside)
            return
        if fake.LEAK == 6:  # the fixture root itself swapped for a link: the runner must refuse to sweep
            with open(os.environ['FAKE_LEAKS'], 'a') as stream: stream.write(f'{fixtures} {Path.cwd()}\\n')
            fixtures.rmdir()
            fixtures.symlink_to(os.environ['FAKE_OUTSIDE'])
            return
        if fake.LEAK == 5:  # links out of the fixture root, top-level and nested: removed, never followed
            (fixtures / 'r3p-link').symlink_to(os.environ['FAKE_OUTSIDE'])
            (fixtures / 'r3p-leak5').mkdir()
            (fixtures / 'r3p-leak5' / 'nested').symlink_to(os.environ['FAKE_OUTSIDE'] + '/keep')
        if fake.LEAK:
            top = fixtures / ('r3p-leak%d' % fake.LEAK)
            locked = top / 'locked'
            locked.mkdir(parents=True)
            (locked / 'file').write_text('x')
            locked.chmod(0)
            top.chmod(0)
            with open(os.environ['FAKE_LEAKS'], 'a') as stream: stream.write(f'{fixtures} {Path.cwd()}\\n')
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
        self.leaks = Path(work.name) / 'leaks.log'
        environment = patch.dict(os.environ, {'FAKE_LOG': str(self.log), 'FAKE_LEAKS': str(self.leaks)})
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

    def leaked(self):
        return [line.split() for line in self.leaks.read_text().splitlines()] if self.leaks.exists() else []

    def test_every_run_gets_a_private_fixture_root_swept_after_it(self):
        # One worker: the second leaking mutant passes only if the first one's tree was swept.
        mutations = [('leak-a', 'LEAK = 0', 'LEAK = 1'), ('leak-b', 'LEAK = 0', 'LEAK = 2')]
        self.assertTrue(self.run_mutations(mutations, workers=1))
        self.assertEqual([r['result'] for r in json.loads(self.output.read_text())['mutations']], ['SURVIVED', 'SURVIVED'])
        leaked = self.leaked()
        self.assertEqual(len(leaked), 2)
        for fixtures, _copy in leaked:
            self.assertRegex(fixtures, r'^/tmp/r3mw-[^/]+/[0-9]+$')  # short: AF_UNIX paths stay under 104 bytes
            self.assertFalse(Path(fixtures).parent.exists())  # this run's own base, not other runners'

    def test_a_leaked_link_is_removed_without_touching_its_target(self):
        outside = Path(self.log.parent) / 'outside'
        (outside / 'keep').mkdir(parents=True)
        (outside / 'keep' / 'file').write_text('kept')
        (outside / 'keep').chmod(0o755)
        with patch.dict(os.environ, {'FAKE_OUTSIDE': str(outside)}):
            self.run_mutations([('leak-link', 'LEAK = 0', 'LEAK = 5')], workers=1)
        self.assertEqual(json.loads(self.output.read_text())['mutations'][0]['result'], 'SURVIVED')
        self.assertEqual((outside / 'keep' / 'file').read_text(), 'kept')
        self.assertEqual((outside / 'keep').stat().st_mode & 0o777, 0o755)  # the nested link was not chmod-ed through
        self.assertFalse(Path(self.leaked()[0][0]).exists())

    def test_a_fixture_root_swapped_for_a_link_is_never_swept(self):
        outside = Path(self.log.parent) / 'outside'
        outside.mkdir()
        (outside / 'file').write_text('kept')
        with patch.dict(os.environ, {'FAKE_OUTSIDE': str(outside)}), self.assertRaisesRegex(RuntimeError, 'fixture root replaced'):
            self.run_mutations([('swap', 'LEAK = 0', 'LEAK = 6')], workers=1)
        self.assertEqual((outside / 'file').read_text(), 'kept')
        self.assertFalse(Path(self.leaked()[0][0]).parent.exists())
        self.assertFalse(self.output.exists())

    def test_a_base_swapped_for_a_link_is_never_swept(self):
        outside = Path(self.log.parent) / 'outside'
        with patch.dict(os.environ, {'FAKE_OUTSIDE': str(outside)}), self.assertRaisesRegex(RuntimeError, 'fixture root replaced'):
            self.run_mutations([('swap-base', 'LEAK = 0', 'LEAK = 7')], workers=1)
        fixtures = Path(self.leaked()[0][0])
        moved = Path(str(fixtures.parent) + '.moved')
        self.addCleanup(runner.wipe, moved)
        self.assertEqual((outside / fixtures.name / 'file').read_text(), 'kept')
        self.assertFalse(os.path.lexists(fixtures.parent))  # the link itself is removed, its target kept

    def test_a_fixture_root_owned_by_someone_else_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            runner.owned_directory(directory)
            with patch.object(runner.os, 'geteuid', return_value=os.geteuid() + 1), \
                 self.assertRaisesRegex(RuntimeError, 'fixture root replaced'):
                runner.owned_directory(directory)

    def test_the_command_line_entry_installs_the_sigterm_handler(self):
        import ast
        tree = ast.parse(Path(runner.__file__).read_text())
        entry = next(n for n in tree.body if isinstance(n, ast.If) and ast.unparse(n.test) == "__name__ == '__main__'")
        calls = [ast.unparse(n.func) for n in ast.walk(entry) if isinstance(n, ast.Call)]
        self.assertLess(calls.index('install_sigterm'), calls.index('main'))

    def test_a_timed_out_run_leaves_nothing_behind(self):
        with patch.object(runner, 'MUTANT_TIMEOUT', 2), self.assertRaises(runner.subprocess.TimeoutExpired):
            self.run_mutations([('slow-leak', 'LEAK = 0', 'LEAK = 3; DELAY = 8.0')], workers=1)
        self.assertEqual(len(self.leaked()), 1)
        self.assertFalse(Path(self.leaked()[0][0]).parent.exists())

    def test_sigterm_unwinds_and_removes_the_copies(self):
        code = ('import sys; sys.path.insert(0, %r); import r3_mutations as r; r.install_sigterm(); '
                'r.main(%r, 1, r.Path(%r), [(%r, "slow-leak", "LEAK = 0", "LEAK = 4; DELAY = 4.0")])'
                % (str(Path(runner.__file__).parent), str(self.output), str(self.source), FAKE))
        child = runner.subprocess.Popen([sys.executable, '-B', '-c', code], stdout=runner.subprocess.DEVNULL,
                                        stderr=runner.subprocess.PIPE)
        self.addCleanup(lambda: child.poll() is None and child.kill())
        deadline = time.monotonic() + 30
        while not self.leaked():
            self.assertIsNone(child.poll(), child.poll() is not None and child.stderr.read().decode()[-800:])
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.05)
        child.send_signal(runner.signal.SIGTERM)
        self.assertEqual(child.wait(timeout=30), 143)
        fixtures, copy = self.leaked()[0]
        self.assertFalse(Path(fixtures).exists())
        self.assertFalse(Path(copy).parent.exists())  # the r3-mutants-* worker copies
        self.assertFalse(Path(fixtures).parent.exists())
        self.assertFalse(self.output.exists())

    def test_at_least_one_worker(self):
        with self.assertRaisesRegex(ValueError, 'At least one mutation worker'):
            self.run_mutations([('survivor', 'KEEP = 1', 'KEEP = 2')], workers=0)


if __name__ == '__main__':
    unittest.main()
