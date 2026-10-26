"""Bound observation windows, complete revision sets and non-authorizing packets."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import shlex
from types import SimpleNamespace
import unittest
import jmespath
from test_qa_application import fixture
import test_qa_application as application_tests
from qa_application_receipt import manifest, verify_receipt
from qa_discovery import digest
from qa_owner_packet import prepare, rollback_evidence, commands
from drain_api import drain
from pooler import SafeFailure

NOW = datetime.now(timezone.utc).replace(microsecond=0)
START = (NOW - timedelta(minutes=5)).strftime('%Y-%m-%dT%H:%M:%SZ')
END = (NOW - timedelta(minutes=4)).strftime('%Y-%m-%dT%H:%M:%SZ')
EARLIER = (NOW - timedelta(minutes=6)).strftime('%Y-%m-%dT%H:%M:%SZ')
PLAN = 'c' * 64


def receipt(inputs, phase='before', first=False):
    names = {k: [] if first else [f'tonyai-staging-{k}--old'] for k in ('api', 'web')}
    if phase == 'after':
        for k in names: names[k] = sorted(names[k] + [f'tonyai-staging-{k}--qa001'])
    spec = manifest(inputs, PLAN, names, phase)
    data = {'inventory': [] if first else ['tonyai-staging-api', 'tonyai-staging-web']}
    for kind in ('api', 'web'):
        if not first:
            data[kind + '_revisions'] = [{'name': n, 'properties': {'active': n.endswith('--qa001') if phase == 'after' else phase == 'before'}} for n in names[kind]]
        for name in names[kind]: data['replicas:' + name] = []
    if phase == 'after':
        sample = application_tests.Readback(); sample.setUp()
        data['environment'] = sample.environment
        data.update({k + '_app': sample.apps[k] for k in ('api', 'web')})
    result = {k: spec[k] for k in ('source_sha', 'release_id', 'inputs_sha256', 'plan_sha256', 'phase', 'revision_names')}
    result.update(manifest_sha256=digest(spec), started_at=START, completed_at=END,
        records=[{'key': k, 'complete': True, 'pages': [{'argv_sha256': digest(spec['commands'][k]['argv']),
            'exit_code': 0, 'started_at': START, 'completed_at': END, 'result': v, 'result_sha256': digest(v)}]} for k, v in data.items()])
    return names, result


class Receipts(unittest.TestCase):
    def setUp(self):
        _, self.candidate, self.inputs, _, _ = fixture()

    def verify(self, value, names, phase):
        return verify_receipt(self.inputs, PLAN, value, names, phase, not_before=EARLIER, now=NOW,
                              outgoing={k: [f'tonyai-staging-{k}--old'] for k in ('api', 'web')})

    def test_first_existing_drained_and_after(self):
        for phase, first in [('before', True), ('before', False), ('drained', False), ('after', False)]:
            names, value = receipt(self.inputs, phase, first)
            self.assertFalse(self.verify(value, names, phase)['authenticated_azure_provenance'])

    def test_wrong_binding_old_missing_or_error_observations(self):
        names, original = receipt(self.inputs)
        for key, value in [('source_sha', 'b'*40), ('release_id', 'other'), ('inputs_sha256', '0'*64),
                           ('plan_sha256', '0'*64), ('phase', 'after'), ('manifest_sha256', '0'*64),
                           ('started_at', '2000-01-01T00:00:00Z'), ('completed_at', '2999-01-01T00:00:00Z')]:
            changed = deepcopy(original); changed[key] = value
            with self.subTest(key=key), self.assertRaises(Exception): self.verify(changed, names, 'before')
        for attack in ('missing', 'duplicate', 'incomplete', 'permission', 'network', 'wrong-command', 'hash'):
            changed = deepcopy(original)
            row = changed['records'][0]
            if attack == 'missing': changed['records'].pop()
            elif attack == 'duplicate': changed['records'].append(deepcopy(row))
            elif attack == 'incomplete': row['complete'] = False
            elif attack in ('permission', 'network'): row['pages'][0]['exit_code'] = 1
            elif attack == 'wrong-command': row['pages'][0]['argv_sha256'] = '0'*64
            else: row['pages'][0]['result_sha256'] = '0'*64
            with self.subTest(attack=attack), self.assertRaises(Exception): self.verify(changed, names, 'before')

    def test_missing_revision_remaining_active_or_replica_and_reuse(self):
        for phase in ('before', 'drained', 'after'):
            names, original = receipt(self.inputs, phase)
            for attack in ('missing-revision', 'active', 'replica', 'reuse'):
                if phase == 'before' and attack in ('active', 'replica'): continue
                if phase != 'before' and attack == 'reuse': continue
                changed = deepcopy(original)
                key = 'replicas:tonyai-staging-api--old' if attack == 'replica' else 'api_revisions'
                page = next(r for r in changed['records'] if r['key'] == key)['pages'][0]
                if attack == 'missing-revision': page['result'] = []
                elif attack == 'active': page['result'][0]['properties']['active'] = True
                elif attack == 'replica': page['result'] = ['remaining']
                else: page['result'][0]['name'] = 'tonyai-staging-api--qa001'
                page['result_sha256'] = digest(page['result'])
                with self.subTest(phase=phase, attack=attack), self.assertRaises(Exception): self.verify(changed, names, phase)

    def test_after_must_follow_apply_and_match_source_tags(self):
        names, value = receipt(self.inputs, 'after')
        with self.assertRaises(Exception):
            verify_receipt(self.inputs, PLAN, value, names, 'after', not_before=END, now=NOW,
                           outgoing={k: [f'tonyai-staging-{k}--old'] for k in ('api', 'web')})
        page = next(r for r in value['records'] if r['key'] == 'api_app')['pages'][0]
        page['result']['tags']['source'] = 'b'*40; page['result_sha256'] = digest(page['result'])
        with self.assertRaises(Exception): self.verify(value, names, 'after')

    def test_later_phase_cannot_rewrite_approved_outgoing_set(self):
        names, value = receipt(self.inputs, 'after')
        # Recompute every mutable receipt/manifest hash after hiding an old revision.
        names['api'].remove('tonyai-staging-api--old')
        spec = manifest(self.inputs, PLAN, names, 'after')
        value['revision_names'] = names
        value['manifest_sha256'] = digest(spec)
        value['records'] = [r for r in value['records'] if r['key'] != 'replicas:tonyai-staging-api--old']
        page = next(r for r in value['records'] if r['key'] == 'api_revisions')['pages'][0]
        page['result'] = [r for r in page['result'] if r['name'] != 'tonyai-staging-api--old']
        page['result_sha256'] = digest(page['result'])
        with self.assertRaises(Exception): self.verify(value, names, 'after')

    def test_real_jmespath_projects_references_never_secret_values(self):
        names, value = receipt(self.inputs, 'after')
        sample = application_tests.Readback(); sample.setUp()
        for kind in ('api', 'web'):
            app = deepcopy(sample.apps[kind])
            app['properties']['configuration']['secrets'] = [{'name': 'x', 'value': 'SECRET_CANARY', 'keyVaultUrl': 'reference', 'identity': 'id'}]
            argv = manifest(self.inputs, PLAN, names, 'after')['commands'][kind + '_app']['argv']
            result = jmespath.search(argv[argv.index('--query') + 1], app)
            self.assertNotIn('SECRET_CANARY', json.dumps(result))
            self.assertEqual(result['tags'], app['tags'])

    def test_raw_arm_through_projection_accepts_traffic_and_rejects_ingress_extensions(self):
        names, original = receipt(self.inputs, 'after')
        spec = manifest(self.inputs, PLAN, names, 'after')
        for attack in (None, 'additionalPortMappings', 'exposedPort', 'corsPolicy', 'customDomains', 'clientCertificateMode'):
            value = deepcopy(original)
            for kind in ('api', 'web'):
                page = next(r for r in value['records'] if r['key'] == kind + '_app')['pages'][0]
                raw = page['result']
                ingress = raw['properties']['configuration']['ingress']
                ingress['traffic'] = [{'latestRevision': True, 'weight': 100}]
                if attack:
                    ingress[attack] = 'unexpected'
                argv = spec['commands'][kind + '_app']['argv']
                page['result'] = jmespath.search(argv[argv.index('--query') + 1], raw)
                page['result_sha256'] = digest(page['result'])
            with self.subTest(attack=attack):
                if attack:
                    with self.assertRaises(Exception): self.verify(value, names, 'after')
                else:
                    self.verify(value, names, 'after')

    def test_present_apps_cannot_have_empty_revision_observations(self):
        for phase in ('before', 'drained'):
            names, value = receipt(self.inputs, phase, first=True)
            spec = manifest(self.inputs, PLAN, names, phase)
            page = value['records'][0]['pages'][0]
            page['result'] = ['tonyai-staging-api', 'tonyai-staging-web']
            page['result_sha256'] = digest(page['result'])
            for kind in ('api', 'web'):
                empty = {**page, 'result': [], 'result_sha256': digest([]), 'argv_sha256': digest(spec['commands'][kind + '_revisions']['argv'])}
                value['records'].append({'key': kind + '_revisions', 'complete': True, 'pages': [empty]})
            with self.subTest(phase=phase), self.assertRaises(Exception): self.verify(value, names, phase)

    def test_drain_refuses_changed_or_disappearing_approved_sets(self):
        rows = [{'name': 'tonyai-staging-api--old', 'properties': {'active': True}}]
        calls = []
        def read(*args):
            calls.append(args)
            if args[:3] == ('containerapp', 'revision', 'list'): return rows if len(calls) == 1 else []
            return []
        with self.assertRaises(SafeFailure): drain(self.inputs['foundation'], 'qa001', read=read, expected_revision_names=[])
        self.assertEqual(len(calls), 1)
        calls.clear()
        with self.assertRaises(SafeFailure): drain(self.inputs['foundation'], 'qa001', read=read, sleep=lambda _: None,
            expected_revision_names=['tonyai-staging-api--old'])

    def test_packet_is_always_blocked_and_unverified_candidate_cannot_promote_it(self):
        report = dict(source_sha=self.inputs['release']['source_sha'], release_id='qa001',
            normalized_inputs_sha256=digest(self.inputs), plan_sha256=PLAN,
            plan_created_at=EARLIER, resources=[{'actions': ['create']}, {'actions': ['create']}])
        args = SimpleNamespace(inputs='/private/tmp/release.json', candidate='/private/tmp/candidate.json',
                               saved_plan='/private/tmp/application.tfplan', terraform='/private/tmp/terraform')
        packet = prepare(self.inputs, report, {'verification': 'fixture_only'}, args)
        self.assertEqual(packet['status'], 'BLOCKED_DRAFT'); self.assertFalse(packet['authorization'])
        self.assertIsNone(packet['command_templates'])
        names, value = receipt(self.inputs, first=True)
        observation = dict(plan_completed_at=EARLIER, revision_names=names, receipt=value)
        packet = prepare(self.inputs, report, {'verification': 'fixture_only'}, args, observation)
        self.assertFalse(packet['authorization']); self.assertEqual(packet['rollback']['status'], 'NO_PREDECESSOR')
        self.assertIn('expected_revision_names=[]', packet['command_templates']['drain'])
        with self.assertRaises(Exception): prepare(self.inputs, report, {}, args, observation, {})
        with self.assertRaises(Exception): rollback_evidence(self.inputs, {'inputs': self.inputs}, 'existing_revision_update')

    def test_predecessor_is_only_a_proposal_and_requires_bound_evidence(self):
        prior = deepcopy(self.inputs); prior['release']['release_id'] = 'old'
        evidence = dict(inputs=prior, candidate=self.candidate, accepted_readback_sha256='a'*64, compatibility_review_sha256='b'*64)
        result = rollback_evidence(self.inputs, evidence, 'existing_revision_update')
        self.assertTrue(result['status'].startswith('BLOCKED_'))
        for field in ('accepted_readback_sha256', 'compatibility_review_sha256'):
            changed = deepcopy(evidence); del changed[field]
            with self.subTest(field=field), self.assertRaises(Exception): rollback_evidence(self.inputs, changed, 'existing_revision_update')
        changed = deepcopy(evidence); changed['candidate']['api_digest'] = 'sha256:'+'c'*64
        with self.assertRaises(Exception): rollback_evidence(self.inputs, changed, 'existing_revision_update')

    def test_command_paths_remain_literal_and_phase_does_not_rewrite_them(self):
        args = SimpleNamespace(inputs='/private/tmp/application-after.json', candidate='/private/tmp/$(never-run) candidate.json',
                               saved_plan='/private/tmp/plan with space;literal.tfplan', terraform='/private/tmp/terraform')
        result = commands(self.inputs, {'plan_sha256': PLAN}, args, {'api': [], 'web': []})
        for phase, key in [('drained', 'drained_receipt'), ('after', 'readback')]:
            argv = shlex.split(result[key])
            self.assertEqual(argv[argv.index('--inputs') + 1], args.inputs)
            self.assertEqual(argv[argv.index('--candidate') + 1], args.candidate)
            self.assertEqual(argv[argv.index('--phase') + 1], phase)
        self.assertEqual(shlex.split(result['saved_plan_apply'])[-1], args.saved_plan)
        self.assertIn(shlex.quote(args.candidate), result['readback'])
