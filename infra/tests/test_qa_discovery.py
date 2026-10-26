"""Projection provenance structure, pagination, redaction and r02 network negatives."""
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from qa_discovery import digest, manifest, next_command, timestamp, verify_bundle
from qa_discovery_commands import zone_ids
from qa_network import check_network, compare_protected
from qa_preflight_fixtures import STAMP, TENANT, bundle, discovery_data, request, make_bundle


class Discovery(unittest.TestCase):
    def test_complete_synthetic_projection(self):
        data = verify_bundle(request(), bundle(), now=timestamp(STAMP))
        self.assertEqual(check_network(data, TENANT)['subnet_count'], 3)

    def test_multiple_dns_zone_group_prefixes_preserve_manifest_order(self):
        req, data = request(), discovery_data()
        req['dns_zones'] = [dict(group='a-b', name='two.internal'), dict(group='a', name='one.internal')]
        for index, identity in enumerate(zone_ids(req)):
            data['zones'].append(dict(id=identity, location='global'))
            data['resources'].append(dict(id=identity, type='Microsoft.Network/privateDnsZones', location='global'))
            data['dns_links_' + str(index)] = [dict(id=identity + '/virtualNetworkLinks/test', vnet_id=data['network']['id'], registration=False)]
            data['dns_a_' + str(index)] = []
        verify_bundle(req, make_bundle(req, data), now=timestamp(STAMP))

    def test_manifest_is_fixed_read_only_and_login_only(self):
        for key, command in manifest(request())['commands'].items():
            argv = command['argv']
            self.assertEqual(argv[0], 'az')
            self.assertTrue(argv[1:4] == ['rest', '--method', 'GET'] or argv[1:3] == ['account', 'show'] or argv[1:4] == ['storage', 'blob', 'list'])
            self.assertFalse(set(argv) & {'--account-key', '--sas-token', '--connection-string', '--body', '--debug'})
            if key.startswith('blobs_'):
                self.assertEqual(argv[argv.index('--auth-mode') + 1], 'login')
                self.assertEqual(argv[argv.index('--num-results') + 1], '*')

    def test_missing_duplicate_failed_truncated_hash_or_future_records(self):
        for attack in ('missing', 'duplicate', 'failed', 'partial', 'hash', 'source', 'manifest', 'future', 'extra-field'):
            value = bundle()
            if attack == 'missing': value['records'].pop()
            elif attack == 'duplicate': value['records'].append(deepcopy(value['records'][0]))
            elif attack == 'failed': value['records'][0]['pages'][0]['exit_code'] = 1
            elif attack == 'partial': value['records'][0]['complete'] = False
            elif attack == 'hash': value['records'][0]['pages'][0]['result_sha256'] = '0' * 64
            elif attack == 'source': value['source_sha'] = 'b' * 40
            elif attack == 'manifest': value['manifest_sha256'] = 'b' * 64
            elif attack == 'future': value['completed_at'] = '2026-10-26T12:00:01Z'
            else: value['credential'] = 'SECRET_CANARY'
            with self.subTest(attack=attack), self.assertRaises(Exception): verify_bundle(request(), value, now=timestamp(STAMP))
        with self.assertRaises(Exception): verify_bundle(request(), bundle(), now=timestamp(STAMP) + timedelta(hours=2))

    def test_deep_unprojected_field_rejected_even_with_recomputed_hash(self):
        value = bundle()
        page = next(r for r in value['records'] if r['key'] == 'host')['pages'][0]
        page['result']['userData'] = 'SECRET_CANARY'
        page['result_sha256'] = digest(page['result'])
        with self.assertRaises(Exception): verify_bundle(request(), value, now=timestamp(STAMP))

    def test_arm_pagination_chain_and_origin(self):
        value = bundle(); spec = manifest(request())['commands']['resources']
        record = next(r for r in value['records'] if r['key'] == 'resources')
        page = record['pages'][0]; second = deepcopy(page)
        link = spec['argv'][spec['argv'].index('--url') + 1] + '&$skiptoken=synthetic'
        page['result'] = {'items': [], 'next_link': link}; page['result_sha256'] = digest(page['result'])
        second['argv_sha256'] = digest(next_command(spec, link)); record['pages'].append(second)
        verify_bundle(request(), value, now=timestamp(STAMP))
        for bad in (link.replace('management.azure.com', 'evil.example'), link + '&$filter=hidden', link.replace('/resources?', '/secrets?')):
            with self.assertRaises(Exception): next_command(spec, bad)
        record['pages'].pop()
        with self.assertRaises(Exception): verify_bundle(request(), value, now=timestamp(STAMP))

    def test_network_rejects_old_missing_extra_subnet_occupancy_and_environment(self):
        for attack in ('old-ip', 'missing', 'extra', 'duplicate', 'delegation', 'occupied', 'bool-count', 'same-subnet-env', 'foreign-region', 'tenant'):
            data = discovery_data(); subnets = data['network']['subnets']
            if attack == 'old-ip': data['nic']['ip_configurations'][0]['private_ip'] = '10.80.0.4'
            elif attack == 'missing': subnets.pop()
            elif attack == 'extra': subnets.append(deepcopy(subnets[0]))
            elif attack == 'duplicate': subnets[1]['id'] = subnets[0]['id']
            elif attack == 'delegation': subnets[2]['delegations'] = []
            elif attack == 'occupied': subnets[2]['association_count'] = 1
            elif attack == 'bool-count': subnets[2]['ip_configuration_count'] = False
            elif attack == 'same-subnet-env': data['environments'] = [dict(id=data['host']['id'] + '-env', location='germanywestcentral', subnet_id=subnets[2]['id'].upper())]
            elif attack == 'foreign-region': data['host']['location'] = 'germanywestcentral'
            else: data['account']['tenant_id'] = 'foreign'
            with self.subTest(attack=attack), self.assertRaises(Exception): check_network(data, TENANT)

    def test_protected_comparison_only_allows_app_occupancy_and_new_app_keys(self):
        before = discovery_data(); after = deepcopy(before)
        after['network']['subnets'][2]['association_count'] = 1
        self.assertEqual(compare_protected(before, after)['association_count'], 1)
        for mutate in ('nsg', 'vm', 'route', 'old-state'):
            changed = deepcopy(after)
            if mutate == 'nsg': changed['nsgs'][0]['rules'] = [{}]
            elif mutate == 'vm': changed['host']['vm_id'] = 'foreign'
            elif mutate == 'route': changed['network']['subnets'][1]['route_table_id'] = 'foreign'
            else: changed['blobs_foundation'][0]['etag'] = 'changed'
            with self.subTest(mutate=mutate), self.assertRaises(Exception): compare_protected(before, changed)
