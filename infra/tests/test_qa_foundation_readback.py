"""Synthetic ARM readback and real JMESPath projection execution; no Azure calls."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
import jmespath
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from qa_discovery import digest, manifest as discovery_manifest, timestamp
from qa_foundation_expected import expected, resource_id
from qa_foundation_inputs import initial_inputs
from qa_foundation_readback import manifest, verify_receipt, verify_roles, verify_readback
from qa_preflight_fixtures import STAMP, PRINCIPALS, inputs, record, request, discovery_data, make_bundle


def receipt():
    spec, data, roles = manifest(inputs()), {}, []
    for address, wanted in expected(initial_inputs(inputs()), PRINCIPALS).items():
        if address.startswith('azapi_resource.grant['):
            roles.append(dict(id=resource_id(wanted), scope=wanted['parent_id'],
                              **wanted['body']['properties'], condition=None, conditionVersion=None, delegated=None))
            continue
        row = dict(id=resource_id(wanted), location=wanted['location'], tags=wanted['tags'],
                   body=deepcopy(wanted['body']), provisioning_state='Succeeded')
        if address.startswith('azapi_resource.identity['):
            row['principal_id'] = PRINCIPALS['api' if '"api"' in address else 'web']
        if address == 'azapi_resource.environment':
            row['default_domain'] = 'example.swedencentral.azurecontainerapps.io'
        data[address] = row
    data['roles'] = roles
    return dict(source_sha='a' * 40, manifest_sha256=digest(spec), started_at=STAMP, completed_at=STAMP,
                records=[record(k, v, data[k]) for k, v in spec['commands'].items()])


class Readback(unittest.TestCase):
    def test_exact_readback_and_roles(self):
        data, principals = verify_receipt(inputs(), receipt(), now=timestamp(STAMP))
        verify_roles(initial_inputs(inputs()), principals, [], data['roles'])

    def test_modified_grants_unchanged_old_roles_and_extra_role_refused(self):
        data, principals = verify_receipt(inputs(), receipt(), now=timestamp(STAMP))
        for attack in ('condition', 'scope', 'principal', 'duplicate', 'extra', 'old-change'):
            rows = deepcopy(data['roles']); old = []
            if attack == 'condition': rows[0]['condition'] = 'foreign'
            elif attack == 'scope': rows[0]['scope'] = '/subscriptions/foreign'
            elif attack == 'principal': rows[0]['principalId'] = 'foreign'
            elif attack == 'duplicate': rows.append(deepcopy(rows[0]))
            elif attack == 'extra': rows.append({**rows[0], 'id': rows[0]['id'] + '-foreign'})
            else:
                old = [{**rows[0], 'id': rows[0]['id'] + '-old'}]
                rows.append({**old[0], 'condition': 'changed'})
            with self.subTest(attack=attack), self.assertRaises(Exception):
                verify_roles(initial_inputs(inputs()), principals, old, rows)

    def test_complete_readback_and_missing_resource_disk_nsg_temporal_negatives(self):
        before_request, after_request = request(), request()
        after_request['dns_zones'] = [dict(group='tonyai-staging-apps', name='qa.tonyai.internal')]
        before, after = discovery_data(), discovery_data()
        resources = expected(initial_inputs(inputs()), PRINCIPALS)
        for address in ('registry', 'logs', 'environment', 'vault', 'identity["api"]', 'identity["web"]', 'dns'):
            row = resources['azapi_resource.' + address]
            after['resources'].append(dict(id=resource_id(row), type=row['type'].split('@')[0], location=row['location']))
        env = resources['azapi_resource.environment']
        after['environments'] = [dict(id=resource_id(env), location='swedencentral', subnet_id=env['body']['properties']['vnetConfiguration']['infrastructureSubnetId'])]
        after['zones'] = [dict(id=resource_id(resources['azapi_resource.dns']), location='global')]
        after['dns_links_0'] = [dict(id=resource_id(resources['azapi_resource.dns_link']), vnet_id=resources['azapi_resource.dns_link']['body']['properties']['virtualNetwork']['id'], registration=False)]
        after['dns_a_0'] = [dict(id=resource_id(resources['azapi_resource.db_address']), ttl=300, addresses=['10.80.1.4'])]
        after['network']['subnets'][2]['association_count'] = 1
        roles = dict(started_at=STAMP, completed_at=STAMP, record=record('roles', manifest(inputs())['commands']['roles'], []))
        def verify(data, rec=None):
            return verify_readback(inputs(), rec or receipt(), before_request, make_bundle(before_request, before),
                after_request, make_bundle(after_request, data), roles, now=timestamp(STAMP))
        self.assertEqual(verify(after)['status'], 'OFFLINE_READBACK_CONSISTENCY_ONLY')
        for address in ('registry', 'logs', 'vault', 'identity["api"]', 'identity["web"]', 'dns'):
            changed = deepcopy(after)
            identity = resource_id(resources['azapi_resource.' + address])
            changed['resources'] = [r for r in changed['resources'] if r['id'] != identity]
            with self.subTest(missing=address), self.assertRaises(Exception): verify(changed)
        for attack in ('disk-attachment', 'image', 'disk-metadata', 'nic-nsg', 'dns-link', 'dns-ip', 'receipt-time'):
            changed, rec = deepcopy(after), receipt()
            if attack == 'disk-attachment': changed['host']['os_disk_id'] = changed['host']['data_disks'][0]['id']
            elif attack == 'image': changed['host']['image']['version'] = 'foreign'
            elif attack == 'disk-metadata': changed['disks'][0]['unique_id'] = 'foreign'
            elif attack == 'nic-nsg': changed['nic']['nsg_id'] = 'foreign'
            elif attack == 'dns-link': changed['dns_links_0'] = []
            elif attack == 'dns-ip': changed['dns_a_0'][0]['addresses'] = ['10.80.0.4']
            else: rec['started_at'] = '2026-10-26T11:59:00Z'
            with self.subTest(attack=attack), self.assertRaises(Exception): verify(changed, rec)

    def test_partial_mismatched_or_secret_projection_refused(self):
        for attack in ('partial', 'wrong-region', 'extra-body', 'identity-collision', 'unknown-field'):
            value = receipt()
            address = 'azapi_resource.identity["web"]' if attack == 'identity-collision' else 'azapi_resource.environment'
            page = next(r for r in value['records'] if r['key'] == address)['pages'][0]
            row = page['result']
            if attack == 'partial': row['provisioning_state'] = 'Updating'
            elif attack == 'wrong-region': row['location'] = 'germanywestcentral'
            elif attack == 'extra-body': row['body']['properties']['foreign'] = 'SECRET_CANARY'
            elif attack == 'identity-collision': row['principal_id'] = PRINCIPALS['api']
            else: row['secret'] = 'SECRET_CANARY'
            page['result_sha256'] = digest(row)
            with self.subTest(attack=attack), self.assertRaises(Exception): verify_receipt(inputs(), value, now=timestamp(STAMP))


class Queries(unittest.TestCase):
    def test_all_generated_queries_compile(self):
        for spec in (discovery_manifest(request()), manifest(inputs())):
            for command in spec['commands'].values():
                argv = command['argv']
                jmespath.compile(argv[argv.index('--query') + 1])

    def test_foundation_queries_drop_unlisted_credentials(self):
        spec = manifest(inputs())
        for address, wanted in expected(initial_inputs(inputs()), PRINCIPALS).items():
            if address.startswith('azapi_resource.grant['): continue
            raw = {**deepcopy(wanted['body']), 'id': resource_id(wanted), 'location': wanted['location'],
                   'tags': wanted['tags'], 'userData': 'SECRET_CANARY'}
            raw.setdefault('properties', {}).update(provisioningState='Succeeded', secret='SECRET_CANARY')
            raw['properties']['principalId'] = PRINCIPALS['web' if '"web"' in address else 'api']
            argv = spec['commands'][address]['argv']
            projected = jmespath.search(argv[argv.index('--query') + 1], raw)
            self.assertEqual(projected['body'], wanted['body'])
            self.assertNotIn('SECRET_CANARY', str(projected))

    def test_three_subnet_query_preserves_empty_collections_counts_and_no_user_data(self):
        raw = {'id': 'synthetic-vnet', 'location': 'swedencentral', 'properties': {
            'addressSpace': {'addressPrefixes': ['10.80.0.0/16']}, 'subnets': [{
                'id': 'synthetic-apps', 'properties': {'addressPrefix': '10.80.2.0/23',
                'delegations': [{'properties': {'serviceName': 'Microsoft.App/environments'}}],
                'serviceAssociationLinks': [{'id': 'occupied'}]}}], 'userData': 'SECRET_CANARY'}}
        argv = discovery_manifest(request())['commands']['network']['argv']
        projected = jmespath.search(argv[argv.index('--query') + 1], raw)
        self.assertEqual(projected['dns_servers'], [])
        self.assertEqual(projected['peerings'], [])
        self.assertEqual(projected['subnets'][0]['association_count'], 1)
        self.assertEqual(projected['subnets'][0]['ip_configuration_count'], 0)
        self.assertEqual(projected['subnets'][0]['delegations'], ['Microsoft.App/environments'])
        self.assertEqual(projected['subnets'][0]['prefixes'], [])
        self.assertNotIn('SECRET_CANARY', str(projected))
