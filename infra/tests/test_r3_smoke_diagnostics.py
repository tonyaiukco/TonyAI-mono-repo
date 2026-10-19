"""Exercise the public failure boundary without Docker, downloads or secrets."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import r3_qualification as qualification
from r3_smoke_status import SmokeStatus

SECRET = 'PRIVATE_SENTINEL_command_environment_exception_output'


class Diagnostics(unittest.TestCase):
    def test_real_cli_refuses_arguments_and_wrong_runner_without_echoing_inputs(self):
        env = dict(os.environ, GITHUB_ACTIONS='false', DATABASE_URL=SECRET)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'not-created'
            for args, phase in (([], 'ARGUMENTS'), ([SECRET], 'ARGUMENTS'),
                                ([str(output), SECRET, SECRET], 'ARGUMENTS'),
                                ([str(output), SECRET], 'RUNNER_GUARD')):
                with self.subTest(args=len(args)):
                    result = subprocess.run([sys.executable, '-I', '-B', str(SCRIPTS / 'r3_qualification.py'), *args],
                                            capture_output=True, text=True, env=env)
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stdout, '')
                    self.assertEqual(result.stderr, 'FAIL: composition smoke ' + json.dumps({
                        'phase': phase, 'seed_cleanup': 'NOT_STARTED', 'compose_cleanup': 'NOT_STARTED',
                    }, sort_keys=True) + '\n')
                    self.assertFalse(output.exists())

    def test_hostile_subprocess_errors_timeouts_and_output_stay_private(self):
        cases = [
            ('exit', subprocess.CompletedProcess([SECRET], 9, SECRET.encode(), SECRET.encode())),
            ('timeout', subprocess.TimeoutExpired([SECRET], 1, output=SECRET.encode(), stderr=SECRET.encode())),
            ('missing', FileNotFoundError(SECRET)),
            ('called', subprocess.CalledProcessError(9, [SECRET], SECRET.encode(), SECRET.encode())),
            ('json', subprocess.CompletedProcess([SECRET], 0, SECRET.encode(), SECRET.encode())),
        ]
        for name, result in cases:
            with self.subTest(case=name):
                def fail(output, node, status):
                    status.at('IMAGE_PULL')
                    raw = qualification.capture([SECRET], data=SECRET.encode())
                    json.loads(raw)
                kwargs = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
                stdout, stderr = io.StringIO(), io.StringIO()
                with patch.object(qualification, 'run', side_effect=fail), patch.object(qualification.subprocess, 'run', **kwargs) as child, \
                        redirect_stdout(stdout), redirect_stderr(stderr):
                    code = qualification.main([SECRET, SECRET])
                self.assertEqual(code, 1)
                self.assertEqual(stdout.getvalue(), '')
                self.assertEqual(stderr.getvalue(), 'FAIL: composition smoke ' + json.dumps({
                    'phase': 'IMAGE_PULL', 'seed_cleanup': 'NOT_STARTED', 'compose_cleanup': 'NOT_STARTED',
                }, sort_keys=True) + '\n')
                self.assertTrue(child.call_args.kwargs['capture_output'])

    def test_unknown_status_values_cannot_become_public_diagnostics(self):
        status = SmokeStatus()
        with self.assertRaises(ValueError): status.at(SECRET)
        self.assertEqual(status.phase, 'ARGUMENTS')
        with self.assertRaises(ValueError):
            with status.cleanup(SECRET): self.fail('Invalid cleanup accepted')
        status.phase = status.seed_cleanup = status.compose_cleanup = SECRET
        self.assertEqual(status.failure(), 'FAIL: composition smoke ' + json.dumps({
            'phase': 'UNKNOWN', 'seed_cleanup': 'UNKNOWN', 'compose_cleanup': 'UNKNOWN',
        }, sort_keys=True))


if __name__ == '__main__': unittest.main()
