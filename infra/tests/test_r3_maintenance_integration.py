"""Mocked installer and independent encrypted-frame readback policy integration."""
import copy
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from test_r3_install_guards import Harness, SCRIPTS
from test_r3_maintenance_policy import fixture, trigger_trace, LOCK_BYTES, LOCK
from r3_package_fixtures import render, installed, trace, observation
import r3_install_policy as policy
import r3_maintenance as maintenance
import r3_noble_common as common
import r3_noble_fixture as controller
import r3_noble_guest as guest
from r3_package_state import INVENTORY_ARGV, inventory_diff
from r3_toolchain import install_argv

CACHE = {'.': {'directory': True, 'uid': 6, 'gid': 12, 'mode': 0o755}}


class PolicyHarness(Harness):
    def __init__(self, root):
        super().__init__(root, fault='man-db-trigger')
        for name in ('r3_install_policy.py', 'r3_maintenance.py', 'r3_noble_common.py', 'r3_noble_identity.py'):
            shutil.copyfile(SCRIPTS / name, self.helpers / name)
            self.approval[name + '_sha256'] = policy.digest((self.helpers / name).read_bytes())
        self.policy, _, self.facts = fixture()
        before = self.capture(INVENTORY_ARGV); self.inventory_calls = 0
        from r3_package_state import inventory
        self.policy.update(toolchain_sha256=policy.digest((self.bundle / 'r3-toolchain.lock.json').read_bytes()),
                           inventory_sha256=policy.digest(policy.encoded(inventory(before))),
                           cache_before_sha256=policy.digest(policy.encoded(CACHE)))
        self.policy_path = root / 'maintenance.json'
        self.policy_path.write_bytes(policy.encoded(self.policy)); self.policy_path.chmod(0o600)
        self.approval.update(format=3, action='r02-maintenance-toolchain-install',
                             policy_sha256=policy.digest(self.policy_path.read_bytes()))
        self.bind()

    def bind(self):
        self.approval_path.write_bytes(policy.encoded(self.approval))
        self.approved = policy.digest(self.approval_path.read_bytes())

    def capture(self, argv):
        if argv == ['apt-config', 'dump']: return 'config'
        if argv == ['systemctl', 'cat', *maintenance.UNITS]: return 'units'
        return super().capture(argv)

    def popen(self, argv, **kwargs):
        result = super().popen(argv, **kwargs)
        (self.root / 'etc/tonyai/r3-install.dpkg.log').write_text(trace(self.lock) + trigger_trace())
        return result

    def execute(self):
        with patch.object(policy, 'facts', return_value=self.facts), \
                patch.object(policy, 'cache_snapshot', return_value=CACHE), \
                patch.object(maintenance, 'isolate', return_value=observation()):
            self.run(self.policy_path)


class InstallerIntegration(unittest.TestCase):
    def test_format_three_receipt_binds_policy_and_all_helpers(self):
        with tempfile.TemporaryDirectory() as name:
            h = PolicyHarness(Path(name)); h.execute()
            receipt = json.loads((h.root / 'etc/tonyai/r3-installed-receipt.json').read_bytes())
            self.assertEqual(receipt['format'], 3)
            self.assertEqual(receipt['binding'], h.approval)
            self.assertEqual(len(receipt['package_transaction']['actions']['native_triggers']), 4)
            self.assertEqual(receipt['package_transaction']['inventory_diff']['changed_existing'], [])
            self.assertIn('cache-effects.json', receipt['package_transaction']['evidence_sha256'])

    def test_wrong_old_approval_or_unresolved_hook_never_mutates(self):
        for fault in ('old-format', 'wrong-policy', 'packagekit', 'cache-baseline', 'facts'):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as name:
                h = PolicyHarness(Path(name))
                if fault == 'old-format': h.approval['format'] = 2; h.bind()
                if fault == 'wrong-policy': h.approval['policy_sha256'] = 'f' * 64; h.bind()
                if fault == 'packagekit':
                    h.facts['packagekit_activation_possible'] = True
                    h.policy['facts_sha256'] = policy.digest(policy.encoded(h.facts))
                    h.policy_path.write_bytes(policy.encoded(h.policy))
                    h.approval['policy_sha256'] = policy.digest(h.policy_path.read_bytes()); h.bind()
                if fault == 'cache-baseline':
                    h.policy['cache_before_sha256'] = 'f' * 64
                    h.policy_path.write_bytes(policy.encoded(h.policy))
                    h.approval['policy_sha256'] = policy.digest(h.policy_path.read_bytes()); h.bind()
                if fault == 'facts': h.facts['files']['/usr/bin/mandb']['sha256'] = 'e' * 64
                with self.assertRaises(ValueError): h.execute()
                self.assertFalse((h.root / 'etc/tonyai/r3-install-attempt.json').exists())
                self.assertFalse(any(c[0] in ('systemctl', 'apt') for c in h.calls))

    def test_refused_trigger_retains_post_transaction_policy_evidence(self):
        with tempfile.TemporaryDirectory() as name:
            h = PolicyHarness(Path(name))
            with patch.object(policy, 'trigger_transaction', side_effect=ValueError('Unknown trigger')):
                with self.assertRaisesRegex(ValueError, 'Unknown trigger'): h.execute()
            evidence = h.root / 'etc/tonyai/r3-package-evidence'
            self.assertEqual(json.loads((evidence / 'cache-after.json').read_bytes()), CACHE)
            self.assertEqual(json.loads((evidence / 'policy-facts-after.json').read_bytes()), h.facts)
            self.assertFalse((h.root / 'etc/tonyai/r3-installed-receipt.json').exists())


