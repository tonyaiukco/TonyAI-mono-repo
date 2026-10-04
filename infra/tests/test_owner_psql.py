"""Owner psql boundary tests: credentials stay out of arguments and inherited redirects."""
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import cloud_ops
from owner_psql import owner_psql
from pooler import ROOT, CA_RELATIVE_PATH, SafeFailure
from test_security_failures import GOOD_URL, PROJECT

OWNER_URL = GOOD_URL.replace('tonyai_runtime.', 'postgres.').replace(':6543/', ':5432/').replace('synthetic@', 'synthetic%25%2F%23@')


class OwnerPsqlTests(unittest.TestCase):
    def test_exact_version_and_clean_source_required_before_owner_secret_read(self):
        base = ['cloud_ops', 'owner-psql', '--vault', 'vault', '--project-ref', PROJECT, '--source-sha', 'a'*40]
        for version in (None, 'bad', 'b'*32):
            for dirty in ('', 'dirty'):
                argv = base + (['--direct-secret-version', version] if version else [])
                with self.subTest(version=version, dirty=dirty), patch.object(sys, 'argv', argv), patch('cloud_ops.command', side_effect=['a'*40, dirty]), patch('cloud_ops.secret', return_value=OWNER_URL) as secret, patch('owner_psql.owner_psql') as connect:
                    if version == 'b'*32 and not dirty:
                        cloud_ops.main()
                        secret.assert_called_once_with('vault', 'direct-url', version)
                        connect.assert_called_once_with(OWNER_URL, PROJECT)
                    else:
                        with self.assertRaises(SafeFailure): cloud_ops.main()
                        secret.assert_not_called()
                        connect.assert_not_called()

    def test_psql_uses_only_validated_libpq_environment_and_no_startup_or_history(self):
        ambient = {'PGHOST': 'evil.invalid', 'PGSERVICE': 'evil', 'PGOPTIONS': 'unsafe',
                   'PGSSLROOTCERT': '/wrong', 'PSQL_HISTORY': '/tmp/unsafe-history', 'NODE_OPTIONS': 'unsafe'}
        with patch.dict(os.environ, ambient), patch('owner_psql.sys.stdin.isatty', return_value=True), patch('owner_psql.sys.stdout.isatty', return_value=True), patch('owner_psql.subprocess.run', return_value=subprocess.CompletedProcess([], 0)) as run:
            owner_psql(OWNER_URL, PROJECT)
        args, = run.call_args.args
        env = run.call_args.kwargs['env']
        self.assertEqual(args, ['psql', '-X', '--no-password', '--set=ON_ERROR_STOP=1'])
        self.assertNotIn('synthetic', ' '.join(args))
        self.assertEqual(env['PGPASSWORD'], 'synthetic%/#')
        self.assertEqual(env['PGHOST'], 'aws-0-eu-central-1.pooler.supabase.com')
        self.assertEqual(env['PGPORT'], '5432')
        self.assertEqual(env['PGUSER'], 'postgres.'+PROJECT)
        self.assertEqual(env['PGDATABASE'], 'postgres')
        self.assertEqual(env['PGSSLMODE'], 'verify-full')
        self.assertEqual(env['PGSSLROOTCERT'], str(ROOT / CA_RELATIVE_PATH))
        self.assertEqual(env['PSQL_HISTORY'], os.devnull)
        for name in ('PGSERVICE', 'PGOPTIONS', 'NODE_OPTIONS'): self.assertNotIn(name, env)

    def test_wrong_role_noninteractive_and_failed_psql_are_refused(self):
        for value, tty, returncode in [(GOOD_URL, True, 0), (OWNER_URL, False, 0), (OWNER_URL, True, 1)]:
            with self.subTest(tty=tty, returncode=returncode), patch('owner_psql.sys.stdin.isatty', return_value=tty), patch('owner_psql.sys.stdout.isatty', return_value=tty), patch('owner_psql.subprocess.run', return_value=subprocess.CompletedProcess([], returncode)) as run:
                with self.assertRaises(SafeFailure) as failure: owner_psql(value, PROJECT)
                self.assertNotIn('synthetic', str(failure.exception))
                self.assertEqual(run.call_count, 1 if returncode else 0)
