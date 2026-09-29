"""First-run name squatting and persistent Entra ownership/credential controls."""
import contextlib
import hashlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import configure_oidc as oidc
from pooler import SafeFailure

GROUP = '/subscriptions/sub/resourceGroups/staging'
NAME = 'tonyai-staging-github-' + hashlib.sha256(GROUP.lower().encode()).hexdigest()[:12]


class OidcOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.saved = True
        self.named_apps = []
        self.app = {'appId':'client','displayName':NAME,'passwordCredentials':[],'keyCredentials':[]}
        self.principal = {'id':'principal','appId':'client','passwordCredentials':[],'keyCredentials':[]}
        self.owners = {'app':[], 'sp':[]}
        self.calls = []

    def az(self, *args):
        self.calls.append(args)
        if args[:2] == ('group','show'):
            return {'id':GROUP,'tags':{'environment':'staging', **({'githubClientId':'client'} if self.saved else {})}}
        if args[:3] == ('ad','signed-in-user','show'): return {'id':'operator'}
        if args[:3] == ('ad','app','list'): return self.named_apps
        if args[:3] in (('ad','app','show'),('ad','app','create')): return self.app
        if args[:3] == ('ad','sp','list'): return [self.principal] if self.saved else []
        if args[:3] in (('ad','sp','show'),('ad','sp','create')): return self.principal
        if args[:4] in (('ad','app','owner','list'),('ad','sp','owner','list')):
            owners = self.owners[args[1]]
            if isinstance(owners, Exception): raise owners
            return owners
        if args[:2] == ('group','update'): return {}
        if args[:4] == ('ad','app','federated-credential','list'): return []
        if args[:4] == ('ad','app','federated-credential','create'): return {}
        self.fail('Unexpected Azure call: '+str(args[:4]))

    def configure(self):
        with patch.object(oidc,'az',side_effect=self.az), contextlib.redirect_stdout(io.StringIO()):
            oidc.configure('sub','staging','owner/repo')

    def assert_no_federation(self):
        self.assertFalse(any(call[:4]==('ad','app','federated-credential','create') for call in self.calls))

    def test_first_run_refuses_even_an_owner_controlled_same_named_app(self):
        self.saved = False
        self.named_apps = [self.app]
        self.owners = {'app':[{'id':'operator'}], 'sp':[{'id':'operator'}]}
        with self.assertRaises(SafeFailure): self.configure()
        self.assert_no_federation()
        self.assertFalse(any(call[:2]==('group','update') or call[:3] in
                             (('ad','app','create'),('ad','sp','create')) for call in self.calls))

    def test_new_and_recorded_identities_allow_only_empty_or_operator_owners(self):
        for saved in (False, True):
            for owners in ([], [{'id':'operator'}]):
                with self.subTest(saved=saved,owners=owners):
                    self.saved = saved
                    self.owners = {'app':owners,'sp':owners}
                    self.calls.clear()
                    self.configure()
                    self.assertEqual(any(call[:3]==('ad','app','create') for call in self.calls), not saved)
                    self.assertTrue(any(call[:4]==('ad','app','federated-credential','create') for call in self.calls))

    def test_foreign_missing_mixed_or_unreadable_owners_stop_federation(self):
        for kind in ('app','sp'):
            for owners in ([{'id':'foreign'}], [{}], [{'id':'operator'},{'id':'foreign'}], None, SafeFailure('Owner lookup failed.')):
                with self.subTest(kind=kind,owners=owners):
                    self.owners = {'app':[],'sp':[]}
                    self.owners[kind] = owners
                    self.calls.clear()
                    with self.assertRaises(SafeFailure): self.configure()
                    self.assert_no_federation()
                    if kind == 'app':
                        self.assertFalse(any(call[:2]==('group','update') for call in self.calls))
                    else:
                        self.assertFalse(any('tags.githubPrincipalId=principal' in call for call in self.calls))

    def test_service_principal_password_certificate_or_missing_metadata_stops_federation(self):
        for saved, field in ((saved, field) for saved in (False, True)
                             for field in ('passwordCredentials','keyCredentials')):
            self.saved = saved
            for value in ([{'keyId':'synthetic-metadata'}], None, 'missing'):
                with self.subTest(field=field,value=value):
                    self.principal.update(passwordCredentials=[],keyCredentials=[])
                    if value == 'missing': self.principal.pop(field)
                    else: self.principal[field] = value
                    self.calls.clear()
                    with self.assertRaises(SafeFailure): self.configure()
                    self.assert_no_federation()
                    self.assertFalse(any('tags.githubPrincipalId=principal' in call for call in self.calls))
