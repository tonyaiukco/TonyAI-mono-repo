"""Runtime policies are protection settings, not measured capacity claims."""
import json
import re
import sys
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/scripts'))
from runtime_limits import DEFAULTS, validate_limits
from drain_api import drain, revisions
from pooler import SafeFailure
from test_deploy_versions import inputs


class RuntimeLimitTests(unittest.TestCase):
    def test_infrastructure_defaults_equal_api_defaults(self):
        source = (ROOT / 'apps/api/src/common/runtime-config.ts').read_text().split('} as const;')[0]
        actual = {k: int(v.replace('_', '')) for k, v in re.findall(r'([A-Z][A-Z_]+): ([\d_]+)', source)}
        self.assertEqual(DEFAULTS, actual)

    def test_every_limit_rejects_invalid_values(self):
        for name in DEFAULTS:
            for bad in (0, -1, True, '1', 1.5, None, 2147483648):
                with self.subTest(name=name, bad=bad), self.assertRaises(SafeFailure):
                    validate_limits({name: bad})
        for value in ({'DIRECT_URL': 1}, {'DB_CONNECTION_LIMIT': 2}, {'MUTATION_USER_CONCURRENCY': 3}):
            with self.assertRaises(SafeFailure): validate_limits(value)
        self.assertEqual(validate_limits({'REPORT_RECORD_LIMIT': 1})['REPORT_RECORD_LIMIT'], 1)

    def test_drain_waits_for_inactive_replicas_to_disappear(self):
        calls = []
        active = True
        polls = 0
        def read(*args):
            nonlocal active, polls
            calls.append(args[:3])
            if args[:3] == ('containerapp', 'revision', 'deactivate'):
                active = False
                return {}
            if args[:3] == ('containerapp', 'replica', 'list'):
                polls += 1
                return [{'name': 'old'}] if polls == 1 else []
            return [{'name': 'tonyai-staging-api--old', 'properties': {'active': active}}]
        drain(inputs()['foundation'], 'next', read=read, sleep=lambda _: None)
        self.assertEqual(polls, 2)
        self.assertIn(('containerapp', 'revision', 'deactivate'), calls)

    def test_drain_fails_closed_on_unknown_state_or_remaining_replicas(self):
        for bad in ({}, None, [{'name': 'foreign--revision', 'properties': {'active': True}}]):
            with self.assertRaises(SafeFailure): revisions(inputs()['foundation'], read=lambda *args: bad)
        def remaining(*args):
            if args[:3] == ('containerapp', 'replica', 'list'): return [{'name': 'running'}]
            return [{'name': 'tonyai-staging-api--old', 'properties': {'active': False}}]
        with self.assertRaises(SafeFailure):
            drain(inputs()['foundation'], 'next', read=remaining, sleep=lambda _: None, attempts=2)

    def test_first_creation_requires_successful_inventory_proving_absence(self):
        for inventory in ([], ['tonyai-staging-api'], {}, None):
            def read(*args):
                if args[:3] == ('containerapp', 'revision', 'list'):
                    raise SafeFailure('Unavailable')
                self.assertEqual(args[:2], ('containerapp', 'list'))
                return inventory
            if inventory == []:
                drain(inputs()['foundation'], 'r001', read=read)
            else:
                with self.assertRaises(SafeFailure): drain(inputs()['foundation'], 'r001', read=read)
        with self.assertRaises(SafeFailure):
            drain(inputs()['foundation'], 'r001', read=lambda *args: (_ for _ in ()).throw(SafeFailure('Permission denied')))

    def test_same_release_and_web_only_redeploy_leave_the_api_active(self):
        for change_web in (False, True):
            contract = inputs()
            if change_web: contract['release']['web_digest'] = 'sha256:' + 'c' * 64
            calls = []
            def read(*args):
                calls.append(args[:3])
                return [{'name': 'tonyai-staging-api--r001', 'properties': {'active': True}}]
            drain(contract['foundation'], contract['release']['release_id'], read=read)
            self.assertEqual(calls, [('containerapp', 'revision', 'list')])

    def test_failed_apply_retry_requires_explicit_recovery_and_never_deactivates_target(self):
        for active, overlap in ((False, False), (True, True)):
            calls = []
            def read(*args):
                calls.append(args[:3])
                if args[:3] == ('containerapp', 'replica', 'list'): return []
                rows = [{'name': 'tonyai-staging-api--r001', 'properties': {'active': active}}]
                if overlap: rows.append({'name': 'tonyai-staging-api--old', 'properties': {'active': True}})
                return rows
            with self.assertRaises(SafeFailure): drain(inputs()['foundation'], 'r001', read=read)
            self.assertNotIn(('containerapp', 'revision', 'deactivate'), calls)

    def test_compose_grace_covers_the_api_drain(self):
        compose = yaml.safe_load((ROOT / 'docker-compose.yml').read_text())
        self.assertGreaterEqual(int(compose['services']['api']['stop_grace_period'].removesuffix('s')) * 1000, DEFAULTS['SHUTDOWN_GRACE_MS'])

    def test_images_keep_mirror_and_do_not_copy_the_builder_tree(self):
        api = (ROOT / 'apps/api/Dockerfile').read_text()
        self.assertNotIn('/app /app', api)
        self.assertIn('--prod --filter @tonyai/api... --ignore-scripts', api)
        self.assertIn('packages/db/generated', api)
        self.assertIn('ENTRYPOINT ["/usr/bin/tini", "--"]', api)
        for file in ('api', 'web'):
            source = (ROOT / f'apps/{file}/Dockerfile').read_text()
            stages = set()
            for line in source.splitlines():
                if not line.startswith('FROM '): continue
                tokens = line.split()
                base = tokens[1]
                self.assertTrue(base.startswith('public.ecr.aws/docker/library/') or base in stages, line)
                if len(tokens) >= 4: stages.add(tokens[3])



if __name__ == '__main__':
    unittest.main()
