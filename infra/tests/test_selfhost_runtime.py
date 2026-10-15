"""Reject public database ports, lost persistence, relaxed Auth and URL-bearing logs."""
import copy
import hashlib
import json
import os
import tempfile
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from selfhost_pin import validate, redact_gateway


def config():
    return {'services': {
        'api-gw': {'volumes': [{'type': 'bind', 'source': '/opt/tonyai/supabase/volumes/api/envoy/lds.qa.yaml', 'target': '/etc/envoy/lds.template.yaml', 'read_only': True, 'bind': {'create_host_path': False}}], 'ports': [{'host_ip': '127.0.0.1', 'published': '8000', 'target': 8000, 'protocol': 'tcp'}]},
        'caddy': {'ports': [{'published': '443', 'target': 443, 'protocol': 'tcp'}]},
        'db': {'volumes': [{'source': '/srv/tonyai/database/postgres', 'target': '/var/lib/postgresql/data', 'bind': {'create_host_path': False}},
                           {'source': '/srv/tonyai/database/db-config', 'target': '/etc/postgresql-custom', 'bind': {'create_host_path': False}}]},
        'storage': {'volumes': [{'source': '/srv/tonyai/objects/storage', 'target': '/var/lib/storage', 'bind': {'create_host_path': False}}]},
        'imgproxy': {'volumes': [{'source': '/srv/tonyai/objects/storage', 'target': '/var/lib/storage', 'bind': {'create_host_path': False}}]},
        'auth': {'environment': {'GOTRUE_DISABLE_SIGNUP': 'true', 'GOTRUE_EXTERNAL_PHONE_ENABLED': 'false',
                                'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED': 'false', 'GOTRUE_PASSWORD_MIN_LENGTH': '12',
                                'GOTRUE_MAILER_OTP_LENGTH': '10', 'GOTRUE_RATE_LIMIT_HEADER': 'X-Forwarded-For',
                                'GOTRUE_RATE_LIMIT_VERIFY': '30', 'GOTRUE_RATE_LIMIT_TOKEN_REFRESH': '30',
                                'GOTRUE_MAILER_OTP_EXP': '3600', 'GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED': 'true',
                                'GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL': '10',
                                'GOTRUE_JWT_KEYS': json.dumps([{'alg': 'ES256', 'kty': 'EC', 'crv': 'P-256',
                                                              'kid': 'test', 'd': 'test', 'x': 'test', 'y': 'test',
                                                              'key_ops': ['sign', 'verify']}])}},
    }}


