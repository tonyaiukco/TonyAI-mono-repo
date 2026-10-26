"""QA source/target, privilege, plan and ARM-readback negative tests (offline)."""
import base64
from copy import deepcopy
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from candidate import fingerprint
from qa_contract import ROOT, GROUP, SUBNET, SUBSCRIPTION, candidate, load, release, sha256, target
from qa_expected import body, identity
from qa_application_policy import tags
from qa_foundation_plan import DEFAULT_OPTIONS
from qa_policy import check
from qa_readback import verify
from qa_release import check_plan


def fixture():
    certificate = (ROOT / 'infra/certs/prod-ca-2021.crt').read_bytes()
    payload = base64.urlsafe_b64encode(b'{"role":"anon"}').decode().rstrip('=')
    key = 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.synthetic'
    foundation = {
        'subscription_id': SUBSCRIPTION, 'tenant_id': '00000000-0000-0000-0000-000000000002',
        'environment': 'staging', 'region': 'swedencentral', 'resource_group': 'tonyai-staging-apps',
        'prefix': 'tonyai', 'registry_name': 'tonyaistaging', 'vault_name': 'tonyai-staging-kv',
        'default_domain': 'example.swedencentral.azurecontainerapps.io', 'apps_subnet_id': SUBNET,
    }
    build = {
        'source_sha': 'a' * 40,
        'supabase_origin': 'https://tonyai-staging-cb7efc2f-r02.example.swedencentral.cloudapp.azure.com',
        'db_ca_sha256': sha256(certificate), 'browser_key_sha256': sha256(key.encode()),
        'node_image': 'docker.io/library/node@sha256:' + 'e' * 64,
    }
    build['jwt_issuer'] = build['supabase_origin'] + '/auth/v1'
    selected = {'foundation': foundation, 'build': build}
    image = {'schema': 1, 'target': deepcopy(selected), 'api_digest': 'sha256:' + 'a' * 64,
             'web_digest': 'sha256:' + 'b' * 64, **fingerprint()}
    inputs = {'foundation': deepcopy(foundation), 'release': {
        **build, 'release_id': 'qa001', 'api_digest': image['api_digest'], 'web_digest': image['web_digest'],
        'database_secret_version': 'a' * 32, 'backend_secret_version': 'b' * 32,
        'storage_cleanup_hold': True, 'storage_sweep_interval_seconds': 300, 'runtime_limits': {},
    }}
    return selected, image, inputs, key, certificate


def plan_fixture(inputs):
    normalized = deepcopy(inputs)
    normalized['release']['mail'] = inputs['release'].get('mail')
    return {'timestamp': '2000-01-01T00:00:00Z', 'terraform_version': '1.13.3', 'format_version': '1.2', 'complete': True, 'errored': False, 'applyable': True,
            'output_changes': {'reviewed_inputs': {'actions': ['create'], 'after': deepcopy(normalized)}},
            'variables': {key: {'value': value} for key, value in normalized.items()},
            'resource_changes': [{
                'address': f'azapi_resource.app["{kind}"]', 'mode': 'managed', 'type': 'azapi_resource', 'provider_name': 'registry.terraform.io/azure/azapi',
                'change': {'actions': ['create'], 'after': {
                    **DEFAULT_OPTIONS, 'tags': tags(inputs), 'parent_id': GROUP, 'name': 'tonyai-staging-' + kind, 'location': 'swedencentral',
                    'type': 'Microsoft.App/containerApps@2025-01-01',
                    'response_export_values': ['properties.configuration.ingress.fqdn', 'properties.latestReadyRevisionName'],
                    'identity': [{'type': 'UserAssigned', 'identity_ids': [identity(kind)]}],
                    'body': body(inputs, kind)}, 'after_unknown': {}}}
                for kind in ('api', 'web')]}


