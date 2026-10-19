"""Exercise the real boundary validator with Compose's rendered bind defaults."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import r3_qualification as qualification
from test_selfhost_runtime import config as boundary_config


def effective_config():
    """Synthetic credentials, real image pins and the complete service contract.

    This is a JSON-shape fixture, not captured runtime output or a Compose render.
    Compose 2.38.2 uses compose-go 2.7.1: ServiceVolumeBind.CreateHostPath is a
    bool with json omitempty, so a non-null bind object can omit its false field.
    https://github.com/compose-spec/compose-go/blob/v2.7.1/types/types.go
    """
    lock = json.loads((qualification.ROOT / 'infra/selfhost/images.qa.lock.json').read_bytes())['services']
    config = boundary_config()
    for name, pin in lock.items():
        service = config['services'].setdefault(name, {})
        service.update(pin, restart='no')
        for volume in service.get('volumes', []):
            volume['type'] = 'bind'
    for name in ('caddy', 'functions', 'supavisor'):
        config['services'][name]['profiles'] = ['https' if name == 'caddy' else 'unused']
    config['services']['realtime']['environment'] = {'DB_ENC_WRITE_GCM': 'true', 'DB_ENC_KEY_GCM': 'a' * 32}
    return config, lock


def mounts(config):
    return [volume for service in config['services'].values() for volume in service.get('volumes', [])]


class ComposeValidation(unittest.TestCase):
    def test_compose_2382_omits_false_in_present_bind_object(self):
        config, lock = effective_config()
        for volume in mounts(config):
            del volume['bind']['create_host_path']
        original = copy.deepcopy(config)
        qualification.check_effective(config, lock, compose_version='2.38.2')
        self.assertEqual(config, original, 'Normalization must not modify the supplied rendered evidence')

    def test_explicit_false_remains_valid_without_a_version_exception(self):
        for version in (None, '2.38.2', '5.6.0', 'unknown'):
            with self.subTest(version=version):
                config, lock = effective_config()
                qualification.check_effective(config, lock, compose_version=version)

    def test_omitted_default_is_not_assumed_for_other_versions(self):
        for version in (None, '', '2.38.1', '2.38.3', 'v2.38.2', '5.6.0', 'unknown'):
            for index in range(len(mounts(effective_config()[0]))):
                with self.subTest(version=version, mount=index):
                    config, lock = effective_config()
                    del mounts(config)[index]['bind']['create_host_path']
                    with self.assertRaises(ValueError):
                        qualification.check_effective(config, lock, compose_version=version)

    def test_unsafe_or_ambiguous_bind_shapes_are_not_normalized(self):
        for index in range(len(mounts(effective_config()[0]))):
            for fault in ('true', 'null', 'string', 'zero', 'missing-bind', 'null-bind', 'wrong-type', 'missing-type'):
                with self.subTest(mount=index, fault=fault):
                    config, lock = effective_config()
                    volume = mounts(config)[index]
                    if fault in ('true', 'null', 'string', 'zero'):
                        volume['bind']['create_host_path'] = {'true': True, 'null': None, 'string': 'false', 'zero': 0}[fault]
                    elif fault == 'missing-bind':
                        del volume['bind']
                    elif fault == 'null-bind':
                        volume['bind'] = None
                    else:
                        del volume['bind']['create_host_path']
                        if fault == 'wrong-type': volume['type'] = 'volume'
                        else: del volume['type']
                    with self.assertRaises((ValueError, AttributeError)):
                        qualification.check_effective(config, lock, compose_version='2.38.2')

    def test_normalization_keeps_boundary_and_r02_checks_live(self):
        for fault in ('public-gateway', 'wrong-disk', 'signup', 'image', 'restart', 'profile', 'gcm'):
            with self.subTest(fault=fault):
                config, lock = effective_config()
                for volume in mounts(config): del volume['bind']['create_host_path']
                services = config['services']
                if fault == 'public-gateway': services['api-gw']['ports'][0]['host_ip'] = '0.0.0.0'
                if fault == 'wrong-disk': services['db']['volumes'][0]['source'] = '/foreign'
                if fault == 'signup': services['auth']['environment']['GOTRUE_DISABLE_SIGNUP'] = 'false'
                if fault == 'image': services['db']['image'] = 'unreviewed:latest'
                if fault == 'restart': services['db']['restart'] = 'always'
                if fault == 'profile': del services['caddy']['profiles']
                if fault == 'gcm': services['realtime']['environment']['DB_ENC_KEY_GCM'] = 'short'
                with self.assertRaises(ValueError):
                    qualification.check_effective(config, lock, compose_version='2.38.2')


if __name__ == '__main__':
    unittest.main()
