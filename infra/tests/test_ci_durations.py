"""CI parallelism must preserve complete mutation and actual-image gates."""
import copy
import importlib.util
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/scripts'))
import ci_mutation_shard as shard
import ci_ubuntu_mirror as mirror


def workflow(name):
    return yaml.load((ROOT / '.github/workflows' / name).read_text(), Loader=yaml.BaseLoader)


def registry():
    spec = importlib.util.spec_from_file_location('duration_r3', ROOT / 'infra/tests/r3_mutations.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    return runner.MUTATIONS


class MutationShardTests(unittest.TestCase):
    def test_real_workflow_partitions_entire_registry_exactly_once(self):
        jobs = workflow('infra.yml')['jobs']
        matrix = jobs['mutation-shards']
        self.assertNotIn('if', matrix)
        self.assertNotIn('continue-on-error', matrix)
        self.assertEqual(matrix['strategy']['fail-fast'], 'false')
        self.assertEqual(set(matrix['strategy']), {'matrix', 'fail-fast'})
        indices = [int(i) for i in matrix['strategy']['matrix']['shard']]
        self.assertEqual(indices, list(range(shard.SHARDS)))
        mutations = registry()
        partitions = [shard.select(mutations, i) for i in indices]
        flattened = [item for part in partitions for item in part]
        self.assertCountEqual(flattened, mutations)
        self.assertEqual(len({(item[0], item[1]) for item in flattened}), len(mutations))
        self.assertLessEqual(max(map(len, partitions)) - min(map(len, partitions)), 1)
        step = matrix['steps'][-1]
        self.assertEqual(step['env'], {'MUTATION_SHARD': '${{ matrix.shard }}'})
        self.assertEqual(step['run'], 'python3 infra/scripts/ci_mutation_shard.py --shard "$MUTATION_SHARD" --output "$RUNNER_TEMP/r3-mutations.json"')
        for job in (matrix, jobs['validation']):
            for step in job['steps']:
                self.assertNotIn('continue-on-error', step)
                self.assertNotIn('if', step)
        for index in (-1, 4, True, '0'):
            with self.assertRaises(ValueError):
                shard.select(mutations, index)
        with self.assertRaises(ValueError):
            shard.select(mutations + [mutations[0]], 0)
        with self.assertRaises(ValueError):
            shard.select([], 0)

    def test_required_gate_rejects_every_partial_result(self):
        job = workflow('infra.yml')['jobs']['infra']
        self.assertEqual(job['if'], '${{ always() }}')
        self.assertEqual(set(job['needs']), {'validation', 'mutation-shards'})
        step = job['steps'][0]
        self.assertEqual(step['env'], {'RESULTS': '${{ toJSON(needs) }}'})
        outcomes = ('success', 'failure', 'cancelled', 'skipped')
        for pair in itertools.product(outcomes, repeat=2):
            results = dict(zip(job['needs'], ({'result': value} for value in pair)))
            self.check_gate(step['run'], results, pair == ('success', 'success'))
        self.check_gate(step['run'], {}, False)
        self.check_gate(step['run'], {'validation': {'result': 'success'}}, False)
        self.check_gate(step['run'], {key: {'result': 'success'} for key in (*job['needs'], 'extra')}, False)

    def check_gate(self, command, results, success):
        completed = subprocess.run(['bash', '-eu', '-c', command], capture_output=True,
            env={**os.environ, 'RESULTS': json.dumps(results)}, text=True)
        self.assertEqual(completed.returncode == 0, success, completed.stderr)

    def test_runner_delegation_and_refusal_of_incomplete_reports(self):
        mutations = [('file.py', f'mutation-{i}', 'old', 'new') for i in range(8)]
        selected = shard.select(mutations, 1)
        report = {'baseline': 'PASS', 'node_baseline': 'PASS', 'source_unchanged': True,
                  'invalid': 0, 'survived': [], 'killed': len(selected),
                  'source_sha256': {'file.py': 'a' * 64},
                  'mutations': [{'file': m[0], 'name': m[1], 'result': 'KILLED'} for m in selected]}
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'report.json'
            output.write_text(json.dumps(report))
            runner = types.SimpleNamespace(MUTATIONS=mutations, install_sigterm=Mock(), main=Mock(return_value=False))
            shard.run(runner, 1, output)
            runner.install_sigterm.assert_called_once_with()
            runner.main.assert_called_once_with(output, mutations=selected)
            runner.main.return_value = True
            with self.assertRaises(ValueError):
                shard.run(runner, 1, output)
            runner.main.return_value = False
            output.unlink()
            with self.assertRaises(FileNotFoundError):
                shard.run(runner, 1, output)
        for key, value in [('baseline', 'FAIL'), ('node_baseline', 'FAIL'),
                           ('source_unchanged', False), ('invalid', 1), ('survived', ['one']),
                           ('killed', 1), ('source_sha256', {}), ('mutations', [])]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                shard.verify({**report, key: value}, selected)
        for field, value in [('file', 'other.py'), ('name', 'other'), ('result', 'SURVIVED')]:
            bad = copy.deepcopy(report)
            bad['mutations'][0][field] = value
            with self.assertRaises(ValueError):
                shard.verify(bad, selected)
        for entries in (report['mutations'][::-1], [report['mutations'][0]] * 2):
            with self.assertRaises(ValueError):
                shard.verify({**report, 'mutations': entries}, selected)


class BrowserDependencyTests(unittest.TestCase):
    def test_mirror_rewrite_preserves_suites_and_signature_verification(self):
        source = '''Types: deb
URIs: http://azure.archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://azure.archive.ubuntu.com/ubuntu
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
'''
        expected = source.replace('http://azure.archive.ubuntu.com/ubuntu/', 'https://archive.ubuntu.com/ubuntu/').replace('https://azure.archive.ubuntu.com/ubuntu\n', 'https://archive.ubuntu.com/ubuntu/\n')
        self.assertEqual(mirror.primary_archive(source), expected)
        self.assertEqual(mirror.primary_archive(expected), expected)
        unrelated = '''# http://azure.archive.ubuntu.com/ubuntu/
URIs: https://example.org/ http://azure.archive.ubuntu.com/ubuntu/extra
URIs: http://azure.archive.ubuntu.com.evil/ubuntu/
Signed-By: http://azure.archive.ubuntu.com/ubuntu/
'''
        self.assertEqual(mirror.primary_archive(unrelated), unrelated)
        self.assertNotIn('AllowUnauthenticated', mirror.OPTIONS)

    def test_mirror_list_stanza_of_current_runner_images_is_rewritten(self):
        # ubuntu-24.04 runner images route the archive through a mirror list
        # whose first entry is azure.archive.ubuntu.com.
        source = '''Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates noble-backports noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
'''
        expected = source.replace('mirror+file:/etc/apt/apt-mirrors.txt', 'https://archive.ubuntu.com/ubuntu/')
        self.assertEqual(mirror.primary_archive(source), expected)
        self.assertEqual(mirror.primary_archive(expected), expected)
        unrelated = '''# URIs: mirror+file:/etc/apt/apt-mirrors.txt
URIs: mirror+file:/etc/apt/apt-mirrors.txt.d/other
URIs: mirror+file:/tmp/apt-mirrors.txt
Signed-By: mirror+file:/etc/apt/apt-mirrors.txt
'''
        self.assertEqual(mirror.primary_archive(unrelated), unrelated)

    def test_bounded_install_keeps_dependency_and_image_smoke_checks(self):
        job = workflow('ci.yml')['jobs']['docker-build']
        steps = job['steps']
        setup = next(i for i, s in enumerate(steps) if s.get('run') == 'sudo python3 infra/scripts/ci_ubuntu_mirror.py')
        install = next(i for i, s in enumerate(steps) if s.get('run') == 'pnpm exec playwright install --with-deps chromium')
        smoke = next(i for i, s in enumerate(steps) if s.get('run') == 'bash infra/scripts/local-image-smoke.sh')
        self.assertLess(setup, install)
        self.assertLess(install, smoke)
        self.assertEqual(steps[install]['timeout-minutes'], '6')
        for i in (setup, install, smoke):
            self.assertNotIn('if', steps[i])
            self.assertNotIn('continue-on-error', steps[i])


if __name__ == '__main__':
    unittest.main()
