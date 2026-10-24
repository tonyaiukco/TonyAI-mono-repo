"""Offline identity diagnosis: no Azure, SSH, IMDS or guest mutation."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_access_identity_diagnostic as diagnostic
import r3_access_repair_guest as guest
import r3_access_repair_packet as packet
import r3_access_repair_contract as contract
import r3_access_repair_control as control
import r3_policy_target as target
from r3_noble_common import encoded, digest
from test_r3_access_repair import proposal, HASH
import test_r3_access_delivery as delivery_tests
from test_r3_access_delivery import FakeAdapter, response

BOOT = '00000000-0000-0000-0000-000000000001'


def diagnostic_proposal():
    value = proposal()
    value['purpose'] = diagnostic.PURPOSE
    return value


def report(item, values=None, fail_at=None, failure=None):
    values = item['target_imds'] if values is None else values
    def observed(observer):
        for stage, value in [('imds-request', None), ('imds-size', {'bytes': 2048}),
                             ('imds-json', None), ('imds-fields', values), ('boot-parent', None),
                             ('boot-open', None), ('boot-read', None), ('boot-format', {'boot_id': BOOT}),
                             ('complete', None)]:
            observer(stage, value)
            if stage == fail_at:
                raise failure or ValueError('sensitive exception text must not escape')
        return {'imds': values, 'boot_id': BOOT}
    with patch.object(diagnostic.sys, 'platform', 'linux'), patch.object(diagnostic.sys, 'dont_write_bytecode', True), \
         patch.object(diagnostic.os, 'geteuid', return_value=0), patch.object(diagnostic.signal, 'getitimer', return_value=(0.0, 0.0)), \
         patch.object(diagnostic.signal, 'signal'), patch.object(diagnostic.signal, 'alarm'), \
         patch.object(diagnostic, 'identity', side_effect=observed):
        return diagnostic.main(item)


class IdentityReport(unittest.TestCase):
    def test_exact_identity_is_diagnostic_only_and_case_difference_stays_mismatch(self):
        item = diagnostic_proposal()
        result = report(item)
        self.assertTrue(result['identity_matches_expected'])
        self.assertFalse(result['access_verified'])
        self.assertFalse(result['qualification'])
        self.assertFalse(result['installation_success'])
        changed = dict(item['target_imds']); changed['location'] = 'SwedenCentral'
        result = report(item, changed)
        self.assertFalse(result['identity_matches_expected'])
        self.assertTrue(result['field_observations']['location']['case_only_difference'])
        self.assertEqual(result['field_observations']['location']['value'], 'SwedenCentral')

    def test_failure_stage_retained_without_exception_text(self):
        for stage in diagnostic.STAGES[1:-1]:
            with self.subTest(stage=stage):
                result = report(diagnostic_proposal(), fail_at=stage)
                self.assertEqual(result['stage'], stage)
                self.assertEqual(result['error'], {'type': 'ValueError', 'errno': None})
                self.assertIsNone(result['identity_matches_expected'])
                self.assertNotIn(b'sensitive', encoded(result))
        for exc, kind, number in [(TimeoutError('private'), 'TimeoutError', None),
                                  (guest.Deadline(), 'TimeoutError', None),
                                  (OSError(40, 'private'), 'OSError', 40),
                                  (UnicodeError('private'), 'UnicodeError', None)]:
            value = report(diagnostic_proposal(), fail_at='boot-read', failure=exc)
            self.assertEqual(value['error'], {'type': kind, 'errno': number})

    def test_field_types_large_strings_utf8_and_total_output_bounds(self):
        cases = [(None, 'null'), (True, 'bool'), (3, 'number'), ({'secret': 'hidden'}, 'object'),
                 (['hidden'], 'array'), ('x' * 2049, 'oversize-string'), ('\ud800', 'invalid-utf8')]
        for value, kind in cases:
            with self.subTest(kind=kind):
                item = diagnostic_proposal(); values = dict(item['target_imds']); values['location'] = value
                result = report(item, values, fail_at='imds-fields')
                self.assertEqual(result['field_observations']['location']['kind'], kind)
                self.assertNotIn(b'hidden', encoded(result))
        item = diagnostic_proposal()
        for chars in ('x', '\u20ac', '\U0001f600', '\\', '\n'):
            for count in (0, 16, 128, 1024, 2048):
                values = {key: chars * count for key in target.IMDS_FIELDS}
                result = report(item, values, fail_at='imds-fields')
                self.assertLessEqual(len(encoded(result)), 4096)
                self.assertLessEqual(sum(len(encoded(x['value'])) for x in result['field_observations'].values()
                                         if x['value'] is not None), 1024)

    def test_report_binding_flags_and_field_forgery_refused(self):
        item = diagnostic_proposal(); good = report(item)
        changes = [('purpose', guest.__name__), ('source_sha', 'f' * 40), ('packet_id', 'f' * 32),
                   ('format', True), ('stage', 'imds-json'), ('boot_id', 'z' * 36),
                   ('identity_matches_expected', False), ('imds_response_bytes', True),
                   ('access_verified', True), ('qualification', True), ('installation_success', True)]
        for key, value in changes:
            changed = copy.deepcopy(good); changed[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): diagnostic.validate_report(changed, item)
        for key, value in [('sha256', 'a' * 64), ('exact_match', False), ('characters', True),
                           ('value', 'forged'), ('case_only_difference', True)]:
            changed = copy.deepcopy(good); changed['field_observations']['location'][key] = value
            with self.subTest(field=key), self.assertRaises(ValueError): diagnostic.validate_report(changed, item)


    def test_impossible_error_free_observations_refused(self):
        item = diagnostic_proposal()
        for actual in (None, '', 'x' * 2049):
            changed = report(item)
            changed['field_observations']['location'] = diagnostic.field(actual, item['target_imds']['location'], [1024])
            changed['identity_matches_expected'] = False
            with self.subTest(actual=type(actual).__name__), self.assertRaises(ValueError):
                diagnostic.validate_report(changed, item)
        for count in (None, 0, 32769):
            changed = report(item); changed['imds_response_bytes'] = count
            with self.subTest(count=count), self.assertRaises(ValueError): diagnostic.validate_report(changed, item)

    def test_timer_armed_once_and_cleared_after_timeout(self):
        with patch.object(diagnostic.sys, 'platform', 'linux'), patch.object(diagnostic.sys, 'dont_write_bytecode', True), \
             patch.object(diagnostic.os, 'geteuid', return_value=0), patch.object(diagnostic.signal, 'getitimer', return_value=(0.0, 0.0)), \
             patch.object(diagnostic.signal, 'signal'), patch.object(diagnostic.signal, 'alarm') as alarm, \
             patch.object(diagnostic, 'identity', side_effect=guest.Deadline()):
            result = diagnostic.main(diagnostic_proposal())
        self.assertEqual([x.args for x in alarm.call_args_list], [(30,), (0,)])
        self.assertEqual(result['error']['type'], 'TimeoutError')

    def test_cross_purpose_and_runtime_refuse_before_identity(self):
        with patch.object(diagnostic, 'identity', side_effect=AssertionError('identity called')):
            with self.assertRaises(ValueError): diagnostic.main(proposal())
            with patch.object(diagnostic.sys, 'platform', 'darwin'), self.assertRaisesRegex(ValueError, 'GUEST_RUNTIME'):
                diagnostic.main(diagnostic_proposal())
        with self.assertRaisesRegex(ValueError, 'PURPOSE'): guest.validate(diagnostic_proposal())

    def test_no_append_account_or_file_write_on_diagnostic_path(self):
        with patch.object(guest, 'main', side_effect=AssertionError('repair')), \
             patch.object(guest, 'append_verified', side_effect=AssertionError('append')), \
             patch.object(guest, 'account', side_effect=AssertionError('account')), \
             patch.object(guest, 'private_record', side_effect=AssertionError('write')):
            self.assertTrue(report(diagnostic_proposal())['identity_matches_expected'])
        payload = packet.diagnostic_payload(diagnostic_proposal())
        self.assertIn(b'from r3_access_identity_diagnostic import main\n', payload)
        self.assertNotIn(b'from r3_access_repair_guest import main\n', payload)
        compile(payload, '<synthetic-diagnostic>', 'exec')

    def test_shared_identity_observer_keeps_one_request_two_closes_and_exact_result(self):
        item = diagnostic_proposal(); checkpoints = []
        raw = json.dumps({**item['target_imds'], 'unrelatedSecret': 'never observed'}).encode()
        reply = MagicMock(); reply.__enter__.return_value.read.return_value = raw
        opener = MagicMock(); opener.open.return_value = reply
        def observe(stage, value): checkpoints.append((stage, value))
        with patch.object(target, 'build_opener', return_value=opener), patch.object(target, 'directory', return_value=10), \
             patch.object(target.os, 'open', return_value=11), patch.object(target.os, 'read', return_value=(BOOT + '\n').encode()), \
             patch.object(target.os, 'close') as close:
            actual = target.identity(observe)
        self.assertEqual(actual, {'imds': item['target_imds'], 'boot_id': BOOT})
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(close.call_args_list[0].args, (11,))
        self.assertEqual(close.call_args_list[1].args, (10,))
        self.assertNotIn('unrelatedSecret', repr(checkpoints))
        self.assertEqual([x[0] for x in checkpoints], list(diagnostic.STAGES[1:-1]))


class DiagnosticDelivery(unittest.TestCase):
    def setUp(self):
        self.fx = delivery_tests.Delivery(); self.fx.setUp(); self.addCleanup(self.fx.doCleanups)
        fx = self.fx
        old_body = copy.deepcopy(fx.requests['repair_body'])
        old_id = fx.vm['id'] + '/runCommands/r3-key-' + '9' * 32
        fx.item['purpose'] = diagnostic.PURPOSE
        fx.requests = contract.requests(fx.item, b'print("synthetic diagnostic")\n')
        fx.plan['requests'] = fx.requests
        fx.plan['prior_command'] = {'id': old_id, 'source_sha': 'c' * 40, 'delivery_sha256': 'd' * 64,
                                    'request_body': old_body, 'execution_state': 'Failed', 'exit_code': 2}
        self.prior = {**copy.deepcopy(old_body), 'id': old_id}
        self.prior['location'] = 'SwedenCentral'
        self.prior['properties'].update(provisioningState='Failed', instanceView={'executionState': 'Failed', 'exitCode': 2})
        self.extensions = {'value': []}; self.commands = {'value': [{'id': old_id}]}
        fx.fresh.update(extensions=[], run_commands=[old_id], extensions_model_sha256=digest(encoded(self.extensions)),
                        commands_model_sha256=digest(encoded(self.commands)), prior_command_model_sha256=digest(encoded(self.prior)))

    def before(self):
        return [response(self.fx.vm, etag=self.fx.fresh['vm_etag']), response(self.extensions),
                response(self.commands), response(self.prior), response(status=404)]

    def command(self, state='Succeeded', value=None):
        body = copy.deepcopy(self.fx.requests['repair_body'])
        body['id'] = self.fx.vm['id'] + '/runCommands/r3-identity-' + self.fx.item['packet_id']
        body['location'] = 'SwedenCentral'
        body['properties']['instanceView'] = {'executionState': state, 'exitCode': 0, 'error': '',
                                              'output': json.dumps(report(self.fx.item) if value is None else value)}
        return body

    def test_diagnostic_one_new_put_no_old_command_update_and_no_replay(self):
        result, adapter = self.fx.perform(self.before() + [response(status=201), response(self.command())], 'diagnose')
        self.assertEqual(result['status'], diagnostic.STATUS)
        self.assertTrue(result['remote_exit_proven'])
        self.assertFalse(result['access_verified'])
        self.assertFalse(result['installation_success'])
        self.assertEqual([x[0] for x in adapter.calls], ['GET'] * 5 + ['PUT', 'GET'])
        self.assertIn('/r3-identity-', adapter.calls[5][1])
        self.assertNotIn('/r3-key-', adapter.calls[5][1])
        with self.assertRaises(FileExistsError): self.fx.perform([], 'diagnose')

    def test_old_model_drift_running_or_wrong_code_refuses_before_put(self):
        for name in ('hash', 'state', 'code', 'provision', 'script', 'option'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                old_root = self.fx.root; self.fx.root = Path(tmp).resolve(); self.fx.root.chmod(0o700)
                contract.durable(self.fx.root / 'delivery.json', self.fx.plan)
                changed = copy.deepcopy(self.prior)
                if name == 'hash': changed['extra'] = True
                elif name == 'state': changed['properties']['instanceView']['executionState'] = 'Running'
                elif name == 'code': changed['properties']['instanceView']['exitCode'] = True
                elif name == 'provision': changed['properties']['provisioningState'] = 'Updating'
                elif name == 'script': changed['properties']['source']['script'] += '#different'
                else: changed['properties']['runAsUser'] = 'root'
                original_hash = self.fx.fresh['prior_command_model_sha256']
                if name != 'hash': self.fx.fresh['prior_command_model_sha256'] = digest(encoded(changed))
                result, adapter = self.fx.perform(self.before()[:3] + [response(changed)] +
                    self.before()[4:] + [response(status=201), response(self.command())], 'diagnose')
                self.fx.fresh['prior_command_model_sha256'] = original_hash; self.fx.root = old_root
                self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
                self.assertNotIn('PUT', [x[0] for x in adapter.calls])

    def test_changed_lists_or_occupied_new_name_refuse_before_put(self):
        cases = [self.before()[:1] + [response({'value': [{'id': 'unknown'}]})],
                 self.before()[:2] + [response({'value': [{'id': 'unknown'}]})],
                 self.before()[:4] + [response({})]]
        for responses in cases:
            with tempfile.TemporaryDirectory() as tmp:
                old_root = self.fx.root; self.fx.root = Path(tmp).resolve(); self.fx.root.chmod(0o700)
                contract.durable(self.fx.root / 'delivery.json', self.fx.plan)
                result, adapter = self.fx.perform(responses, 'diagnose'); self.fx.root = old_root
                self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
                self.assertNotIn('PUT', [x[0] for x in adapter.calls])

    def test_poll_budget_is_twelve_and_ambiguous_put_not_retried(self):
        result, adapter = self.fx.perform(self.before() + [response(status=201)] + [response(self.command('Running'))] * 6, 'diagnose')
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(len(adapter.calls), 12)
        self.assertEqual(sum(x[0] == 'PUT' for x in adapter.calls), 1)

    def test_ambiguous_put_remains_partial(self):
        result, adapter = self.fx.perform(self.before() + [TimeoutError('private')], 'diagnose')
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(len(adapter.calls), 6)
        self.assertEqual(sum(x[0] == 'PUT' for x in adapter.calls), 1)

    def test_signal_after_put_stops_poll_and_seals_once(self):
        interrupted = []
        class Interrupted(FakeAdapter):
            def request_once(self, method, *args):
                result = super().request_once(method, *args)
                if method == 'PUT': interrupted.append('SIGTERM')
                return result
        adapter = Interrupted(self.fx.client, self.before() + [response(status=201)])
        with patch.object(control, 'probe'), patch.object(control, 'seal', return_value={'sealed': True}) as seal:
            result = control.perform(self.fx.root, self.fx.plan, self.fx.item, self.fx.fresh, 'diagnose',
                                     'a' * 64, adapter, sleep=lambda _: None, interrupted=interrupted)
        self.assertEqual(result['interruption'], 'SIGTERM')
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(len(adapter.calls), 6)
        self.assertEqual(seal.call_count, 1)


    def test_custody_failure_cannot_return_accepted_diagnostic(self):
        adapter = FakeAdapter(self.fx.client, self.before() + [response(status=201), response(self.command())])
        with patch.object(control, 'probe'), patch.object(control, 'seal', return_value={'sealed': False}):
            result = control.perform(self.fx.root, self.fx.plan, self.fx.item, self.fx.fresh, 'diagnose',
                                     'a' * 64, adapter, sleep=lambda _: None)
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertTrue((self.fx.root / 'diagnose-consumed.json').exists())

    def test_reported_identity_failure_completes_diagnostic_only(self):
        value = report(self.fx.item, fail_at='imds-json')
        result, _ = self.fx.perform(self.before() + [response(status=201), response(self.command(value=value))], 'diagnose')
        self.assertEqual(result['status'], diagnostic.STATUS)
        self.assertEqual(result['diagnostic_report']['error']['type'], 'ValueError')
        self.assertFalse(result['access_verified'])

    def test_case_only_arm_location_accepts_but_other_changes_refuse(self):
        for value in ('swedencentral', 'SwedenCentral', 'SWEDENCENTRAL'):
            body = self.command(); body['location'] = value
            self.assertIsNotNone(control.completed_diagnostic(body, self.fx.plan, self.fx.item))
        for value in ('westeurope', 'swedencentral ', '\u017fwedencentral', None, 1, 'x' * 65):
            body = self.command(); body['location'] = value
            with self.subTest(location=value), self.assertRaises(ValueError):
                control.completed_diagnostic(body, self.fx.plan, self.fx.item)
        body = self.command(); body['properties']['instanceView'].update(executionState='Failed', exitCode=2)
        with self.assertRaisesRegex(ValueError, 'COMMAND_FAILED'):
            control.completed_diagnostic(body, self.fx.plan, self.fx.item)


class DiagnosticApproval(unittest.TestCase):
    def setUp(self):
        self.fx = delivery_tests.ApprovalContract(); self.fx.setUp(); self.addCleanup(self.fx.doCleanups)
        old = contract.load((self.fx.dest / 'delivery.json').read_bytes())
        old_proposal = contract.load((self.fx.dest / 'proposal.json').read_bytes())
        self.dest = self.fx.root / 'diagnostic-packet'
        self.prior = {'id': old_proposal['target_imds']['resourceId'] + '/runCommands/r3-key-' + old_proposal['packet_id'],
                      'source_sha': 'c' * 40, 'delivery_sha256': digest((self.fx.dest / 'delivery.json').read_bytes()),
                      'request_body': old['requests']['repair_body'], 'execution_state': 'Failed', 'exit_code': 2,
                      'delivery': old, 'proposal': old_proposal}
        with patch.object(packet, 'verified_head', return_value='c' * 40):
            packet.prepare(self.dest, self.fx.root / 'retained.json', self.fx.root / 'ssh_public_key', HASH,
                           {'published_sha': 'c' * 40, 'client': self.fx.client,
                            'handler_trust': 'MICROSOFT_MANAGED_ACCEPTED_BY_OWNER', 'design_decision_sha256': 'd' * 64,
                            'prior_command': self.prior}, identity_diagnostic=True)
        self.fresh = copy.deepcopy(self.fx.fresh)
        self.fresh.update(run_commands=[self.prior['id']], extensions_model_sha256='a' * 64,
                          commands_model_sha256='b' * 64, prior_command_model_sha256='e' * 64)

    def check(self, phase='diagnose', fresh=None, action=None):
        fresh = self.fresh if fresh is None else fresh
        approval = {'action': contract.ACTIONS[phase] if action is None else action, 'packet_path': str(self.dest),
                    'delivery_sha256': digest((self.dest / 'delivery.json').read_bytes()),
                    'fresh_sha256': digest(encoded(fresh)), 'attempts': 1, 'owner_authorization_reference': 'SYNTHETIC TEST ONLY'}
        raw = encoded(approval)
        with patch('r3_policy_git.verified_head', return_value='c' * 40):
            return contract.approve(self.dest, raw, digest(raw), encoded(fresh), phase)

    def test_real_approval_checks_accept_only_diagnostic_action_and_existing_failed_id(self):
        plan, item, _ = self.check()
        self.assertEqual(item['purpose'], diagnostic.PURPOSE)
        self.assertEqual(plan['prior_command'], self.prior)
        self.assertEqual((self.dest / 'export.py').read_bytes(), b'')
        self.assertFalse(Path(self.fx.client['credential_path']).exists())
        for phase in ('repair', 'enable', 'export'):
            with self.subTest(phase=phase), self.assertRaises(ValueError): self.check(phase)
        with self.assertRaises(ValueError): self.check(action=contract.ACTIONS['repair'])

    def test_unknown_delivery_hash_and_prior_options_refuse(self):
        for key, value in [('run_commands', []), ('extensions', ['x'] * 5),
                           ('commands_model_sha256', 'bad'), ('allow_extension_operations', False)]:
            fresh = copy.deepcopy(self.fresh); fresh[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): self.check(fresh=fresh)
        item = contract.load((self.dest / 'proposal.json').read_bytes())
        for key, value in [('id', self.prior['id'] + '/bad'), ('exit_code', True), ('execution_state', 'Running'),
                           ('source_sha', 'bad'), ('delivery_sha256', 'bad')]:
            prior = copy.deepcopy(self.prior); prior[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): contract.validate_prior_command(prior, item)


    def test_prior_provenance_labels_and_embedded_records_must_correspond(self):
        item = contract.load((self.dest / 'proposal.json').read_bytes())
        for name in ('source', 'digest', 'proposal', 'body', 'id'):
            changed = copy.deepcopy(self.prior)
            if name == 'source': changed['source_sha'] = 'f' * 40
            elif name == 'digest': changed['delivery_sha256'] = 'f' * 64
            elif name == 'proposal': changed['proposal']['source']['published_sha'] = 'f' * 40
            elif name == 'body': changed['request_body']['properties']['source']['script'] += '# changed'
            else: changed['id'] = changed['id'][:-32] + 'f' * 32
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'PRIOR_PACKET_BINDING'):
                contract.validate_prior_command(changed, item)


if __name__ == '__main__':
    unittest.main()
