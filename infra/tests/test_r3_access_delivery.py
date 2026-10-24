"""Offline protocol/state/fault tests. No token discovery, cloud or SSH execution."""
import base64
import copy
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_access_repair_contract as contract
import r3_access_repair_control as control
import r3_access_repair_custody as custody
import r3_access_repair_packet as packet
import r3_access_repair_transport as transport
from r3_access_repair import sha256, public_line
from r3_noble_common import encoded
from test_r3_access_repair import proposal, KEY, HASH


class FakeAdapter:
    def __init__(self, identity, responses):
        self.identity, self.responses, self.calls = identity, list(responses), []
    def request_once(self, method, url, body=None, headers=None):
        self.calls.append((method, url, body, headers))
        value = self.responses.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


def response(body=None, status=200, etag=None):
    return {'status': status, 'body': body, 'etag': etag}


class Delivery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.root.chmod(0o700)
        self.item = proposal()
        self.requests = contract.requests(self.item, b'print("synthetic")\n')
        self.client = {'kind': 'SYNTHETIC'}
        disks = [{'lun': lun, 'id': 'synthetic-' + str(lun), 'size_gb': size, 'sku': 'StandardSSD_LRS'}
                 for lun, size in ((None, 32), (0, 64), (1, 32))]
        self.plan = {'client': self.client, 'requests': self.requests, 'custody': None, 'target': {
            'imds': self.item['target_imds'], 'control_plane': {'disks': disks,
             'image': {k: self.item['target_imds'][k] for k in ('publisher', 'offer', 'sku', 'version')},
             'network': {'nic_id': 'synthetic-nic'}}}}
        def disk_model(d):
            return {'managedDisk': {'id': d['id'], 'storageAccountType': d['sku']}, 'diskSizeGB': d['size_gb'], 'lun': d['lun']}
        self.vm = {'id': self.item['target_imds']['resourceId'], 'properties': {
            'vmId': self.item['target_imds']['vmId'], 'osProfile': {'allowExtensionOperations': True},
            'storageProfile': {'imageReference': self.plan['target']['control_plane']['image'],
                              'osDisk': disk_model(disks[0]), 'dataDisks': [disk_model(d) for d in disks[1:]]},
            'networkProfile': {'networkInterfaces': [{'id': 'synthetic-nic'}]}, 'provisioningState': 'Succeeded'},
            'location': self.item['target_imds']['location']}
        self.fresh = {'vm_model_sha256': sha256(encoded(self.vm)), 'vm_etag': '"synthetic"',
                      'observed_at': datetime.now(timezone.utc).isoformat()}
        contract.durable(self.root / 'delivery.json', self.plan)

    def perform(self, responses, phase='repair'):
        adapter = FakeAdapter(self.client, responses)
        with patch.object(control, 'probe'), patch.object(control, 'seal', return_value={'sealed': True}):
            result = control.perform(self.root, self.plan, self.item, self.fresh, phase, 'a' * 64, adapter, sleep=lambda _: None)
        return result, adapter

    def before(self):
        return [response(self.vm, etag=self.fresh['vm_etag']), response({'value': []}),
                response({'value': []}), response(status=404)]

    def summary(self):
        from test_r3_access_custody import fixture
        return fixture()[2]

    def command(self, summary=None, state='Succeeded', code=0):
        value = copy.deepcopy(self.requests['repair_body'])
        value['id'] = self.vm['id'] + '/runCommands/r3-key-' + self.item['packet_id']
        value['properties']['instanceView'] = {'executionState': state, 'exitCode': code,
                                                'output': json.dumps(summary or self.summary()), 'error': ''}
        return value

    def test_exact_script_and_empty_optional_destinations(self):
        props = self.requests['repair_body']['properties']
        self.assertFalse(props['asyncExecution'])
        self.assertTrue(props['treatFailureAsDeploymentFailure'])
        self.assertEqual(props['timeoutInSeconds'], 60)
        self.assertNotIn('runAsPassword', props)
        self.assertNotIn('outputBlobUri', props)
        self.assertIn('exec /usr/bin/python3 -I -B -', props['source']['script'])
        self.assertTrue(self.requests['status'].endswith('&$expand=instanceView'))

    def test_one_put_after_durable_consumption_and_no_replay(self):
        result, adapter = self.perform(self.before() + [response(status=201), response(self.command())])
        self.assertEqual(result['status'], 'KEY_APPENDED_CUSTODY_REQUIRED')
        self.assertEqual([x[0] for x in adapter.calls].count('PUT'), 1)
        self.assertTrue((self.root / 'repair-consumed.json').exists())
        with self.assertRaises(FileExistsError):
            self.perform([])
        self.assertFalse(result['remote_exit_proven'])

    def test_ambiguous_put_consumes_without_retry(self):
        result, adapter = self.perform(self.before() + [TimeoutError('not retained')])
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(result['failure'], 'TimeoutError')
        self.assertEqual([x[0] for x in adapter.calls].count('PUT'), 1)
        self.assertTrue((self.root / 'repair-capture/05-intent.json').exists())
        self.assertFalse((self.root / 'repair-capture/05-response.json').exists())

    def test_changed_model_and_existing_command_prevent_put(self):
        for name, values in [('model', [response({}, etag='"synthetic"')]),
                             ('occupied', self.before()[:-1] + [response({})])]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                old = self.root
                self.root = Path(tmp).resolve();self.root.chmod(0o700)
                contract.durable(self.root / 'delivery.json', self.plan)
                result, adapter = self.perform(values)
                self.root = old
                self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
                self.assertNotIn('PUT', [x[0] for x in adapter.calls])

    def test_status_never_uses_provisioning_success_as_execution_success(self):
        for state, code in [('Failed', 0), ('TimedOut', 0), ('Succeeded', 1)]:
            with self.subTest(state=state, code=code), self.assertRaises(ValueError):
                control.completed_command(self.command(state=state, code=code), self.plan, self.item)
        self.assertIsNone(control.completed_command(self.command(state='Running'), self.plan, self.item))
        changed = self.command();changed['properties']['source']['script'] += '# changed'
        with self.assertRaisesRegex(ValueError, 'COMMAND_SOURCE'):
            control.completed_command(changed, self.plan, self.item)

    def test_summary_wrong_phase_packet_key_types_and_hash_refused(self):
        for field, value in [('phase', 'validate'), ('evidence_path', '/var/lib/other'),
                             ('pre_close_result_sha256', 'z' * 64)]:
            summary = self.summary();summary[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                control.completed_command(self.command(summary), self.plan, self.item)
        for field, value in [('public_key_sha256', '0' * 64), ('before_bytes', True),
                             ('after_bytes', 0), ('uid', 0), ('mode', 0o666)]:
            summary = self.summary();summary['append'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                control.completed_command(self.command(summary), self.plan, self.item)

    def test_signal_after_mutation_retains_and_seals_without_poll_or_replay(self):
        interrupted = []
        class InterruptedAdapter(FakeAdapter):
            def request_once(self, method, *args):
                value = super().request_once(method, *args)
                if method == 'PUT':interrupted.append('SIGTERM')
                return value
        adapter = InterruptedAdapter(self.client, self.before() + [response(status=201)])
        with patch.object(control, 'probe'), patch.object(control, 'seal', return_value={'sealed': True}) as sealing:
            result = control.perform(self.root, self.plan, self.item, self.fresh, 'repair', 'a' * 64,
                                     adapter, sleep=lambda _: None, interrupted=interrupted)
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(result['interruption'], 'SIGTERM')
        self.assertEqual(sealing.call_count, 1)
        self.assertEqual(len(adapter.calls), 5)
        self.assertTrue((self.root / 'repair-capture/result.json').exists())

    def test_public_execute_captures_real_sigterm_after_one_put(self):
        class SignalAdapter(FakeAdapter):
            def request_once(self, method, *args):
                value = super().request_once(method, *args)
                if method == 'PUT': os.kill(os.getpid(), signal.SIGTERM)
                return value
        adapter = SignalAdapter(self.client, self.before() + [response(status=201)])
        with patch.object(control, 'approve', return_value=(self.plan, self.item, self.fresh)), \
             patch.object(control, 'ArmBearerClient', return_value=adapter), \
             patch.object(control, 'probe'), patch.object(control, 'seal', return_value={'sealed': True}) as sealing:
            result = control.execute(self.root, b'{}', 'a' * 64, b'{}', 'repair')
        self.assertEqual(result['interruption'], 'SIGTERM')
        self.assertEqual(len(adapter.calls), 5)
        self.assertEqual(sealing.call_count, 1)
        self.assertTrue((self.root / 'repair-summary.json').exists())

    def test_poll_budget_and_refused_partial_summary(self):
        result, adapter = self.perform(self.before() + [response(status=201)] + [response(self.command(state='Running'))] * 6)
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(len(adapter.calls), 11)
        partial = self.summary();partial['cleanup_errors'] = ['OSError']
        with self.assertRaises(ValueError):
            control.completed_command(self.command(partial), self.plan, self.item)

    def test_enable_patch_only_and_refuse_unrelated_change(self):
        self.vm['properties']['osProfile']['allowExtensionOperations'] = False
        self.fresh['vm_model_sha256'] = sha256(encoded(self.vm))
        after = copy.deepcopy(self.vm);after['properties']['osProfile']['allowExtensionOperations'] = True
        result, adapter = self.perform(self.before()[:3] + [response({}), response(after)], 'enable')
        self.assertEqual(result['status'], 'EXTENSIONS_ENABLED_REVIEW_REQUIRED')
        mutation = [x for x in adapter.calls if x[0] == 'PATCH']
        self.assertEqual(len(mutation), 1)
        self.assertEqual(mutation[0][3], {'If-Match': '"synthetic"'})
        after['properties']['storageProfile'] = {}
        self.assertNotEqual(control.model_without_transition(after), control.model_without_transition(self.vm))

    def test_durable_record_and_strict_json(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'{"a":1e400}'):
            with self.assertRaises(ValueError): contract.load(raw)
        with self.assertRaises(FileExistsError): contract.durable(self.root / 'delivery.json', {})
        self.assertEqual((self.root / 'delivery.json').stat().st_mode & 0o777, 0o600)

    def test_freshness_refuses_stale_future_and_naive(self):
        now = datetime.now(timezone.utc)
        for dt in (now - timedelta(seconds=901), now + timedelta(seconds=1), now.replace(tzinfo=None)):
            with self.assertRaises(ValueError): contract.freshness({'observed_at': dt.isoformat()}, now)
        contract.freshness({'observed_at': now.isoformat()}, now)

    def test_unpublished_packet_refuses_before_any_transport(self):
        supplied = self.root / 'retained.json';supplied.write_bytes(encoded({'target': {'imds': self.item['target_imds']}}))
        pub = self.root / 'identity.pub';pub.write_bytes(KEY)
        dest = self.root / 'packet'
        with patch.object(packet, 'verified_head', side_effect=ValueError('unpublished')):
            packet.prepare(dest, supplied, pub, HASH)
        approval = encoded({})
        with patch.object(transport.urllib.request, 'build_opener', side_effect=AssertionError('network')):
            with self.assertRaisesRegex(ValueError, 'UNPUBLISHED_SOURCE'):
                control.execute(dest, approval, sha256(approval), b'{}', 'repair')
        self.assertFalse((dest / 'repair-consumed.json').exists())


class ApprovalContract(unittest.TestCase):
    def setUp(self):
        from test_r3_access_repair import WIRE
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.root.chmod(0o700)
        self.item = proposal(); imds = self.item['target_imds']
        cp = {'tenant': '0' * 36, 'subscription': imds['subscriptionId'], 'vm_id': imds['resourceId'],
              'vm_uuid': imds['vmId'], 'location': imds['location'],
              'image': {k: imds[k] for k in ('publisher', 'offer', 'sku', 'version')},
              'disks': [{'lun': None}, {'lun': 0}, {'lun': 1}], 'public_ip': '192.0.2.1',
              'private_ip': '10.0.0.1', 'network': {'nic_id': 'synthetic'}}
        cp['image']['exactVersion'] = imds['version']
        target = {'imds': imds, 'connection': {'host': cp['public_ip'], 'user': 'tonyaiops'}, 'control_plane': cp}
        values = {'ssh_public_key': KEY, 'known_hosts': b'192.0.2.1 ssh-ed25519 ' + base64.b64encode(WIRE) + b'\n',
                  'age': b'synthetic executable; never run'}
        recipient = b' '.join(KEY.split()[:2]).decode()
        custody = {'recipient': recipient, 'recipient_sha256': sha256((recipient + '\n').encode())}
        for name, value in values.items():
            path = self.root / name; path.write_bytes(value); path.chmod(0o700 if name == 'age' else 0o600)
            custody[name] = str(path); custody[name + '_sha256'] = sha256(value)
        retained = self.root / 'retained.json'; retained.write_bytes(encoded({'target': target, 'custody': custody}))
        self.dest = self.root / 'packet'
        self.client = {'kind': 'OWNER_ARM_BEARER_FILE', 'tenant': cp['tenant'], 'principal': '1' * 36,
                       'credential_path': str(self.root / 'nonexistent-token')}
        with patch.object(packet, 'verified_head', return_value='c' * 40):
            packet.prepare(self.dest, retained, self.root / 'ssh_public_key', HASH,
                {'published_sha': 'c' * 40, 'client': self.client,
                 'handler_trust': 'MICROSOFT_MANAGED_ACCEPTED_BY_OWNER', 'design_decision_sha256': 'd' * 64})
        self.fresh = {'observed_at': datetime.now(timezone.utc).isoformat(), 'target': target,
            'client': self.client, 'exclusive_operator_window': True, 'vm_etag': '"synthetic"',
            'vm_model_sha256': 'e' * 64, 'extensions': [], 'run_commands': [], 'allow_extension_operations': True}

    def check(self, change=None):
        fresh = copy.deepcopy(self.fresh)
        approval = {'action': contract.ACTIONS['repair'], 'packet_path': str(self.dest),
                    'delivery_sha256': sha256((self.dest / 'delivery.json').read_bytes()),
                    'fresh_sha256': sha256(encoded(fresh)), 'attempts': 1,
                    'owner_authorization_reference': 'SYNTHETIC TEST ONLY'}
        if change: change(approval, fresh)
        raw = encoded(approval)
        with patch('r3_policy_git.verified_head', return_value='c' * 40):
            return contract.approve(self.dest, raw, sha256(raw), encoded(fresh), 'repair')

    def test_all_local_bindings_accept_without_reading_credentials(self):
        plan, item, fresh = self.check()
        self.assertEqual(plan['client'], self.client)
        self.assertEqual(item['public_key_sha256'], HASH)
        self.assertFalse(Path(self.client['credential_path']).exists())

    def test_exact_approval_freshness_source_and_custody_changes_refuse(self):
        for key, value in [('attempts', 2), ('action', contract.ACTIONS['enable']),
                           ('packet_path', str(self.dest) + '/.'), ('delivery_sha256', '0' * 64)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.check(lambda a, f: a.update({key: value}))
        with self.assertRaises(ValueError):
            self.check(lambda a, f: f.update(exclusive_operator_window=False))
        key = self.root / 'ssh_public_key'; key.write_bytes(KEY + b'changed')
        with self.assertRaisesRegex(ValueError, 'CUSTODY_HASH'): self.check()
        key.write_bytes(KEY)
        guest = self.dest / 'guest.py'; guest.write_bytes(guest.read_bytes() + b'# changed')
        with self.assertRaisesRegex(ValueError, 'PAYLOAD_BINDING'): self.check()


class Transport(unittest.TestCase):
    def test_redirect_is_refused_and_no_proxy_adapter(self):
        with self.assertRaisesRegex(ValueError, 'REDIRECT_REFUSED'):
            transport.NoRedirect().redirect_request(None, None, 302, None, {}, 'https://evil.invalid/')
        binding = {'kind': 'OWNER_ARM_BEARER_FILE', 'tenant': '0' * 36, 'principal': '1' * 36,
                   'credential_path': '/never-read-token'}
        client = transport.ArmBearerClient(binding)
        with patch.object(client, 'token', side_effect=AssertionError('credential')):
            with self.assertRaises(ValueError):client.request_once('GET', 'https://evil.invalid/')
            with self.assertRaises(ValueError):client.request_once('DELETE', 'https://management.azure.com/subscriptions/x')

    def test_http_error_body_never_read_and_no_retry(self):
        client = transport.ArmBearerClient({'kind': 'OWNER_ARM_BEARER_FILE', 'tenant': '0' * 36,
                    'principal': '1' * 36, 'credential_path': '/never-read-token'})
        from urllib.error import HTTPError
        error = HTTPError('https://management.azure.com/', 429, 'secret diagnostic', {}, io.BytesIO(b'secret'))
        with patch.object(client, 'token', return_value='synthetic'), \
             patch.object(transport.urllib.request, 'build_opener') as make:
            make.return_value.open.side_effect = error
            result = client.request_once('GET', 'https://management.azure.com/subscriptions/x')
        self.assertEqual(result, {'status': 429, 'etag': None, 'body': None})
        self.assertEqual(make.return_value.open.call_count, 1)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))


if __name__ == '__main__':
    unittest.main()
