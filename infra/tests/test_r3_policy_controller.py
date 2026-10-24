"""Controller status and frame negatives with all native/network effects replaced."""
import copy
from contextlib import ExitStack
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from test_r3_policy_evidence import document, BINDING
import r3_noble_fixture as host
import r3_noble_guest as guest
import r3_noble_inputs as inputs
import r3_install_policy as policy
import r3_policy_evidence as evidence
import r3_policy_validate as validator
from r3_noble_common import encoded, digest, write


def manifest():
    return {'purpose': evidence.A_PURPOSE, 'source': BINDING['source'],
            'image_sha256': BINDING['image_sha256'], 'fixture_uuid': BINDING['fixture_uuid'],
            'files': {'r3-toolchain.lock.json': BINDING['toolchain_sha256']}}


class CollectionController(unittest.TestCase):
    def test_frame_file_set_and_independent_checks(self):
        expected = manifest()
        entries = {'manifest.json': encoded(expected), 'policy-evidence.json': encoded(document()), 'result.json': b'{}'}
        result = {'format': 1, 'purpose': evidence.A_PURPOSE, 'qa_ready': False,
                  'target_qualified': False, 'install_attempted': False, 'status': 'COLLECTED_REVIEW_REQUIRED',
                  'phase': 'collection', 'source': expected['source'], 'checks': validator.validate(encoded(document()), BINDING),
                  'not_reached': list(guest.COMMANDS + guest.POLICY_COMMANDS), 'files': {}}
        self.assertEqual(host.validate_collection(entries, result, expected), result)
        for case in ('extra', 'missing', 'checks', 'status', 'failure'):
            files, changed = copy.deepcopy(entries), copy.deepcopy(result)
            if case == 'extra': files['native-state.json'] = b'{}'
            if case == 'missing': del files['manifest.json']
            if case == 'checks': changed['checks']['policy_input_hashes'] = {}
            if case == 'status': changed['status'] = 'DIAGNOSTIC_PASS_REVIEW_REQUIRED'
            if case == 'failure': changed['failure_type'] = 'PermissionError'
            with self.subTest(case=case), self.assertRaises(ValueError):
                host.validate_collection(files, changed, expected)

    def test_collection_policy_combinations_fail_before_inputs(self):
        for key in ('hash', 'file'):
            expected = manifest()
            if key == 'hash': expected['policy_sha256'] = 'f' * 64
            else: expected['files']['installation-policy.json'] = 'f' * 64
            with self.assertRaises(ValueError): guest.collection_binding(expected)
        with patch.object(inputs, 'fetch', side_effect=AssertionError('fetch reached')), self.assertRaisesRegex(ValueError, 'Collection cannot'):
            inputs.stage(None, None, {}, {}, 0, b'{}', True)
        with patch.dict(os.environ, {'R3_PURPOSE': 'policy-collection', 'R3_INSTALL_POLICY': '{}'}, clear=True), \
             patch.object(host, 'source_binding', return_value={}), patch.object(host, 'recipient', return_value='synthetic'), \
             patch.object(policy, 'load'), patch.object(host, 'write', side_effect=AssertionError('attempt reached')), \
             self.assertRaisesRegex(ValueError, 'Invalid collection purpose/policy'):
            host.main()

    def test_controller_collection_status_and_seal_exit_matrix(self):
        lock = json.loads((host.ROOT / 'infra/selfhost/r3-noble-fixture.lock.json').read_bytes())
        source = {'sha': 'a' * 40, 'ref': 'refs/heads/synthetic', 'run_id': '123', 'attempt': 1,
                  'job': 'synthetic', 'workflow_sha256': 'b' * 64}
        for native_status in ('COLLECTED_REVIEW_REQUIRED', 'PARTIAL_REVIEW_REQUIRED', 'REFUSED'):
            for sealed in (True, False):
                with tempfile.TemporaryDirectory() as tmp, ExitStack() as stack:
                    root = Path(tmp)
                    work = root / 'work'
                    work.mkdir()
                    def stage(work, _raw, _lock, _source, _deadline, _policy, collection_only):
                        self.assertIs(collection_only, True)
                        inp = work / 'input'
                        inp.mkdir()
                        write(inp / 'manifest.json', encoded(manifest()))
                        write(work / lock['image'], b'synthetic image')
                        return inp
                    def seed(path, _source):
                        path.mkdir()
                        for name in ('user-data', 'meta-data'): write(path / name, b'synthetic')
                    def run(_argv, _raw, label, **_kwargs):
                        if label == 'runner-tools':
                            return ''.join(k + '\t' + v + '\n' for k, v in lock['runner_packages'].items()).encode()
                        if label == 'image-info': return encoded({'format': 'qcow2', 'virtual-size': 1024})
                        return b''
                    env = {'RUNNER_TEMP': str(root), 'R3_PURPOSE': 'policy-collection'}
                    stack.enter_context(patch.dict(os.environ, env, clear=True))
                    for name, value in (('source_binding', lambda _env: source), ('recipient', lambda *_args: 'synthetic'),
                                        ('stage_age', lambda *_args: None), ('stage', stage), ('seed', seed), ('run', run),
                                        ('vm', lambda *_args: b'synthetic'), ('validate_frame', lambda *_args: {'status': native_status}),
                                        ('file_hash', lambda path: lock['image_sha256'] if Path(path).name == lock['image'] else digest(str(path).encode()))):
                        stack.enter_context(patch.object(host, name, side_effect=value))
                    stack.enter_context(patch.object(host.tempfile, 'mkdtemp', return_value=str(work)))
                    stack.enter_context(patch.object(host.signal, 'signal'))
                    stack.enter_context(patch.object(host, 'seal', return_value={}, side_effect=None if sealed else OSError('synthetic seal')))
                    code = host.main()
                    summary = json.loads((root / 'r3-noble-publish/summary.json').read_bytes())
                    self.assertEqual(code, 0 if native_status == 'COLLECTED_REVIEW_REQUIRED' and sealed else 1)
                    self.assertEqual(summary['sealed'], sealed)
                    self.assertEqual(summary['status'], native_status if sealed else 'REFUSED')


if __name__ == '__main__':
    unittest.main()