class FrameIntegration(unittest.TestCase):
    def setUp(self):
        self.policy, before, facts = fixture()
        self.policy['cache_before_sha256'] = policy.digest(policy.encoded(CACHE))
        data = policy.encoded(self.policy)
        self.manifest = {'purpose': 'FIXTURE_MAINTENANCE_ONLY', 'source': {'sha': 'a' * 40},
                         'policy_sha256': policy.digest(data)}
        after = {**installed(LOCK), 'man-db:amd64': before['man-db:amd64']}
        final = {**installed(LOCK, held=True), 'man-db:amd64': before['man-db:amd64']}
        self.entries = {name: b'' for name in guest.GUEST_REQUIRED_FILES | guest.POLICY_FILES if name != 'result.json'}
        def put(name, value): self.entries[name] = policy.encoded(value)
        put('manifest.json', self.manifest); self.entries['installation-policy.json'] = data
        for name in ('policy-facts-before.json', 'policy-facts-after.json'): put(name, facts)
        for name in ('cache-before.json', 'cache-after.json'): put(name, CACHE)
        put('maintenance-intent.json', {'format': 1, 'units': list(maintenance.UNITS),
            'original': observation(), 'helper': None, 'restoration_authorized': False,
            'failure_action': 'RETAIN_MASKS_AND_JOURNAL'})
        put('maintenance-final.json', observation())
        put('maintenance-pre-stop.json', {'observation': observation(), 'helper': None})
        put('maintenance-complete.json', {'units': list(maintenance.UNITS), 'inventory_unchanged': True, 'release_authorized': False})
        put('observations.json', [{'child': None, 'value': observation()}])
        for name in ('before', 'pre-execute', 'isolation-inventory', 'pre-stop-inventory'):
            self.entries[name + '.stdout'] = render(before).encode()
        for name, value in [('after', after), ('final', final)]: self.entries[name + '.stdout'] = render(value).encode()
        self.entries['unit-config.stdout'] = b'units'; self.entries['config.stdout'] = b'config'
        self.entries['simulate.stdout'] = ('\n'.join(f"{action} {p['name']} ({p['version']} local [amd64])"
            for action in ('Inst', 'Conf') for p in LOCK['packages']) + '\n').encode()
        self.entries['transaction.log'] = (trace(LOCK) + trigger_trace()).encode()
        argvs = {'unit-config': ['systemctl', 'cat', *maintenance.UNITS],
                 'pre-stop-inventory': INVENTORY_ARGV, 'isolation-inventory': INVENTORY_ARGV,
                 'maintenance-mask': ['systemctl', 'mask', *maintenance.UNITS],
                 'maintenance-stop-timers': ['systemctl', 'stop', *maintenance.TIMERS],
                 'maintenance-stop-services': ['systemctl', 'stop', *maintenance.SERVICES]}
        for name in guest.COMMANDS + guest.POLICY_COMMANDS:
            put(name + '.command.json', {'argv': argvs.get(name, []), 'child': {'pid': 1}})
            put(name + '.exit.json', {'returncode': 0, 'failure_type': None,
                'stdout_sha256': policy.digest(self.entries[name + '.stdout']), 'stderr_sha256': policy.digest(b'')})
        self.result = {'purpose': self.manifest['purpose'], 'source': self.manifest['source'],
            'qa_ready': False, 'target_qualified': False, 'status': 'DIAGNOSTIC_PASS_REVIEW_REQUIRED',
            'install_attempted': True, 'phase': 'complete', 'not_reached': [], 'checks': {
                'inventory': inventory_diff(before, after, LOCK),
                'transaction': policy.trigger_transaction(self.entries['transaction.log'].decode(), LOCK, self.policy),
                'final_inventory': inventory_diff(before, final, LOCK, held=True),
                'cache_effects': policy.cache_effects(CACHE, CACHE, self.policy)}}

    def frame(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name)
            for key, value in self.entries.items(): (path / key).write_bytes(value)
            (path / 'result.json').write_bytes(policy.encoded({**self.result,
                'files': {k: policy.digest(v) for k, v in self.entries.items()}}))
            return guest.archive(path)

    def test_complete_synthetic_frame_and_independent_refusals(self):
        self.assertEqual(controller.validate_frame(self.frame(), self.manifest)['status'], 'DIAGNOSTIC_PASS_REVIEW_REQUIRED')
        original = copy.deepcopy(self.entries)
        for name in guest.POLICY_COMMANDS:
            self.entries = copy.deepcopy(original)
            self.entries[name + '.command.json'] = policy.encoded({'argv': ['true']})
            with self.subTest(command=name), self.assertRaisesRegex(ValueError, 'argv'):
                controller.validate_frame(self.frame(), self.manifest)
        self.entries = copy.deepcopy(original)
        self.entries['cache-after.json'] = policy.encoded({**CACHE,
            'unreviewed': {'sha256': 'a' * 64, 'bytes': 1, 'uid': 6, 'gid': 12, 'mode': 0o644}})
        with self.assertRaisesRegex(ValueError, 'cache effect'): controller.validate_frame(self.frame(), self.manifest)
        self.entries = copy.deepcopy(original); del self.entries['maintenance-pre-stop.json']
        with self.assertRaisesRegex(ValueError, 'Incomplete native'): controller.validate_frame(self.frame(), self.manifest)
        for name in ('maintenance-final.json', 'observations.json'):
            self.entries = copy.deepcopy(original)
            value = json.loads(self.entries[name])
            (value if isinstance(value, dict) else value[0]['value'])['locks_probed'] = False
            self.entries[name] = policy.encoded(value)
            with self.assertRaisesRegex(ValueError, 'lock evidence'): controller.validate_frame(self.frame(), self.manifest)


if __name__ == '__main__': unittest.main()