class RuntimeTests(unittest.TestCase):
    def test_public_database_gateway_and_lost_disk_refused(self):
        base = config()
        validate(base)
        variants = []
        data = copy.deepcopy(base); data['services']['db']['ports'] = [{'published': '5432'}]; variants.append(data)
        data = copy.deepcopy(base); data['services']['api-gw']['ports'][0]['host_ip'] = '0.0.0.0'; variants.append(data)
        data = copy.deepcopy(base); data['services']['db']['volumes'][0]['source'] = './volumes/db/data'; variants.append(data)
        data = copy.deepcopy(base); data['services']['auth']['environment']['GOTRUE_DISABLE_SIGNUP'] = 'false'; variants.append(data)
        for data in variants:
            with self.assertRaises(ValueError):
                validate(data)

    def test_gateway_log_removes_path_and_referer(self):
        template = 'header\n inline_string: "%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %REQ(REFERER)%"\nfooter\n'
        with tempfile.TemporaryDirectory() as directory:
            previous = Path.cwd()
            try:
                os.chdir(directory)
                source = Path('volumes/api/envoy/lds.template.yaml'); source.parent.mkdir(parents=True)
                source.write_text(template)
                with patch('selfhost_pin.GATEWAY_TEMPLATE_SHA256', hashlib.sha256(template.encode()).hexdigest()):
                    redact_gateway()
                    result = source.with_name('lds.qa.yaml').read_text()
                    self.assertNotIn('%REQ', result)
                    self.assertIn('%RESPONSE_CODE%', result)
                    source.write_text('changed upstream')
                    with self.assertRaisesRegex(ValueError, 'digest'): redact_gateway()
                    self.assertEqual(source.with_name('lds.qa.yaml').read_text(), result)
            finally: os.chdir(previous)
        import selfhost_pin
        lock = json.loads((Path(__file__).resolve().parents[1] / 'selfhost/upstream.lock.json').read_text())
        self.assertEqual(selfhost_pin.GATEWAY_TEMPLATE_SHA256, lock['files']['volumes/api/envoy/lds.template.yaml'])

    def test_auth_requires_exactly_one_private_es256_signing_key(self):
        base = config()
        keys = json.loads(base['services']['auth']['environment']['GOTRUE_JWT_KEYS'])
        for invalid in ([{**keys[0], 'key_ops': ['verify']}], keys * 2,
                        [{**keys[0], 'd': ''}], [{**keys[0], 'alg': 'HS256'}]):
            data = copy.deepcopy(base)
            data['services']['auth']['environment']['GOTRUE_JWT_KEYS'] = json.dumps(invalid)
            with self.assertRaises(ValueError):
                validate(data)

    def test_each_auth_control_and_missing_value_is_rejected(self):
        base = config()
        for key in base['services']['auth']['environment']:
            for value in (None, 'unsafe'):
                data = copy.deepcopy(base)
                if value is None: del data['services']['auth']['environment'][key]
                else: data['services']['auth']['environment'][key] = value
                with self.subTest(key=key, value=value), self.assertRaises((ValueError, KeyError)):
                    validate(data)

    def test_every_disk_mount_and_port_boundary(self):
        base = config()
        variants = []
        for name in ('db', 'storage', 'imgproxy', 'api-gw'):
            for index in range(len(base['services'][name]['volumes'])):
                for field in ('source', 'target', 'bind'):
                    data = copy.deepcopy(base)
                    data['services'][name]['volumes'][index][field] = {} if field == 'bind' else '/foreign'
                    variants.append(data)
        for name in ('api-gw', 'caddy'):
            data = copy.deepcopy(base); del data['services'][name]; variants.append(data)
            data = copy.deepcopy(base); data['services'][name]['ports'] *= 2; variants.append(data)
            data = copy.deepcopy(base); data['services'][name]['ports'][0]['protocol'] = 'udp'; variants.append(data)
        for field, value in [('privileged', True), ('network_mode', 'host'), ('pid', 'host'), ('cap_add', ['NET_ADMIN']),
                             ('volumes', [{'source': '/var/run/docker.sock'}])]:
            data = copy.deepcopy(base); data['services']['auth'][field] = value; variants.append(data)
        for data in variants:
            with self.assertRaises(ValueError): validate(data)

    def test_gateway_bind_type_readonly_and_uniqueness(self):
        for change in ('volume', 'missing-readonly', 'writable', 'duplicate'):
            data = config(); mounts = data['services']['api-gw']['volumes']
            if change == 'volume': mounts[0]['type'] = 'volume'
            elif change == 'missing-readonly': del mounts[0]['read_only']
            elif change == 'writable': mounts[0]['read_only'] = False
            else: mounts.append(copy.deepcopy(mounts[0]))
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'Gateway must bind'): validate(data)

    def test_reviewed_compose_gateway_bind_and_node_ownership(self):
        import yaml
        root = Path(__file__).resolve().parents[1]
        class ComposeLoader(yaml.SafeLoader): pass
        ComposeLoader.add_constructor('!override', lambda loader, node: loader.construct_sequence(node))
        ComposeLoader.add_constructor('!reset', lambda loader, node: loader.construct_sequence(node))
        compose = yaml.load((root / 'selfhost/compose.qa.yml').read_text(), Loader=ComposeLoader)
        self.assertEqual(compose['services']['api-gw']['volumes'], [{
            'type': 'bind', 'source': './volumes/api/envoy/lds.qa.yaml',
            'target': '/etc/envoy/lds.template.yaml', 'read_only': True, 'bind': {'create_host_path': False},
        }])
        shell = (root / 'scripts/selfhost_host_guard.sh').read_text()
        self.assertIn('tar --no-same-owner -xJf "$node_archive"', shell)
        self.assertIn('fi\nchown -R root:root "$node_root"\nln -sfn', shell)