class Contracts(unittest.TestCase):
    def setUp(self):
        self.selected, self.image, self.inputs, self.key, self.certificate = fixture()

    def test_bound_release(self):
        self.assertEqual(target(self.selected), self.selected)
        self.assertEqual(release(self.inputs, self.image), self.inputs)

    def test_reject_foreign_or_secret_fields(self):
        for area, field, value in [
            ('foundation', 'region', 'germanywestcentral'), ('foundation', 'environment', 'production'),
            ('foundation', 'apps_subnet_id', SUBNET + '-other'), ('foundation', 'vault_name', 'bad/url'),
            ('release', 'DATABASE_URL', 'synthetic'), ('release', 'direct_url', 'synthetic'),
            ('release', 'api_digest', 'latest'), ('release', 'database_secret_version', ''),
            ('release', 'jwt_issuer', 'https://foreign.example/auth/v1'),
            ('release', 'runtime_limits', {'DB_CONNECTION_LIMIT': 6}),
            ('release', 'storage_cleanup_hold', 1), ('release', 'storage_sweep_interval_seconds', True),
            ('release', 'node_image', 'node:22'), ('release', 'supabase_origin', 'https://example.supabase.co'),
        ]:
            with self.subTest(field=field):
                changed = deepcopy(self.inputs)
                changed[area][field] = value
                with self.assertRaises(Exception):
                    release(changed, self.image)

    def test_candidate_source_and_origins_cannot_be_rebound(self):
        for key, value in [('source_sha', 'b' * 40), ('db_ca_sha256', '0' * 64), ('browser_key_sha256', '0' * 64)]:
            changed = deepcopy(self.inputs)
            changed['release'][key] = value
            with self.assertRaises(Exception):
                release(changed, self.image)
        for field in ('lockfile_sha256', 'migrations'):
            changed = deepcopy(self.image)
            changed[field] = None
            with self.assertRaises(Exception):
                candidate(changed, self.selected)


    def test_duplicate_json_fields_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'input.json'
            path.write_text('{"release":1,"release":2}')
            with self.assertRaises(Exception):
                load(path)

    def test_release_cli_refuses_a_different_source_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            inputs, image = Path(directory) / 'inputs.json', Path(directory) / 'candidate.json'
            inputs.write_text(json.dumps(self.inputs))
            image.write_text(json.dumps(self.image))
            result = subprocess.run([sys.executable, str(ROOT / 'infra/scripts/qa_release.py'),
                                     '--inputs', str(inputs), '--candidate', str(image)],
                                    capture_output=True, text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('QA release/plan refused', result.stderr)
            self.assertNotIn(self.inputs['release']['supabase_origin'], result.stderr)




class PlanPolicy(unittest.TestCase):
    def setUp(self):
        _, _, self.inputs, _, _ = fixture()
        self.plan = plan_fixture(self.inputs)

    def test_exact_plan(self):
        check_plan(self.plan, self.inputs)

    def test_update_accepts_only_provider_computed_identity_fields(self):
        for row in self.plan['resource_changes']:
            change = row['change']
            change['actions'] = ['update']
            change['before'] = deepcopy(change['after'])
            change['before']['body']['properties']['template']['revisionSuffix'] = 'previous'
            change['after']['identity'][0].update(principal_id=None, tenant_id=None)
        check_plan(self.plan, self.inputs)
        self.plan['resource_changes'][0]['change']['after']['identity'][0]['foreign'] = 'field'
        with self.assertRaises(Exception):
            check_plan(self.plan, self.inputs)

    def test_reviewed_body_is_not_taken_from_same_plan_output(self):
        row = self.plan['resource_changes'][0]
        props = row['change']['after']['body']['properties']
        for attack in ('owner-env', 'sidecar', 'insecure', 'scale', 'secret', 'identity'):
            changed = deepcopy(self.plan)
            after = changed['resource_changes'][0]['change']['after']
            p = after['body']['properties']
            if attack == 'owner-env':
                p['template']['containers'][0]['env'].append({'name': 'DIRECT_URL', 'value': 'synthetic'})
            elif attack == 'sidecar':
                p['template']['containers'].append({'name': 'extra', 'image': 'unreviewed:latest'})
            elif attack == 'insecure':
                p['configuration']['ingress']['allowInsecure'] = True
            elif attack == 'scale':
                p['template']['scale']['maxReplicas'] = 2
            elif attack == 'identity':
                after['identity'][0]['identity_ids'] = [identity('web')]
            else:
                p['configuration']['secrets'][0]['value'] = 'synthetic'
            changed['planned_values'] = {'outputs': {'release_bodies': {'value': {'api': after['body']}}}}
            with self.subTest(attack=attack), self.assertRaises(Exception):
                check_plan(changed, self.inputs)
        self.assertEqual(props, self.plan['resource_changes'][0]['change']['after']['body']['properties'])

    def test_delete_unknown_and_revision_reuse_refused(self):
        for attack in ('delete', 'unknown', 'revision-reuse', 'extra-resource'):
            changed = deepcopy(self.plan)
            change = changed['resource_changes'][0]['change']
            if attack == 'delete':
                change['actions'] = ['delete', 'create']
            elif attack == 'unknown':
                change['after_unknown'] = {'body': True}
            elif attack == 'revision-reuse':
                change['actions'] = ['update']
                change['before'] = deepcopy(change['after'])
            else:
                changed['resource_changes'].append(deepcopy(changed['resource_changes'][0]))
            with self.subTest(attack=attack), self.assertRaises(Exception):
                check_plan(changed, self.inputs)

    def test_policy(self):
        check()

    def test_first_release_cannot_silently_clear_hold(self):
        self.inputs['release']['storage_cleanup_hold'] = False
        plan = plan_fixture(self.inputs)
        with self.assertRaises(Exception):
            check_plan(plan, self.inputs)
        check_plan(plan, self.inputs, acknowledge_clear_hold=True)


class Readback(unittest.TestCase):
    def setUp(self):
        _, _, self.inputs, _, _ = fixture()
        self.environment = {'id': GROUP + '/providers/Microsoft.App/managedEnvironments/tonyai-staging-env',
                            'location': 'swedencentral', 'properties': {
                                'vnetConfiguration': {'infrastructureSubnetId': SUBNET, 'internal': False},
                                'workloadProfiles': [{'name': 'Consumption', 'workloadProfileType': 'Consumption'}],
                                'defaultDomain': self.inputs['foundation']['default_domain']}}
        self.apps, self.revisions = {}, {}
        for kind in ('api', 'web'):
            name = 'tonyai-staging-' + kind
            app = {**body(self.inputs, kind), 'id': GROUP + '/providers/Microsoft.App/containerApps/' + name,
                   'location': 'swedencentral', 'tags': tags(self.inputs), 'identity': {'type': 'UserAssigned', 'userAssignedIdentities': {identity(kind): {}}}}
            app['properties']['provisioningState'] = 'Succeeded'
            app['properties']['latestReadyRevisionName'] = name + '--qa001'
            app['properties']['configuration']['ingress']['fqdn'] = name + '.' + self.inputs['foundation']['default_domain']
            self.apps[kind] = app
            self.revisions[kind] = [{'name': name + '--qa001', 'properties': {'active': True}}]

    def test_exact_readback_and_mutations(self):
        verify(self.inputs, self.environment, self.apps, self.revisions)
        for attack in ('subnet', 'extra-active-revision', 'secret', 'foreign-identity', 'command', 'init-container'):
            env, apps, revisions = deepcopy((self.environment, self.apps, self.revisions))
            if attack == 'subnet':
                env['properties']['vnetConfiguration']['infrastructureSubnetId'] = 'foreign'
            elif attack == 'extra-active-revision':
                revisions['api'].append({'name': 'tonyai-staging-api--old', 'properties': {'active': True}})
            elif attack == 'foreign-identity':
                apps['api']['identity']['userAssignedIdentities'][identity('web')] = {}
            elif attack == 'command':
                apps['api']['properties']['template']['containers'][0]['command'] = ['malicious']
            elif attack == 'init-container':
                apps['api']['properties']['template']['initContainers'] = [{'name': 'extra', 'image': 'mutable:latest'}]
            else:
                apps['api']['properties']['configuration']['secrets'][0]['value'] = 'synthetic'
            with self.subTest(attack=attack), self.assertRaises(Exception):
                verify(self.inputs, env, apps, revisions)


if __name__ == '__main__':
    unittest.main()
