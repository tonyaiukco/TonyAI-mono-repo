"""Synthetic credential transactions only; no live environment or cloud access."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from dashboard_rotation_store import Store, create, digest, read
from selfhost_dashboard_rotation import Rotation, credentials, marker_valid

OLD = b'synthetic-old-canary'
NEW = 'ab' * 32
ENV = b"OTHER='synthetic-other-canary'\nDASHBOARD_USERNAME='tonyaiops'\nDASHBOARD_PASSWORD='" + OLD + b"'\nTAIL='unchanged'\n"


class FakeRuntime:
    def __init__(self):
        self.events = []
        self.source = {'source': 'reviewed-source'}
        self.containers = {'api-gw': {'id':'original', 'running':False}, 'db': {'id':'database'}}
        self.password = OLD
        self.fail = None

    def sources(self): return copy.deepcopy(self.source)
    def configuration(self, username, password, gateway_id=None): return 'stable-effective-config'
    def inventory(self): return copy.deepcopy(self.containers)
    def require_stopped(self, inventory, password):
        if inventory['api-gw']['running'] or password != self.password: raise ValueError('Not stopped.')
    def require_dependencies(self, original):
        if original['db'] != self.containers['db']: raise ValueError('Dependency drift.')
    def recreate(self):
        self.events.append('recreate')
        if self.fail == 'recreate': raise ValueError('synthetic-output-must-not-escape')
        self.containers['api-gw'] = {'id':'replacement','running':True}
        self.password = NEW.encode()
    def verify(self, username, password, old, original):
        self.events.append('verify')
        if self.fail == 'verify': raise ValueError('synthetic-output-must-not-escape')
        assert (username,password)==(b'tonyaiops',NEW.encode()) and old in (OLD,None)
    def stop(self):
        self.events.append('stop')
        self.containers['api-gw']['running'] = False


class RotationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        root.chmod(0o700)
        runtime = root/'runtime'; runtime.mkdir(mode=0o700)
        control = root/'control'; control.mkdir(mode=0o700)
        self.store = Store(runtime,control/'rotation',control/'escrow.json',uid=os.getuid(),anchor=root)
        create(self.store.env,ENV)
        self.mark('a'*32, ENV)
        self.runtime = FakeRuntime()
        self.rotation = Rotation(self.store,self.runtime)

    def mark(self, version, data, vault='https://tonyai-qa-rec-12345678.vault.azure.net'):
        value = dict(version=version,vault=vault,sha256=digest(data))
        self.store.marker.write_text(json.dumps(value)); self.store.marker.chmod(0o600)

    def prepare(self):
        with self.store.locked(), patch('selfhost_dashboard_rotation.secrets.token_hex',return_value=NEW) as generate:
            self.rotation.prepare()
        return generate

    def escrow(self): self.mark('b'*32,self.store.environment())

    def test_only_dashboard_bytes_change_and_entropy_source_is_32_bytes(self):
        generate = self.prepare()
        generate.assert_called_once_with(32)
        self.assertEqual(self.store.environment(), ENV.replace(OLD,NEW.encode()))
        self.assertEqual(self.runtime.events,[])
        journal = self.store.read('journal.json')
        for sentinel in (OLD,NEW.encode(),b'synthetic-other-canary'):
            self.assertNotIn(sentinel,journal)
        self.assertEqual(self.store.journal()['phase'],'awaiting-escrow')
        self.assertEqual(self.store.env.stat().st_mode & 0o777,0o600)

    def test_prepare_retry_never_generates_again(self):
        self.prepare()
        with self.store.locked(), patch('selfhost_dashboard_rotation.secrets.token_hex',side_effect=AssertionError('must not regenerate')):
            self.rotation.prepare()
        self.assertEqual(self.store.environment(), ENV.replace(OLD,NEW.encode()))

    def test_running_gateway_refused_before_generation_or_environment_write(self):
        self.runtime.containers['api-gw']['running']=True
        with patch('selfhost_dashboard_rotation.secrets.token_hex') as generate, self.assertRaises(ValueError):
            with self.store.locked(): self.rotation.prepare()
        generate.assert_not_called()
        self.assertEqual(self.store.environment(),ENV)

    def test_old_escrow_mismatch_refused(self):
        self.mark('a'*32,b'wrong')
        with self.assertRaises(ValueError): self.prepare()
        self.assertEqual(self.store.environment(),ENV)

    def test_prepare_binds_gateway_environment_before_generating_or_writing(self):
        def reject_drift(username,password,gateway_id=None):
            self.assertEqual(gateway_id,'original')
            raise ValueError('Unrelated live environment drift.')
        with patch.object(self.runtime,'configuration',side_effect=reject_drift), \
             patch('selfhost_dashboard_rotation.secrets.token_hex') as generate,self.assertRaises(ValueError):
            with self.store.locked():self.rotation.prepare()
        generate.assert_not_called()
        self.assertEqual(self.store.environment(),ENV)
        self.assertEqual(set(p.name for p in self.store.directory.iterdir()),{'lock'})

    def test_ambiguous_dotenv_forms_refused_without_sourcing(self):
        candidates=[ENV+b"DASHBOARD_PASSWORD='duplicate'\n", ENV.replace(b"DASHBOARD_PASSWORD=",b"export DASHBOARD_PASSWORD="),
                    ENV.replace(b"DASHBOARD_PASSWORD='",b'DASHBOARD_PASSWORD="'), ENV.replace(OLD,b''),
                    ENV.replace(b'\n',b'\r\n'), ENV.replace(b'tonyaiops',b'user:colon'),
                    ENV.replace(OLD,b'first\nsecond'),ENV.replace(OLD,b"first'quote")]
        for data in candidates:
            with self.subTest(data=data),self.assertRaises(ValueError): credentials(data)
        # Command substitution is data, never executed by this parser.
        self.assertEqual(credentials(ENV.replace(OLD,b'$(false)'))[1],b'$(false)')

    def test_escrow_gates_every_activation(self):
        self.prepare()
        for version,payload,vault in [('a'*32,self.store.environment(),'https://tonyai-qa-rec-12345678.vault.azure.net'),
                                      ('bad',self.store.environment(),'https://tonyai-qa-rec-12345678.vault.azure.net'),
                                      ('b'*32,ENV,'https://tonyai-qa-rec-12345678.vault.azure.net'),
                                      ('b'*32,self.store.environment(),'https://tonyai-qa-rec-87654321.vault.azure.net')]:
            self.mark(version,payload,vault)
            with self.subTest(version=version,vault=vault),self.assertRaises(ValueError):
                with self.store.locked():self.rotation.activate()
            self.assertEqual(self.runtime.events,[])

    def test_source_configuration_and_dependency_drift_refused(self):
        self.prepare(); self.escrow()
        for kind in ('source','config','dependency','environment'):
            with self.subTest(kind=kind):
                with patch.object(self.runtime,'sources',return_value={} if kind=='source' else self.runtime.sources()), \
                     patch.object(self.runtime,'configuration',return_value='changed' if kind=='config' else 'stable-effective-config'):
                    if kind=='dependency':self.runtime.containers['db']['id']='changed'
                    if kind=='environment':self.store.env.write_bytes(ENV)
                    with self.assertRaises(ValueError),self.store.locked():self.rotation.activate()
                    self.assertEqual(self.runtime.events,[])
                    self.runtime.containers['db']['id']='database'
                    self.store.env.write_bytes(ENV.replace(OLD,NEW.encode()))

    def test_activation_is_narrow_and_never_closes_integrity_gate(self):
        self.prepare();self.escrow()
        with self.store.locked():result=self.rotation.activate()
        self.assertEqual(self.runtime.events,['recreate','verify'])
        self.assertIn('integrity acceptance remains OPEN',result)
        self.assertEqual(self.store.journal()['phase'],'credential-verified')

    def test_activation_failures_stop_gateway_retain_new_environment_and_resume(self):
        for failure in ('recreate','verify'):
            with self.subTest(failure=failure):
                self.setUp()
                self.prepare();self.escrow();self.runtime.fail=failure
                with self.assertRaisesRegex(ValueError,'Activation failed'),self.store.locked(): self.rotation.activate()
                self.assertEqual(self.runtime.events[-1],'stop')
                self.assertFalse(self.runtime.containers['api-gw']['running'])
                self.assertEqual(self.store.environment(),ENV.replace(OLD,NEW.encode()))
                self.assertEqual(self.store.journal()['phase'],'activating')
                self.runtime.fail=None
                with self.store.locked():self.rotation.activate()
                self.assertEqual(self.store.journal()['phase'],'credential-verified')

    def test_finalize_removes_only_temporary_secrets_and_is_repeatable(self):
        self.prepare();self.escrow()
        with self.store.locked():
            with self.assertRaises(ValueError):self.rotation.finalize()
            self.rotation.activate(); self.rotation.finalize(); self.rotation.finalize()
        self.assertFalse((self.store.directory/'previous-password').exists())
        self.assertFalse((self.store.directory/'next.env').exists())
        self.assertTrue((self.store.directory/'journal.json').exists())
        self.assertEqual(self.store.environment(),ENV.replace(OLD,NEW.encode()))

    def test_verification_journal_failure_requests_containment(self):
        self.prepare();self.escrow()
        original=self.store.write_journal
        def fail_verified(value):
            if value['phase']=='credential-verified':raise OSError('synthetic disk failure')
            original(value)
        with self.store.locked(),patch.object(self.store,'write_journal',side_effect=fail_verified),self.assertRaises(ValueError):
            self.rotation.activate()
        self.assertEqual(self.runtime.events[-1],'stop')
        self.assertEqual(self.store.journal()['phase'],'activating')

    def test_crash_after_atomic_install_resumes_without_regeneration(self):
        original=self.store.write_journal
        def fail_after_replace(value):
            if value['phase']=='awaiting-escrow':raise OSError('synthetic crash')
            original(value)
        with patch.object(self.store,'write_journal',side_effect=fail_after_replace),self.assertRaises(OSError):self.prepare()
        self.assertEqual(self.store.journal()['phase'],'prepared')
        self.assertEqual(self.store.environment(),ENV.replace(OLD,NEW.encode()))
        with self.store.locked(),patch('selfhost_dashboard_rotation.secrets.token_hex',side_effect=AssertionError('no new password')):
            self.rotation.prepare()
        self.assertEqual(self.store.journal()['phase'],'awaiting-escrow')

    def test_partial_staging_refuses_retry_without_overwriting_anything(self):
        with self.store.locked():create(self.store.directory/'previous-password',OLD)
        with self.assertRaises(ValueError):self.prepare()
        self.assertEqual(self.store.environment(),ENV)
        self.assertEqual(self.store.read('previous-password'),OLD)

    def test_symlink_hardlink_world_readable_and_oversize_environment_refused(self):
        original=self.store.env
        backup=self.store.runtime/'original';original.rename(backup)
        for kind in ('symlink','hardlink','mode','large'):
            with self.subTest(kind=kind):
                if kind=='symlink':original.symlink_to(backup)
                elif kind=='hardlink':os.link(backup,original)
                else:create(original,b'x'*65537 if kind=='large' else ENV)
                if kind=='mode':original.chmod(0o644)
                with self.assertRaises(ValueError):self.store.environment()
                original.unlink()
        backup.rename(original)

    def test_lock_contention_refused(self):
        with self.store.locked():
            with self.assertRaises(BlockingIOError):
                with self.store.locked():pass

    def test_atomic_replacement_race_and_orphan_journal_fail_closed(self):
        with self.store.locked():
            create(self.store.directory/'next.env',ENV.replace(OLD,NEW.encode()))
            with self.assertRaises(ValueError):self.store.install('wrong-hash')
            self.assertEqual(self.store.environment(),ENV)
            create(self.store.directory/'journal.next',b'partial')
            with self.assertRaises(FileExistsError):self.store.write_journal({'phase':'prepared'})

    def test_marker_schema_and_vault_binding(self):
        marker=self.store.escrow()
        self.assertTrue(marker_valid(marker,digest(ENV)))
        for changed in (None,{},dict(marker,extra='no'),dict(marker,version='latest'),dict(marker,vault='https://foreign.vault.azure.net')):
            self.assertFalse(marker_valid(changed,digest(ENV)))


if __name__=='__main__':unittest.main()
