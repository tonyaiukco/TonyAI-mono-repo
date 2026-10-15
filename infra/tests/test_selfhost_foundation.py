"""Selfhost rejects secret/ambient inputs and shares no application state grants."""
import base64
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pooler import SafeFailure
from selfhost_contract import validate_selfhost
from terraform_run import invoke
from test_backend import config as backend_config


def public_key(exponent=b'\x01\x00\x01'):
    # Synthetic public-only fixture; no private key exists.
    fields = [b'ssh-rsa', exponent, b'\x00\x80' + b'\x01' * 255]
    return 'ssh-rsa ' + base64.b64encode(b''.join(struct.pack('>I', len(v)) + v for v in fields)).decode()


def inputs():
    backend = backend_config()
    return {'config': {**{k: backend[k] for k in ('subscription_id', 'tenant_id', 'environment')},
                       'operator_ipv4': '8.8.8.8/32', 'ssh_public_key': public_key(),
                       'image_version': '24.04.202601010', 'vm_size': 'Standard_D2as_v7',
                       'recovery_owner_object_id': '00000000-0000-0000-0000-000000000003', 'https_enabled': False}}


class SelfhostTests(unittest.TestCase):
    def test_rejects_unknown_secret_weak_key_and_public_network_inputs(self):
        cases = [('password', 'synthetic'), ('https_enabled', 'true'), ('image_version', 'latest'),
                 ('vm_size', 'Standard_D64as_v5'), ('environment', 'dev'),
                 ('operator_ipv4', '0.0.0.0/0'), ('operator_ipv4', '10.0.0.1/32'),
                 ('operator_ipv4', '8.8.8.8/31'), ('operator_ipv4', '::1/128'),
                 ('ssh_public_key', '-----BEGIN PRIVATE KEY-----'),
                 ('ssh_public_key', 'ssh-rsa c3ludGhldGlj'), ('subscription_id', '../escape')]
        for field, value in cases:
            data = inputs(); data['config'][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(SafeFailure):
                validate_selfhost(data)
        self.assertEqual(validate_selfhost(inputs())['environment'], 'staging')

    def test_invalid_rsa_exponents_fail_before_cloud_operations(self):
        for exponent in (b'', b'\x04', b'\x80', b'\x00\x03', b'\x00\x80' + b'\x01' * 255):
            data = inputs(); data['config']['ssh_public_key'] = public_key(exponent)
            with self.subTest(exponent=exponent[:3]), self.assertRaises(SafeFailure):
                validate_selfhost(data)

    def test_owner_state_key_does_not_collide_with_foundation_or_application(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = Path(directory) / 'backend.json'; data = Path(directory) / 'inputs.json'
            backend.write_text(json.dumps(backend_config())); data.write_text(json.dumps(inputs()))
            with patch('terraform_run.subprocess.run') as run:
                run.return_value.returncode = 0
                invoke('selfhost', backend, data, 'output')
                command = run.call_args_list[0].args[0]
                self.assertIn('-backend-config=container_name=foundation', command)
                self.assertIn('-backend-config=key=staging-selfhost.tfstate', command)
                self.assertEqual(run.call_args_list[1].args[0][-3:], ['output', '-json', 'selfhost_contract'])

    def test_unattended_apply_and_mismatched_target_fail_before_terraform(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = Path(directory) / 'backend.json'; data = Path(directory) / 'inputs.json'
            backend.write_text(json.dumps(backend_config()))
            contract = inputs(); contract['config']['environment'] = 'production'
            data.write_text(json.dumps(contract))
            with patch('terraform_run.subprocess.run') as run:
                for lane, action in [('selfhost', 'approved-apply'), ('selfhost', 'apply'), ('../selfhost', 'plan'), ('selfhost', 'destroy')]:
                    with self.subTest(lane=lane, action=action), self.assertRaises(SafeFailure):
                        invoke(lane, backend, data, action)
                run.assert_not_called()
