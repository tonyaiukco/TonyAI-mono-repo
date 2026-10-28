"""Hosted exception attacks and shared paused-backend compatibility, without credentials."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from bootstrap_backend import bootstrap, validate
from foundation_contract import validate_email
from deployment_policy import require_hosted_target
from hosted_target import hosted_exception, require_hosted_backend
from pooler import SafeFailure
from test_backend import config

SUBSCRIPTION = 'cb7efc2f-37a7-4672-b62c-93c207bcd33d'
EXCEPTION = dict(subscription=SUBSCRIPTION, resource_group='tonyai-qatmp-apps', prefix='tonyaiqt',
                 backend_resource_group='tonyai-qatmp-tfstate', backend_storage_account='tonyaiqtteststate')


class HostedTargetTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'exception.json'
        self.path.write_text(json.dumps(EXCEPTION))
        self.patch = patch('hosted_target.EXCEPTION_PATH', self.path)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_exact_target_only(self):
        target = [SUBSCRIPTION, 'tonyai-qatmp-apps', 'tonyaiqt', 'staging']
        require_hosted_target(*target)
        for index, value in [(0, '00000000-0000-0000-0000-000000000001'),
                             (1, 'tonyai-staging-apps'), (1, 'tonyai-staging-data-r02'),
                             (1, 'tonyai-qatmp-apps-extra'), (2, 'tonyai'), (3, 'production')]:
            changed = target.copy(); changed[index] = value
            with self.subTest(index=index, value=value), self.assertRaises(SafeFailure):
                require_hosted_target(*changed)

    def test_missing_malformed_and_widened_exception_refused(self):
        for value in [None, [], {}, {**EXCEPTION, 'prefix': 'tonyai'},
                      {**EXCEPTION, 'resource_group': 'tonyai-staging-apps'},
                      {**EXCEPTION, 'backend_resource_group': 'tonyai-staging-state'},
                      {**EXCEPTION, 'backend_storage_account': 'tonyaistagingstate'},
                      {**EXCEPTION, 'extra': True}, {**EXCEPTION, 'subscription': '<uuid>'}]:
            self.path.write_text(json.dumps(value))
            with self.subTest(value=value), self.assertRaises(SafeFailure): hosted_exception()
        self.path.unlink()
        with self.assertRaises(SafeFailure): require_hosted_target(SUBSCRIPTION)

    def test_exact_backend_only(self):
        backend = {**config(), 'subscription_id': SUBSCRIPTION,
                   'resource_group': EXCEPTION['backend_resource_group'],
                   'storage_account': EXCEPTION['backend_storage_account']}
        require_hosted_backend(backend)
        for field, value in [('subscription_id', config()['subscription_id']),
                             ('resource_group', 'tonyai-staging-state'),
                             ('storage_account', 'tonyaistagingstate'),
                             ('storage_account', 'tonyaiqtother'), ('environment', 'production')]:
            with self.subTest(field=field, value=value), self.assertRaises(SafeFailure):
                require_hosted_backend({**backend, field: value})

    def test_paused_backend_shape_validation_stays_available_but_hosted_writer_refuses_it(self):
        backend = {**config(), 'subscription_id': SUBSCRIPTION, 'location': 'swedencentral'}
        validate(backend)  # replacement_bundle imports only this non-writing function.
        with self.assertRaises(SafeFailure): require_hosted_backend(backend)

    def test_bootstrap_rejects_paused_account_before_even_reading_arm(self):
        with patch('bootstrap_backend.azure_token') as token:
            from unittest.mock import Mock
            arm = Mock()
            backend = {**config(), 'subscription_id': SUBSCRIPTION, 'location': 'swedencentral'}
            with self.assertRaises(SafeFailure): bootstrap(backend, arm)
            arm.assert_not_called()
            token.assert_not_called()

    def test_terraform_never_initializes_wrong_backend(self):
        from test_deploy_versions import inputs
        from terraform_run import invoke
        contract = inputs()
        contract['foundation'].update(subscription_id=SUBSCRIPTION, resource_group='tonyai-qatmp-apps', prefix='tonyaiqt')
        release = Path(self.directory.name) / 'release.json'
        release.write_text(json.dumps(contract))
        backend = {**config(), 'subscription_id': SUBSCRIPTION,
                   'resource_group': EXCEPTION['backend_resource_group'],
                   'storage_account': EXCEPTION['backend_storage_account']}
        backend_path = Path(self.directory.name) / 'backend.json'
        for field, value in [('resource_group', 'tonyai-staging-state'), ('storage_account', 'tonyaistagingstate')]:
            backend_path.write_text(json.dumps({**backend, field: value}))
            with patch('terraform_run.subprocess.run') as run:
                with self.assertRaises(SafeFailure): invoke('application', backend_path, release, 'plan')
                run.assert_not_called()
        backend_path.write_text(json.dumps(backend))
        with patch('terraform_run.subprocess.run') as run:
            run.return_value.returncode = 0
            invoke('application', backend_path, release, 'plan')
            args = run.call_args_list[0].args[0]
            self.assertIn('-backend-config=storage_account_name=tonyaiqtteststate', args)

    def test_email_identity_contract_rejects_secrets_and_cross_tenant_or_shared_principals(self):
        foundation = dict(prefix='tonyaiqt', tenant_id=config()['tenant_id'], owner_object_id=config()['owner_object_id'])
        email = dict(client_id='00000000-0000-0000-0000-000000000010',
                     principal_id='00000000-0000-0000-0000-000000000011', tenant_id=foundation['tenant_id'])
        validate_email({**foundation, 'email': email})
        for change in [{'client_secret': 'synthetic'}, {'tenant_id': email['client_id']},
                       {'principal_id': foundation['owner_object_id']}, {'client_id': '<uuid>'},
                       {'custom_domain': '*.example.invalid'}, {'custom_domain_verified': True},
                       {'custom_domain_verified': 'true'}]:
            with self.subTest(change=change), self.assertRaises(SafeFailure):
                validate_email({**foundation, 'email': {**email, **change}})
        with self.assertRaises(SafeFailure): validate_email(foundation)
