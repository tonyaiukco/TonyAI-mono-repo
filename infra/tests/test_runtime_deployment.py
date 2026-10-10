"""Runtime rollout invariants: real orchestration with cloud and Terraform mocked."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from test_deploy_versions import inputs, app
from test_backend import config
from deploy_apps import main, verify
from terraform_run import invoke, validate_release
from runtime_limits import DEFAULTS, validate_limits, expected_env
from drain_api import drain, revisions
from pooler import SafeFailure, validate_pooler
from test_security_failures import GOOD_URL, PROJECT


class RuntimeDeploymentTests(unittest.TestCase):
    def test_confirmation_precedes_drain_and_saved_plan_apply(self):
        for action, answer in [('apply', 'yes'), ('apply', 'no'), ('apply', EOFError()), ('approved-apply', 'unused')]:
            with self.subTest(action=action, answer=answer), tempfile.TemporaryDirectory() as directory:
                backend = Path(directory) / 'backend.json'; backend.write_text(json.dumps(config()))
                release = Path(directory) / 'release.json'; release.write_text(json.dumps(inputs()))
                events = []
                def run(args, **kwargs):
                    events.append(args[2:]); return Mock(returncode=0)
                def confirm(_):
                    events.append(['confirm'])
                    if isinstance(answer, Exception): raise answer
                    return answer
                with patch('terraform_run.subprocess.run', side_effect=run), patch('builtins.input', side_effect=confirm):
                    work = lambda: invoke('application', backend, release, action, before_apply=lambda: events.append(['drain']))
                    if answer == 'no' or isinstance(answer, Exception):
                        with self.assertRaises((SafeFailure, EOFError)): work()
                        self.assertFalse(any(e[0] in ('drain', 'apply') for e in events))
                    else:
                        work()
                        order = [e[0] for e in events]
                        self.assertEqual(order, ['init', 'plan', 'show', 'confirm', 'drain', 'apply'] if action == 'apply' else ['init', 'plan', 'drain', 'apply'])
                        plan = next(a[5:] for e in events for a in e if a.startswith('-out='))
                        self.assertEqual(events[-1][-1], plan)

    def test_failed_plan_or_drain_never_applies(self):
        for fail in ('plan', 'drain'):
            with tempfile.TemporaryDirectory() as directory:
                backend = Path(directory) / 'backend.json'; backend.write_text(json.dumps(config()))
                release = Path(directory) / 'release.json'; release.write_text(json.dumps(inputs()))
                events = []
                def run(args, **kwargs):
                    events.append(args[2]); return Mock(returncode=int(args[2] == fail))
                def stop():
                    events.append('drain'); raise SafeFailure('Synthetic refusal')
                with patch('terraform_run.subprocess.run', side_effect=run), self.assertRaises(SafeFailure):
                    invoke('application', backend, release, 'approved-apply', before_apply=stop)
                self.assertNotIn('apply', events)
                if fail == 'plan': self.assertNotIn('drain', events)

    def test_deploy_wires_drain_inside_invoke_before_apply(self):
        for approved in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                release = Path(directory) / 'release.json'; release.write_text(json.dumps(inputs()))
                events = []
                def invoke_mock(*args, **kwargs):
                    self.assertEqual(args[3], 'approved-apply' if approved else 'apply')
                    events.append('plan'); kwargs['before_apply'](); events.append('apply')
                with patch('sys.argv', ['deploy_apps', '--backend', 'unused', '--inputs', str(release)] + (['--approved-apply'] if approved else [])), patch('deploy_apps.check_hold_transition'), patch('deploy_apps.verify'), patch('deploy_apps.invoke', side_effect=invoke_mock), patch('deploy_apps.drain', side_effect=lambda *a, **kw: events.append('drain')) as stopped:
                    main()
                self.assertEqual(events, ['plan', 'drain', 'apply'])
                self.assertGreaterEqual(stopped.call_args.kwargs['attempts'] * 2, 150)

    def test_readback_checks_every_runtime_setting_and_accepts_arm_extra_fields(self):
        defects = ['none', 'cpu', 'cpu-bool', 'memory', 'min', 'max', 'grace', 'mode', 'containers', 'revision'] + list(expected_env(inputs()['release']))
        for defect in defects:
            with self.subTest(defect=defect):
                contract = inputs(); api = app('api', contract)
                props = api['properties']; template = props['template']; container = template['containers'][0]
                container['resources']['ephemeralStorage'] = '4Gi'
                if defect == 'cpu': container['resources']['cpu'] = 0.5
                if defect == 'cpu-bool': container['resources']['cpu'] = True
                if defect == 'memory': container['resources']['memory'] = '1Gi'
                if defect in ('min', 'max'): template['scale'][defect + 'Replicas'] = 2
                if defect == 'grace': template['terminationGracePeriodSeconds'] = 30
                if defect == 'mode': props['configuration']['activeRevisionsMode'] = 'Multiple'
                if defect == 'containers': template['containers'].append(container.copy())
                if defect in expected_env(contract['release']): container['env'] = [e for e in container['env'] if e['name'] != defect]
                def read(*args):
                    if args[:3] == ('containerapp', 'revision', 'list'):
                        return [{'name': 'tonyai-staging-api--' + ('wrong' if defect == 'revision' else 'r001'), 'properties': {'active': True}}]
                    return api if args[-1].endswith('-api') else app('web', contract)
                with contextlib.redirect_stdout(io.StringIO()):
                    if defect == 'none': verify(contract, read)
                    else:
                        with self.assertRaises(SafeFailure): verify(contract, read)

    def test_all_revisions_exact_command_and_deactivation(self):
        foundation = inputs()['foundation']; calls = []; active = True
        def read(*args):
            nonlocal active
            calls.append(args)
            if args[:3] == ('containerapp', 'revision', 'list'):
                self.assertEqual(args, ('containerapp', 'revision', 'list', '--all', '--subscription', foundation['subscription_id'], '-g', foundation['resource_group'], '-n', 'tonyai-staging-api'))
                return [{'name': 'tonyai-staging-api--' + suffix, 'properties': {'active': active}} for suffix in ('old1', 'old2')]
            if args[:3] == ('containerapp', 'revision', 'deactivate'): active = False
            return []
        drain(foundation, 'r001', read=read, sleep=lambda _: None)
        self.assertEqual([a[-1] for a in calls if a[:3] == ('containerapp', 'revision', 'deactivate')], ['tonyai-staging-api--old1', 'tonyai-staging-api--old2'])

    def test_inactive_replicas_and_malformed_replica_results_fail_closed(self):
        for same in (False, True):
            for replicas in ([{'name': 'still-running'}], {}):
                def read(*args):
                    if args[:3] == ('containerapp', 'replica', 'list'): return replicas
                    return ([{'name': 'tonyai-staging-api--r001', 'properties': {'active': True}}] if same else []) + [{'name': 'tonyai-staging-api--old', 'properties': {'active': False}}]
                with self.assertRaises(SafeFailure): drain(inputs()['foundation'], 'r001', read=read, sleep=lambda _: None, attempts=1)

    def test_budgets_and_hosted_secret_validation(self):
        self.assertEqual(validate_limits({'RATE_MAX_KEYS': 2147483647})['RATE_MAX_KEYS'], 2147483647)
        self.assertEqual(validate_limits({'SHUTDOWN_GRACE_MS': 110000})['SHUTDOWN_GRACE_MS'], 110000)
        self.assertEqual(expected_env(inputs()['release'])['PROXY_MODE'], 'azure')
        for changes in [{'HTTP_HEADERS_TIMEOUT_MS': 30001}, {'MUTATION_USER_CONCURRENCY': 3}, {'MUTATION_CONCURRENCY': 5}, {'IMPORT_CONCURRENCY': 4}, {'UPLOAD_USER_CONCURRENCY': 3}, {'SHUTDOWN_GRACE_MS': 109999}, {'SHUTDOWN_GRACE_MS': 3600001}]:
            with self.subTest(changes=changes), self.assertRaises(SafeFailure): validate_limits(changes)
        contract = inputs(); contract['release']['runtime_limits'] = {'RATE_MAX_KEYS': 0}
        with self.assertRaises(SafeFailure): validate_release(contract)
        for query in ('connection_limit=5', 'pool_timeout=5', 'connection_limit=8'):
            with self.assertRaises(SafeFailure): validate_pooler(GOOD_URL + '&' + query, PROJECT, 6543)
        owner = GOOD_URL.replace('tonyai_runtime.', 'postgres.').replace(':6543', ':5432')
        validate_pooler(owner + '&pool_timeout=2147483647', PROJECT, 5432)
        with self.assertRaises(SafeFailure): validate_pooler(owner + '&pool_timeout=2147483648', PROJECT, 5432)
