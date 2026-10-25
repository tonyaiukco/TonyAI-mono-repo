"""Offline exact-history recovery amendment; no credentials or target execution."""
import base64
import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_access_repair_amendment as amendment
import r3_access_repair_history as history
import r3_access_repair_packet as packet
import r3_access_repair_contract as contract
import r3_access_repair_control as control
from r3_noble_common import encoded, digest
import test_r3_access_identity_diagnostic as identity_tests
import test_r3_access_delivery as delivery_tests
from test_r3_access_repair import HASH

HISTORICAL_MODULES = tuple(name for name in packet.MODULES if name != 'r3_policy_snap')


def failed_summary():
    return {'status': 'REFUSED_REVIEW_REQUIRED', 'phase': 'identity-before', 'failure': 'ValueError',
            'cleanup_errors': [], 'access_verified': False, 'qualification': False, 'installation_success': False,
            'evidence_path': None, 'pre_close_result_sha256': None,
            'finalization': {'status': 'REFUSED_REVIEW_REQUIRED', 'cleanup_errors': []},
            'identity_stable': False, 'append': None}


class Amendment(unittest.TestCase):
    def setUp(self):
        self.base = delivery_tests.ApprovalContract(); self.base.setUp(); self.addCleanup(self.base.doCleanups)
        self.transport = delivery_tests.Delivery(); self.transport.setUp(); self.addCleanup(self.transport.doCleanups)
        retained = contract.load((self.base.root / 'retained.json').read_bytes())
        cp = retained['target']['control_plane']
        cp['disks'] = self.transport.plan['target']['control_plane']['disks']
        cp['network'] = self.transport.plan['target']['control_plane']['network']
        self.retained = self.base.root / 'complete-retained.json'; self.retained.write_bytes(encoded(retained))
        self.bindings = {'published_sha': 'c' * 40, 'client': self.base.client,
                         'handler_trust': 'MICROSOFT_MANAGED_ACCEPTED_BY_OWNER', 'design_decision_sha256': 'd' * 64}
        self.old_dir = self.base.root / 'old'; self.prepare(self.old_dir, historical=True)
        old, old_proposal = self.read(self.old_dir)
        prior = {'id': old_proposal['target_imds']['resourceId'] + '/runCommands/r3-key-' + old_proposal['packet_id'],
                 'source_sha': 'c' * 40, 'delivery_sha256': digest(encoded(old)), 'request_body': old['requests']['repair_body'],
                 'execution_state': 'Failed', 'exit_code': 2, 'delivery': old, 'proposal': old_proposal}
        self.diag_dir = self.base.root / 'diagnostic'; self.prepare(self.diag_dir, {'prior_command': prior}, historical=True, identity_diagnostic=True)
        diagnostic, dp = self.read(self.diag_dir)
        result = identity_tests.report(dp, dict(dp['target_imds'], location='SwedenCentral'))
        self.amend = {'format': 1, 'purpose': amendment.PURPOSE, 'diagnostic_delivery': diagnostic,
                      'diagnostic_proposal': dp, 'diagnostic_delivery_sha256': digest(encoded(diagnostic)),
                      'diagnostic_report': result, 'diagnostic_report_sha256': digest(encoded(result)),
                      'failed_summary': failed_summary(), 'failed_summary_sha256': digest(encoded(failed_summary())),
                      'decision_sha256': 'a' * 64}
        # Synthetic trust roots: real validation still compares immutable anchors.
        # No synthetic source or credential can be used outside this test process.
        anchors = {False: ('c' * 40, old_proposal['source']['sha256']), True: ('c' * 40, dp['source']['sha256'])}
        self.anchor_patch = patch.object(history, 'PUBLISHED_CLOSURES', anchors)
        self.anchor_patch.start(); self.addCleanup(self.anchor_patch.stop)
        self.dest = self.base.root / 'amended'; self.prepare(self.dest, {'amendment': self.amend}, recovery_amendment=True)
        self.plan, self.item = self.read(self.dest)
        self.ids = [x[0] for x in amendment.predecessors(self.plan, self.item)]
        self.models = []
        for i, (cid, body) in enumerate(amendment.predecessors(self.plan, self.item)):
            value = copy.deepcopy(body); value['id'] = cid; value['location'] = 'SwedenCentral'
            state, code, output = ('Failed', 2, failed_summary()) if i == 0 else ('Succeeded', 0, result)
            value['properties'].update(provisioningState=state, instanceView={
                'executionState': state, 'exitCode': code, 'output': json.dumps(output), 'error': ''})
            self.models.append(value)
        self.extensions = {'value': []}; self.commands = {'value': [{'id': x} for x in self.ids]}
        self.vm = self.transport.vm
        self.vm['properties']['storageProfile']['imageReference'] = cp['image']
        self.fresh = dict(self.base.fresh, target=self.plan['target'], vm_model_sha256=digest(encoded(self.vm)),
                          run_commands=self.ids[:], extensions_model_sha256=digest(encoded(self.extensions)),
                          commands_model_sha256=digest(encoded(self.commands)),
                          predecessor_model_sha256={cid: digest(encoded(model)) for cid, model in zip(self.ids, self.models)})

    def prepare(self, dest, extra=None, historical=False, **kwargs):
        # Published history predates the snap collector module; its closure is fixed.
        modules = HISTORICAL_MODULES if historical else packet.MODULES
        with patch.object(packet, 'verified_head', return_value='c' * 40), patch.object(packet, 'MODULES', modules):
            return packet.prepare(dest, self.retained, self.base.root / 'ssh_public_key', HASH,
                                  dict(self.bindings, **(extra or {})), **kwargs)

    @staticmethod
    def read(dest):
        return tuple(contract.load((dest / name).read_bytes()) for name in ('delivery.json', 'proposal.json'))

    def approve(self, phase='repair'):
        approval = {'action': contract.ACTIONS[phase], 'packet_path': str(self.dest),
                    'delivery_sha256': digest((self.dest / 'delivery.json').read_bytes()),
                    'fresh_sha256': digest(encoded(self.fresh)), 'attempts': 1, 'owner_authorization_reference': 'SYNTHETIC ONLY'}
        raw = encoded(approval)
        with patch('r3_policy_git.verified_head', return_value='c' * 40):
            return contract.approve(self.dest, raw, digest(raw), encoded(self.fresh), phase)

    def before(self):
        r = delivery_tests.response
        return [r(self.vm, etag=self.fresh['vm_etag']), r(self.extensions), r(self.commands),
                r(self.models[0]), r(self.models[1]), r(status=404)]

    def command(self, state='Succeeded'):
        summary = self.transport.summary()
        summary['evidence_path'] = '/var/lib/tonyai-r3-access-recovery-' + self.item['packet_id']
        value = copy.deepcopy(self.plan['requests']['repair_body'])
        value['id'] = self.item['target_imds']['resourceId'] + '/runCommands/r3-key-' + self.item['packet_id']
        value['properties']['instanceView'] = {'executionState': state, 'exitCode': 0, 'output': json.dumps(summary), 'error': ''}
        return value

    def perform(self, values, *, sealed=True, interrupted=None):
        adapter = delivery_tests.FakeAdapter(self.base.client, values)
        with patch.object(control, 'probe'), patch.object(control, 'seal', return_value={'sealed': sealed}):
            result = control.perform(self.dest, self.plan, self.item, self.fresh, 'repair', 'a' * 64, adapter,
                                     sleep=lambda _: None, interrupted=interrupted)
        return result, adapter

    def test_exact_amendment_approval_preserves_guest_spelling_and_controller_identity(self):
        plan, item, _ = self.approve()
        self.assertEqual(item['target_imds']['location'], 'SwedenCentral')
        self.assertEqual(plan['target']['control_plane']['location'], 'swedencentral')
        self.assertEqual(plan['requests']['repair_body']['location'], 'SwedenCentral')
        self.assertEqual(amendment.legacy_view(plan, item)[1]['target_imds']['location'], 'swedencentral')
        self.assertFalse(Path(self.base.client['credential_path']).exists())
        for phase, code in (('enable', 'AMENDMENT_PHASE'), ('diagnose', 'DIAGNOSTIC_PURPOSE')):
            with self.subTest(phase=phase), self.assertRaisesRegex(ValueError, '^' + code + '$'): self.approve(phase)

    def test_nonempty_extensions_extra_hash_key_and_substituted_ids_refuse_at_approval(self):
        self.fresh['extensions'] = [self.item['target_imds']['resourceId'] + '/extensions/foreign']
        with self.assertRaisesRegex(ValueError, '^AMENDMENT_PHASE_OR_EXTENSIONS$'): self.approve()
        self.fresh['extensions'] = []
        self.fresh['predecessor_model_sha256']['/extra'] = 'e' * 64
        with self.assertRaisesRegex(ValueError, '^AMENDMENT_PRIOR_HASHES$'): self.approve()
        del self.fresh['predecessor_model_sha256']['/extra']
        # Same length and distinct, but not the exact predecessor set.
        for ids in ([self.ids[0], self.ids[0][:-1] + '0'], [self.ids[1], 'foreign']):
            self.fresh['run_commands'] = ids
            with self.subTest(ids=ids), self.assertRaisesRegex(ValueError, '^AMENDMENT_COMMAND_LIST$'): self.approve()

    def test_perform_refuses_non_repair_phase_after_one_get(self):
        adapter = delivery_tests.FakeAdapter(self.base.client, self.before())
        with patch.object(control, 'probe'), patch.object(control, 'seal', return_value={'sealed': True}):
            result = control.perform(self.dest, self.plan, self.item, self.fresh, 'diagnose', 'a' * 64, adapter, sleep=lambda _: None)
        self.assertEqual((result['status'], result['failure'], len(adapter.calls)), ('PARTIAL_REVIEW_REQUIRED', 'ValueError', 1))

    def test_live_command_list_must_equal_fresh_ids_before_put(self):
        self.commands = {'value': [{'id': x} for x in reversed(self.ids)]}
        self.fresh['commands_model_sha256'] = digest(encoded(self.commands))
        result, adapter = self.perform(self.before())
        self.assertEqual((result['status'], result['failure'], len(adapter.calls)), ('PARTIAL_REVIEW_REQUIRED', 'ValueError', 3))
        self.assertNotIn('PUT', [x[0] for x in adapter.calls])

    def test_one_new_put_after_both_exact_terminal_predecessors_and_no_replay(self):
        self.approve()
        r = delivery_tests.response
        result, adapter = self.perform(self.before() + [r(status=201), r(self.command())])
        self.assertEqual(result['status'], 'KEY_APPENDED_CUSTODY_REQUIRED')
        self.assertEqual([x[0] for x in adapter.calls], ['GET'] * 6 + ['PUT', 'GET'])
        self.assertNotIn(adapter.calls[6][1].split('?', 1)[0].split('https://management.azure.com')[1], self.ids)
        self.assertFalse(result['access_verified'])
        with self.assertRaises(FileExistsError): self.perform([])

    def test_exact_unordered_set_accepts_and_extra_missing_duplicate_commands_refuse(self):
        self.fresh['run_commands'].reverse(); self.approve()
        for ids in ([], self.ids[:1], self.ids + ['extra'], self.ids + [self.ids[0]], [self.ids[0]] * 2):
            self.fresh['run_commands'] = ids
            with self.subTest(ids=ids), self.assertRaises(ValueError): self.approve()

    def test_export_is_reachable_only_for_exact_three_commands_and_agent(self):
        with self.assertRaises(ValueError): amendment.check_fresh(self.plan, self.item, self.fresh, 'export')
        self.fresh['run_commands'] += [self.item['target_imds']['resourceId'] + '/runCommands/r3-key-' + self.item['packet_id']]
        actual = contract.os.stat
        with patch.object(contract.os, 'stat', wraps=actual) as st:
            # Only the agent socket check is replaced; custody files remain real.
            st.side_effect = lambda p, *a, **k: type('Socket', (), {'st_mode': stat.S_IFSOCK})() if p == '/synthetic-agent' else actual(p, *a, **k)
            with patch.dict(contract.os.environ, SSH_AUTH_SOCK='/synthetic-agent'):
                self.approve('export')
        self.fresh['run_commands'].append('extra')
        with self.assertRaises(ValueError): amendment.check_fresh(self.plan, self.item, self.fresh, 'export')

    def test_nonlocation_drift_and_incomplete_diagnostics_refuse(self):
        for key, value in [('vmId', '0' * 36), ('location', 'SWEDENCENTRAL'), ('location', 'swedencentral '), ('location', '\u017fwedencentral')]:
            changed = copy.deepcopy(self.amend)
            dp = changed['diagnostic_proposal']
            values = dict(dp['target_imds'], location='SwedenCentral'); values[key] = value
            changed['diagnostic_report'] = identity_tests.report(dp, values)
            changed['diagnostic_report_sha256'] = digest(encoded(changed['diagnostic_report']))
            with self.subTest(field=key, value=value), self.assertRaises(ValueError): amendment.historical(changed)
        changed = copy.deepcopy(self.amend)
        changed['diagnostic_report'] = identity_tests.report(changed['diagnostic_proposal'], fail_at='imds-json')
        changed['diagnostic_report_sha256'] = digest(encoded(changed['diagnostic_report']))
        with self.assertRaises(ValueError): amendment.historical(changed)

    def test_late_failed_repair_and_changed_new_bindings_refuse(self):
        changed = copy.deepcopy(self.amend); changed['failed_summary']['phase'] = 'append'
        changed['failed_summary_sha256'] = digest(encoded(changed['failed_summary']))
        with self.assertRaisesRegex(ValueError, 'AMENDMENT_NOT_EARLY_REFUSAL'): amendment.historical(changed)
        for key, value in (('failure', 'KeyError'), ('status', 'FAILED'), ('access_verified', True), ('append', {})):
            changed = copy.deepcopy(self.amend); changed['failed_summary'][key] = value
            changed['failed_summary_sha256'] = digest(encoded(changed['failed_summary']))
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, '^AMENDMENT_NOT_EARLY_REFUSAL$'):
                amendment.historical(changed)
        for key in ('custody', 'client', 'target'):
            plan = copy.deepcopy(self.plan)
            if key == 'custody': plan[key]['recipient'] += 'changed'
            elif key == 'client': plan[key]['principal'] = 'f' * 36
            else: plan[key]['imds']['vmId'] = 'f' * 36
            with self.subTest(key=key), self.assertRaises(ValueError): amendment.validate(plan, self.item)
        item = dict(self.item, packet_id=self.amend['diagnostic_proposal']['packet_id'])
        with self.assertRaises(ValueError): amendment.validate(self.plan, item)

    def test_changed_full_model_source_terminal_code_output_and_options_refuse(self):
        for index in (0, 1):
            for kind in ('hash', 'source', 'provision', 'state', 'code', 'bool_code', 'output', 'options'):
                value = copy.deepcopy(self.models[index]); props = value['properties']; view = props['instanceView']
                if kind == 'hash': value['extra'] = True
                elif kind == 'source': props['source']['script'] += '# changed'
                elif kind == 'provision': props['provisioningState'] = 'Creating'
                elif kind == 'state': view['executionState'] = 'Running'
                elif kind == 'code': view['exitCode'] = 99
                elif kind == 'bool_code': view['exitCode'] = False
                elif kind == 'output': view['output'] = '{}'
                else: props['runAsUser'] = 'root'
                fresh = copy.deepcopy(self.fresh)
                if kind != 'hash': fresh['predecessor_model_sha256'][self.ids[index]] = digest(encoded(value))
                with self.subTest(index=index, kind=kind), self.assertRaises(ValueError):
                    amendment.check_response(delivery_tests.response(value), self.plan, self.item, fresh, index)

    def test_predecessor_error_text_refuses_as_nonterminal(self):
        for index in (0, 1):
            value = copy.deepcopy(self.models[index]); value['properties']['instanceView']['error'] = 'refused'
            fresh = copy.deepcopy(self.fresh); fresh['predecessor_model_sha256'][self.ids[index]] = digest(encoded(value))
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, '^AMENDMENT_PRIOR_TERMINAL$'):
                amendment.check_response(delivery_tests.response(value), self.plan, self.item, fresh, index)

    def test_diagnostic_bound_to_other_prior_exit_code_refuses(self):
        old, old_proposal = self.read(self.old_dir)
        prior = {'id': old_proposal['target_imds']['resourceId'] + '/runCommands/r3-key-' + old_proposal['packet_id'],
                 'source_sha': 'c' * 40, 'delivery_sha256': digest(encoded(old)), 'request_body': old['requests']['repair_body'],
                 'execution_state': 'Failed', 'exit_code': 3, 'delivery': old, 'proposal': old_proposal}
        dest = self.base.root / 'diagnostic-exit3'; self.prepare(dest, {'prior_command': prior}, historical=True, identity_diagnostic=True)
        diagnostic, dp = self.read(dest)
        result = identity_tests.report(dp, dict(dp['target_imds'], location='SwedenCentral'))
        changed = dict(self.amend, diagnostic_delivery=diagnostic, diagnostic_proposal=dp,
                       diagnostic_delivery_sha256=digest(encoded(diagnostic)),
                       diagnostic_report=result, diagnostic_report_sha256=digest(encoded(result)))
        with self.assertRaisesRegex(ValueError, '^AMENDMENT_DIAGNOSTIC_ID$'): amendment.historical(changed)

    def test_nonterminal_predecessor_refuses_before_any_put(self):
        self.models[1]['properties']['provisioningState'] = 'Creating'
        self.fresh['predecessor_model_sha256'][self.ids[1]] = digest(encoded(self.models[1]))
        result, adapter = self.perform(self.before())
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual([x[0] for x in adapter.calls], ['GET'] * 5)

    def test_twelve_request_budget_no_retry_and_no_false_success(self):
        r = delivery_tests.response
        result, adapter = self.perform(self.before() + [r(status=201)] + [r(self.command('Running'))] * 6)
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(len(adapter.calls), 12)
        self.assertEqual(sum(x[0] == 'PUT' for x in adapter.calls), 1)
        self.assertEqual(len(adapter.responses), 1)

    def test_ambiguous_mutation_consumes_without_poll_or_retry(self):
        result, adapter = self.perform(self.before() + [TimeoutError('sensitive')])
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(len(adapter.calls), 7)
        self.assertTrue((self.dest / 'repair-consumed.json').exists())

    def test_freshness_rechecked_immediately_before_mutation(self):
        self.approve()
        self.fresh['observed_at'] = (datetime.now(timezone.utc) - timedelta(seconds=901)).isoformat()
        result, adapter = self.perform(self.before())
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertEqual(len(adapter.calls), 6)
        self.assertNotIn('PUT', [x[0] for x in adapter.calls])

    def test_seal_failure_cannot_accept_recovery(self):
        r = delivery_tests.response
        result, _ = self.perform(self.before() + [r(status=201), r(self.command())], sealed=False)
        self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')

    def test_consistent_rewritten_module_cannot_impersonate_published_history(self):
        for diagnostic in (False, True):
            dest = self.diag_dir if diagnostic else self.old_dir
            delivery, item = self.read(dest)
            modules = {name: base64.b64encode((packet.ROOT / 'infra/scripts' / (name + '.py')).read_bytes()).decode() for name in HISTORICAL_MODULES}
            name = 'r3_access_identity_diagnostic' if diagnostic else 'r3_access_repair_guest'
            modules[name] = base64.b64encode(b'pass\n').decode()
            item['source']['files']['infra/scripts/' + name + '.py'] = digest(b'pass\n')
            item['source']['sha256'] = digest(encoded(item['source']['files']))
            factory = packet.diagnostic_payload if diagnostic else packet.payload
            guest = factory(item, modules=modules)
            delivery.update(requests=contract.requests(item, guest), guest_sha256=digest(guest), proposal_sha256=digest(encoded(item)),
                            export_sha256=digest(b'' if diagnostic else packet.export_payload(item, modules=modules)))
            with self.subTest(diagnostic=diagnostic), self.assertRaisesRegex(ValueError, 'HISTORICAL_PUBLISHED_SOURCE'):
                history.validate_payload(delivery, item, diagnostic=diagnostic)

    def test_embedded_modules_and_proposal_are_bound_without_execution(self):
        codes = {'hash': 'HISTORICAL_MODULE_HASH', 'closure': 'HISTORICAL_MODULE_CLOSURE',
                 'proposal': 'HISTORICAL_EMBEDDED_PROPOSAL', 'shell': 'HISTORICAL_SHELL_WRAPPER'}
        for kind, code in codes.items():
            delivery, item = self.read(self.diag_dir)
            modules = {name: base64.b64encode((packet.ROOT / 'infra/scripts' / (name + '.py')).read_bytes()).decode() for name in HISTORICAL_MODULES}
            embedded = copy.deepcopy(item)
            if kind == 'hash': modules['r3_access_identity_diagnostic'] = base64.b64encode(b'pass\n').decode()
            elif kind == 'closure': del modules['r3_access_identity_diagnostic']
            elif kind == 'proposal': embedded['packet_id'] = 'f' * 32
            guest = packet.diagnostic_payload(embedded, modules=modules)
            delivery.update(requests=contract.requests(item, guest), guest_sha256=digest(guest))
            if kind == 'shell': delivery['requests']['repair_body']['properties']['source']['script'] = '#!/bin/sh\nexit 0\n'
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, code):
                history.validate_payload(delivery, item, diagnostic=True)

    def test_rehashed_wrapper_changes_cannot_impersonate_bound_module_closure(self):
        delivery, item = self.read(self.diag_dir)
        guest = (self.diag_dir / 'guest.py').read_bytes() + b'\nprint("extra")\n'
        delivery.update(requests=contract.requests(item, guest), guest_sha256=digest(guest))
        with self.assertRaisesRegex(ValueError, 'HISTORICAL_PYTHON_WRAPPER'):
            history.validate_payload(delivery, item, diagnostic=True)
        delivery, item = self.read(self.old_dir)
        delivery['export_sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'HISTORICAL_EXPORT_BINDING'):
            history.validate_payload(delivery, item, diagnostic=False)


if __name__ == '__main__':
    unittest.main()
