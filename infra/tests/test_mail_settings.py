"""Mail release, secret and independent ARM boundaries without a cloud account."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from test_deploy_versions import inputs, app
from deploy_apps import verify
from terraform_run import validate_release
from mail_settings import mail_environment, verify_mail_environment, validate_smtp_password
from release_secrets import verify as verify_secrets, main as secret_main
from foundation_contract import validate_foundation
from pooler import SafeFailure


def mail():
    return {'host': 'smtp.example.invalid', 'port': 587, 'secure': False,
            'user': 'synthetic-user', 'from': 'sender@example.invalid', 'password_secret_version': 'c'*32}


class MailSettingsTests(unittest.TestCase):
    def test_complete_or_absent_and_no_secret_values(self):
        validate_release(inputs())
        for environment in ('staging', 'production'):
            value = inputs(); value['foundation']['environment'] = environment; value['release']['mail'] = mail()
            validate_release(value)
            self.assertEqual(mail_environment(*[value[k] for k in ('foundation', 'release')])['APP_URL'],
                             {'value': 'https://tonyai-' + environment + '-web.real.germanywestcentral.azurecontainerapps.io'})
        for field in mail():
            value = inputs(); value['release']['mail'] = mail(); del value['release']['mail'][field]
            with self.subTest(missing=field), self.assertRaises(SafeFailure): validate_release(value)
        bads = {'host': ['localhost', '127.0.0.1', 'smtp.localhost', 'https://smtp.example.invalid', '', 1, 'smtp\n.invalid'],
                'port': [True, 0, 65536, 1.5, '587', None], 'secure': [1, 'false', None],
                'user': ['', 'user\n', None], 'from': ['', 'bad', 'a@b\n.invalid'],
                'password_secret_version': ['latest', '', 'a'*31, None]}
        for field, values in bads.items():
            for bad in values:
                value = inputs(); value['release']['mail'] = {**mail(), field: bad}
                with self.subTest(field=field, bad=bad), self.assertRaises(SafeFailure): validate_release(value)
        for bad in (None, {}, [], {**mail(), 'password': 'synthetic'}, {**mail(), 'app_url': 'https://foreign.invalid'}):
            value = inputs(); value['release']['mail'] = bad
            with self.assertRaises(SafeFailure): validate_release(value)

    def test_every_mail_env_missing_changed_inline_or_duplicate_and_web_refused(self):
        value = inputs(); value['release']['mail'] = mail()
        f, r = value['foundation'], value['release']
        good = [{'name': k, **v} for k, v in mail_environment(f, r).items()]
        verify_mail_environment(good, f, r, 'api')
        for i, item in enumerate(good):
            for defect in ('missing', 'wrong', 'both', 'duplicate'):
                bad = copy.deepcopy(good)
                if defect == 'missing': bad.pop(i)
                if defect == 'wrong': bad[i][next(k for k in item if k != 'name')] = 'wrong'
                if defect == 'both': bad[i]['value' if 'secretRef' in item else 'secretRef'] = 'inline-secret'
                if defect == 'duplicate': bad.append(item)
                with self.subTest(item=item['name'], defect=defect), self.assertRaises(SafeFailure):
                    verify_mail_environment(bad, f, r, 'api')
        for kind, release in [('web', r), ('api', inputs()['release'])]:
            with self.assertRaises(SafeFailure): verify_mail_environment(good, f, release, kind)

    def test_arm_mail_secret_exact_version_identity_and_no_inline_value(self):
        value = inputs(); value['release']['mail'] = mail()
        for defect in ('none', 'version', 'identity', 'inline', 'missing', 'env-missing', 'env-inline', 'web-env'):
            state = {kind: app(kind, value) for kind in ('api', 'web')}
            api = state['api']['properties']
            api['template']['containers'][0]['env'] += [{'name': k, **v} for k,v in mail_environment(value['foundation'], value['release']).items()]
            secret = {**api['configuration']['secrets'][0], 'name': 'smtp-password',
                      'keyVaultUrl': 'https://vault.vault.azure.net/secrets/smtp-password/' + 'c'*32}
            if defect == 'version': secret['keyVaultUrl'] += '0'
            if defect == 'identity': secret['identity'] = 'web-identity'
            if defect == 'inline': secret['value'] = 'synthetic'
            if defect != 'missing': api['configuration']['secrets'].append(secret)
            if defect == 'env-missing': api['template']['containers'][0]['env'].pop()
            if defect == 'env-inline':
                next(e for e in api['template']['containers'][0]['env'] if e['name'] == 'SMTP_PASSWORD')['value'] = 'synthetic'
            if defect == 'web-env': state['web']['properties']['template']['containers'][0]['env'].append({'name': 'SMTP_HOST', 'value': 'smtp.example.invalid'})
            def read(*args):
                if args[:3] == ('containerapp', 'revision', 'list'): return [{'name': 'tonyai-staging-api--r001', 'properties': {'active': True}}]
                return state['api' if args[-1].endswith('-api') else 'web']
            with self.subTest(defect=defect), contextlib.redirect_stdout(io.StringIO()):
                if defect == 'none': verify(value, read)
                else:
                    with self.assertRaises(SafeFailure): verify(value, read)

    def test_password_hidden_store_and_exact_version_verification(self):
        value = inputs(); value['release']['mail'] = mail()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.json'; path.write_text(json.dumps(value))
            vault = Mock(); vault.put.return_value = 'https://vault.vault.azure.net/secrets/smtp-password/' + 'c'*32
            output = io.StringIO()
            with patch('sys.argv', ['release_secrets.py', 'store', '--inputs', str(path), '--name', 'smtp-password']), patch('sys.stdin.isatty', return_value=True), patch('release_secrets.getpass.getpass', return_value='synthetic-password'), patch('release_secrets.Vault', return_value=vault), patch('release_secrets.validate_backend') as backend, contextlib.redirect_stdout(output):
                secret_main()
                backend.assert_not_called()
                self.assertEqual(vault.put.call_args.args[:2], ('smtp-password', 'synthetic-password'))
            self.assertNotIn('synthetic-password', output.getvalue())
        for password in ('synthetic-password', '', '\n', None):
            vault = Mock(); vault.get.side_effect = [{'value':'db'}, {'value':'backend'}, {'value':password}]
            with patch('release_secrets.Vault', return_value=vault), patch('release_secrets.validate_pooler'), patch('release_secrets.validate_backend'), contextlib.redirect_stdout(io.StringIO()):
                if password == 'synthetic-password': verify_secrets(value)
                else:
                    with self.assertRaises(SafeFailure): verify_secrets(value)
            self.assertEqual(vault.get.call_args.args, ('smtp-password', 'c'*32))
            vault.identifier.assert_called_with({'value':password}, 'smtp-password', 'c'*32)
        for bad in ('', ' ', 'a\nb', 'a\rb', None):
            with self.assertRaises(SafeFailure): validate_smtp_password(bad)

    def test_foundation_smtp_switch_is_typed(self):
        config = {'subscription_id': '00000000-0000-0000-0000-000000000001', 'tenant_id': '00000000-0000-0000-0000-000000000002', 'owner_object_id': '00000000-0000-0000-0000-000000000003', 'environment': 'staging', 'prefix': 'tonyai', 'resource_group': 'staging', 'registry_name': 'registry', 'vault_name': 'vault', 'repository': 'owner/repo', 'release_sha': 'a'*40}
        for ready in (True, False): validate_foundation({'config': {**config, 'smtp_secret_ready': ready}})
        for bad in ('true', 1, None):
            with self.assertRaises(SafeFailure): validate_foundation({'config': {**config, 'smtp_secret_ready': bad}})
