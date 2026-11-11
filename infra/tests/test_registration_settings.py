"""Registration release, secret and independent ARM boundaries without a cloud account."""
import contextlib
import copy
import io
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import Mock, patch
from test_deploy_versions import inputs, app
from deploy_apps import verify
from terraform_run import validate_release
from registration_settings import (CODE_PATTERN, PUBLISHED_CODES, REGISTRATION_ENV, registration_environment,
                                   validate_registration_code, verify_registration_environment)
from release_secrets import verify as verify_secrets, main as secret_main
from foundation_contract import validate_foundation
from pooler import SafeFailure

ROOT = Path(__file__).resolve().parents[2]
CODE = 'aB3x9'


def registration(allow=True):
    return {'code_secret_version': 'd' * 32, 'allow_placeholder_consent': allow}


def release(environment='staging', allow=True):
    value = inputs()
    value['foundation']['environment'] = environment
    value['release']['registration'] = registration(allow)
    return value


class RegistrationSettingsTests(unittest.TestCase):
    def test_absent_block_changes_nothing_and_a_complete_one_is_accepted(self):
        plain = inputs()
        self.assertEqual(validate_release(copy.deepcopy(plain)), (plain['foundation'], plain['release']))
        self.assertEqual(registration_environment(plain['foundation'], plain['release']), {})
        for environment, allow in (('staging', True), ('staging', False), ('production', False)):
            value = release(environment, allow)
            with self.subTest(environment=environment, allow=allow):
                validate_release(value)
                self.assertEqual(registration_environment(value['foundation'], value['release']), {
                    'REGISTRATION_CODE': {'secretRef': 'registration-code'},
                    'REGISTRATION_ALLOW_PLACEHOLDER_CONSENT': {'value': 'true' if allow else 'false'}})

    def test_placeholder_allowance_is_refused_outside_staging(self):
        with self.assertRaises(SafeFailure) as caught:
            validate_release(release('production', True))
        self.assertIn('staging only', str(caught.exception))

    def test_block_needs_its_exact_fields_and_never_a_code_value(self):
        for field in registration():
            value = release(); del value['release']['registration'][field]
            with self.subTest(missing=field), self.assertRaises(SafeFailure): validate_release(value)
        bads = {'code_secret_version': ['latest', '', 'd' * 31, 'd' * 33, 'D' * 32, 'd' * 32 + '\n', '\n' + 'd' * 32, CODE, None, 1],
                'allow_placeholder_consent': ['true', 1, 0, None]}
        for field, values in bads.items():
            for bad in values:
                value = release(); value['release']['registration'][field] = bad
                with self.subTest(field=field, bad=bad):
                    with self.assertRaises(SafeFailure) as caught: validate_release(value)
                    self.assertNotIn(CODE, str(caught.exception))
        for bad in (None, {}, [], 'on', {**registration(), 'code': CODE}, {**registration(), 'REGISTRATION_CODE': CODE}):
            value = inputs(); value['release']['registration'] = bad
            with self.subTest(bad=bad):
                with self.assertRaises(SafeFailure) as caught: validate_release(value)
                self.assertNotIn(CODE, str(caught.exception))
        # An unknown top-level key is still refused: the block did not loosen the manifest.
        value = inputs(); value['release']['registration_code'] = CODE
        with self.assertRaises(SafeFailure): validate_release(value)

    def test_code_shape_is_the_one_the_api_accepts_and_a_refusal_never_repeats_it(self):
        source = (ROOT / 'packages/shared-types/src/index.ts').read_text()
        declared = re.search(r'^export const REGISTRATION_CODE_PATTERN = /\^(.+)\$/;$', source, re.M)
        self.assertIsNotNone(declared, 'REGISTRATION_CODE_PATTERN moved or changed form')
        self.assertEqual(declared.group(1), CODE_PATTERN)
        for good in (CODE, 'Local', '00000', 'ZZZZZ'):
            validate_registration_code(good)
        for bad in ('aB3x', 'aB3x9z', 'aB3 9', 'aB3-9', 'aB3_9', 'aB3x9\n', ' aB3x', 'ğB3x9', '', None, 12345, ['a'] * 5):
            with self.subTest(bad=bad):
                with self.assertRaises(SafeFailure) as caught: validate_registration_code(bad)
                if isinstance(bad, str) and bad.strip(): self.assertNotIn(bad.strip(), str(caught.exception))

    def test_published_development_code_is_refused_for_a_vault(self):
        # The local default is in the repository for everyone to read.
        root_files = [(ROOT / 'apps/api/.env.example').read_text(), (ROOT / 'scripts/bootstrap.sh').read_text()]
        published = {m for text in root_files for m in re.findall(r'^REGISTRATION_CODE=(\S+)$', text, re.M)}
        self.assertEqual(published, set(PUBLISHED_CODES), 'a code published in the repository must be refused for a vault')
        for code in PUBLISHED_CODES:
            with self.subTest(code=code):
                with self.assertRaises(SafeFailure) as caught: validate_registration_code(code)
                self.assertIn('published development default', str(caught.exception))

    def test_every_registration_env_missing_changed_inline_or_duplicate_and_web_refused(self):
        for allow in (True, False):
            value = release(allow=allow)
            f, r = value['foundation'], value['release']
            good = [{'name': k, **v} for k, v in registration_environment(f, r).items()]
            self.assertEqual({item['name'] for item in good}, REGISTRATION_ENV)
            verify_registration_environment(good, f, r, 'api')
            for i, item in enumerate(good):
                for defect in ('missing', 'wrong', 'both', 'duplicate'):
                    bad = copy.deepcopy(good)
                    if defect == 'missing': bad.pop(i)
                    if defect == 'wrong': bad[i][next(k for k in item if k != 'name')] = 'wrong'
                    if defect == 'both': bad[i]['value' if 'secretRef' in item else 'secretRef'] = CODE
                    if defect == 'duplicate': bad.append(item)
                    with self.subTest(allow=allow, item=item['name'], defect=defect), self.assertRaises(SafeFailure):
                        verify_registration_environment(bad, f, r, 'api')
            # The allowance is held to its exact released value, not merely to "present".
            flipped = copy.deepcopy(good)
            next(e for e in flipped if e['name'] == 'REGISTRATION_ALLOW_PLACEHOLDER_CONSENT')['value'] = 'false' if allow else 'true'
            with self.assertRaises(SafeFailure): verify_registration_environment(flipped, f, r, 'api')
            # Never on the web app, and never on an API whose release names no registration.
            for kind, rel in [('web', r), ('api', inputs()['release'])]:
                with self.subTest(kind=kind), self.assertRaises(SafeFailure): verify_registration_environment(good, f, rel, kind)
        # Without the block, an API and a web app with no registration setting pass.
        plain = inputs()
        for kind in ('api', 'web'):
            verify_registration_environment([{'name': 'PORT', 'value': '3001'}], plain['foundation'], plain['release'], kind)

    def live(self, value, defect='none', released=True):
        state = {kind: app(kind, value) for kind in ('api', 'web')}
        api = state['api']['properties']
        env = api['template']['containers'][0]['env']
        if released or defect == 'unreleased':
            source = value if 'registration' in value['release'] else release()
            env += [{'name': k, **v} for k, v in registration_environment(source['foundation'], source['release']).items()]
            secret = {**api['configuration']['secrets'][0], 'name': 'registration-code',
                      'keyVaultUrl': 'https://vault.vault.azure.net/secrets/registration-code/' + 'd' * 32}
            if defect == 'version': secret['keyVaultUrl'] += '0'
            if defect == 'identity': secret['identity'] = 'web-identity'
            if defect == 'inline': secret['value'] = CODE
            if defect != 'missing': api['configuration']['secrets'].append(secret)
        if defect == 'env-missing': env[:] = [e for e in env if e['name'] != 'REGISTRATION_CODE']
        if defect == 'env-inline': next(e for e in env if e['name'] == 'REGISTRATION_CODE')['value'] = CODE
        if defect == 'allowance': next(e for e in env if e['name'] == 'REGISTRATION_ALLOW_PLACEHOLDER_CONSENT')['value'] = 'false'
        if defect == 'web-env':
            state['web']['properties']['template']['containers'][0]['env'].append({'name': 'REGISTRATION_ALLOW_PLACEHOLDER_CONSENT', 'value': 'true'})
        def read(*args):
            if args[:3] == ('containerapp', 'revision', 'list'): return [{'name': 'tonyai-staging-api--r001', 'properties': {'active': True}}]
            return state['api' if args[-1].endswith('-api') else 'web']
        return read

    def test_arm_registration_secret_exact_version_identity_and_no_inline_value(self):
        value = release()
        for defect in ('none', 'version', 'identity', 'inline', 'missing', 'env-missing', 'env-inline', 'allowance', 'web-env'):
            with self.subTest(defect=defect), contextlib.redirect_stdout(io.StringIO()):
                if defect == 'none': verify(value, self.live(value))
                else:
                    with self.assertRaises(SafeFailure): verify(value, self.live(value, defect))

    def test_arm_readback_refuses_registration_the_release_does_not_name(self):
        plain = inputs()
        with contextlib.redirect_stdout(io.StringIO()):
            verify(plain, self.live(plain, released=False))
            with self.assertRaises(SafeFailure): verify(plain, self.live(plain, 'unreleased', released=False))

    def test_code_hidden_store_and_exact_version_verification(self):
        value = release()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'; path.write_text(json.dumps(value))
            for entered, stored in ((CODE, True), ('aB3x', False), ('aB3x9z', False), ('aB3 9', False), ('', False)):
                vault = Mock(); vault.put.return_value = 'https://vault.vault.azure.net/secrets/registration-code/' + 'd' * 32
                output = io.StringIO()
                with self.subTest(entered=entered), patch('sys.argv', ['release_secrets.py', 'store', '--inputs', str(path), '--name', 'registration-code']), patch('sys.stdin.isatty', return_value=True), patch('release_secrets.getpass.getpass', return_value=entered), patch('release_secrets.Vault', return_value=vault), patch('release_secrets.validate_backend') as backend, contextlib.redirect_stdout(output):
                    if stored:
                        secret_main()
                        self.assertEqual(vault.put.call_args.args[:2], ('registration-code', CODE))
                    else:
                        with self.assertRaises(SafeFailure) as caught: secret_main()
                        vault.put.assert_not_called()
                        if entered: self.assertNotIn(entered, str(caught.exception))
                    # Never validated as a Supabase key, the fallback for a name the tool does not know.
                    backend.assert_not_called()
                if entered: self.assertNotIn(entered, output.getvalue())
        for code in (CODE, 'aB3x', 'aB3x9z', '', None):
            vault = Mock(); vault.get.side_effect = [{'value': 'db'}, {'value': 'backend'}, {'value': code}]
            output = io.StringIO()
            with self.subTest(code=code), patch('release_secrets.Vault', return_value=vault), patch('release_secrets.validate_pooler'), patch('release_secrets.validate_backend'), contextlib.redirect_stdout(output):
                if code == CODE: verify_secrets(value)
                else:
                    with self.assertRaises(SafeFailure): verify_secrets(value)
            self.assertEqual(vault.get.call_args.args, ('registration-code', 'd' * 32))
            vault.identifier.assert_called_with({'value': code}, 'registration-code', 'd' * 32)
            self.assertNotIn(CODE, output.getvalue())
        # A missing version is refused before its value is looked at.
        vault = Mock(); vault.get.side_effect = [{'value': 'db'}, {'value': 'backend'}, None]
        with patch('release_secrets.Vault', return_value=vault), patch('release_secrets.validate_pooler'), patch('release_secrets.validate_backend'), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SafeFailure):
            verify_secrets(value)
        # So is a disabled one, another vault's, and a different version than the release names —
        # through the real vault client, with only its transport stubbed.
        def record(name, version):
            return {'id': 'https://vault.vault.azure.net/secrets/' + name + '/' + version, 'attributes': {'enabled': True},
                    'value': CODE if name == 'registration-code' else 'synthetic'}
        code = record('registration-code', 'd' * 32)
        for label, change in (('enabled', {}), ('disabled', {'attributes': {'enabled': False}}),
                              ('foreign vault', {'id': code['id'].replace('vault.vault', 'foreign.vault')}),
                              ('another version', {'id': code['id'][:-32] + 'e' * 32})):
            def answer(url, *args, **kwargs):
                for name, version in (('database-url', 'a' * 32), ('supabase-service-role-key', 'b' * 32)):
                    if '/' + name + '/' in url: return record(name, version)
                return {**code, **change}
            output = io.StringIO()
            with self.subTest(version=label), patch('secure_transport.azure_token', return_value='synthetic'), patch('secure_transport.json_request', side_effect=answer) as request, patch('release_secrets.validate_pooler'), patch('release_secrets.validate_backend'), contextlib.redirect_stdout(output):
                if label == 'enabled': verify_secrets(value)
                else:
                    with self.assertRaises(SafeFailure) as caught: verify_secrets(value)
                    self.assertIn('disabled vault version', str(caught.exception))
                self.assertIn('/registration-code/' + 'd' * 32 + '?', request.call_args.args[0])
                self.assertNotIn(CODE, output.getvalue())
        # A release without the block asks the vault for no registration code.
        vault = Mock(); vault.get.side_effect = [{'value': 'db'}, {'value': 'backend'}]
        with patch('release_secrets.Vault', return_value=vault), patch('release_secrets.validate_pooler'), patch('release_secrets.validate_backend'), contextlib.redirect_stdout(io.StringIO()):
            verify_secrets(inputs())
        self.assertEqual([call.args[0] for call in vault.get.call_args_list], ['database-url', 'supabase-service-role-key'])

    def test_foundation_registration_switch_is_typed(self):
        config = {'subscription_id': '00000000-0000-0000-0000-000000000001', 'tenant_id': '00000000-0000-0000-0000-000000000002', 'owner_object_id': '00000000-0000-0000-0000-000000000003', 'environment': 'staging', 'prefix': 'tonyai', 'resource_group': 'staging', 'registry_name': 'registry', 'vault_name': 'vault', 'repository': 'owner/repo', 'release_sha': 'a'*40}
        validate_foundation({'config': dict(config)})
        for ready in (True, False): validate_foundation({'config': {**config, 'registration_secret_ready': ready}})
        for bad in ('true', 1, None):
            with self.subTest(bad=bad), self.assertRaises(SafeFailure): validate_foundation({'config': {**config, 'registration_secret_ready': bad}})
        with self.assertRaises(SafeFailure): validate_foundation({'config': {**config, 'registration_code': CODE}})

    def test_example_manifest_names_the_block_in_the_shape_a_release_accepts(self):
        example = json.loads((ROOT / 'infra/config/application.example.json').read_text())
        self.assertEqual(set(example['release']['registration']), {'code_secret_version', 'allow_placeholder_consent'})
        self.assertIs(example['release']['registration']['allow_placeholder_consent'], True)
        # The allowance it shows is only valid where the example says it is deployed.
        self.assertEqual(example['foundation']['environment'], 'staging')
        self.assertEqual(set(example['release']) - {'runtime_limits', 'mail', 'registration'}, set(inputs()['release']))
        value = inputs(); value['release']['registration'] = {**example['release']['registration'], 'code_secret_version': 'd' * 32}
        validate_release(value)


if __name__ == '__main__':
    unittest.main()
