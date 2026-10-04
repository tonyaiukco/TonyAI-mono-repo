"""Exercise local launchers with fake provision/Docker processes; never start a stack."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pooler import SafeFailure, validate_pooler
from test_security_failures import GOOD_URL, PROJECT

ROOT = Path(__file__).resolve().parents[2]


class RuntimeSplitTests(unittest.TestCase):
    def test_owner_and_runtime_urls_are_not_interchangeable(self):
        direct = GOOD_URL.replace('tonyai_runtime.', 'postgres.').replace(':6543/', ':5432/')
        validate_pooler(direct, PROJECT, 5432)
        validate_pooler(GOOD_URL, PROJECT, 6543)
        for url, port in [(GOOD_URL.replace('tonyai_runtime.', 'postgres.'), 6543),
                          (direct.replace('postgres.', 'tonyai_runtime.'), 5432),
                          (GOOD_URL.replace('tonyai_runtime.', 'other.'), 6543)]:
            with self.subTest(port=port), self.assertRaises(SafeFailure):
                validate_pooler(url, PROJECT, port)

    def test_compose_provisions_random_login_and_passes_no_owner_to_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['scripts/compose-dev.sh', 'infra/scripts/local-runtime-env.sh',
                         'packages/db/scripts/runtime-role.mjs']:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(ROOT / name, target)
            for name, contents in [('apps/api/.env', 'DIRECT_URL=postgresql://postgres:owner-only@127.0.0.1:54322/postgres\n'),
                                   ('apps/web/.env.local', 'NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic\n')]:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(contents)
            binary = root / 'bin'
            binary.mkdir()
            # Only provision is stubbed. Random generation and URL derivation use real Node.
            node = binary / 'node'
            node.write_text('''#!/usr/bin/env python3
import json, os, sys
if sys.argv[1:] == ['packages/db/scripts/runtime-role.mjs', 'provision']:
    with open(os.environ['CAPTURE'], 'a') as f:
        f.write(json.dumps({'owner': os.environ['DIRECT_URL'], 'password': os.environ['RUNTIME_DB_PASSWORD']})+'\\n')
    if os.environ.get('FAIL_PROVISION'):
        print('owner-only sensitive failure', file=sys.stderr)
        sys.exit(1)
else:
    os.execv(os.environ['REAL_NODE'], [os.environ['REAL_NODE'], *sys.argv[1:]])
''')
            docker = binary / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import json, os, sys
from urllib.parse import urlparse
assert 'DIRECT_URL' not in os.environ and 'RUNTIME_DB_PASSWORD' not in os.environ
u=urlparse(os.environ['CONTAINER_DATABASE_URL'])
assert u.username == 'tonyai_runtime' and u.hostname == 'host.docker.internal'
with open(os.environ['CAPTURE'], 'a') as f:
    f.write(json.dumps({'docker': sys.argv[1:], 'password': u.password})+'\\n')
''')
            node.chmod(0o755)
            docker.chmod(0o755)
            capture = root / 'capture.jsonl'
            env = {**os.environ, 'PATH': str(binary)+os.pathsep+os.environ['PATH'],
                   'REAL_NODE': shutil.which('node'), 'CAPTURE': str(capture)}
            for command in ('up', 'up', 'down'):
                result = subprocess.run(['bash', 'scripts/compose-dev.sh', command], cwd=root,
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn('owner-only', result.stdout+result.stderr)
            rows = [json.loads(line) for line in capture.read_text().splitlines()]
            self.assertEqual(len(rows), 5)  # down must not provision
            self.assertEqual(rows[0]['password'], rows[1]['password'])
            self.assertEqual(rows[2]['password'], rows[3]['password'])
            self.assertNotEqual(rows[0]['password'], rows[2]['password'])
            self.assertRegex(rows[0]['password'], r'^[a-f0-9]{64}$')
            result = subprocess.run(['bash', 'scripts/compose-dev.sh', 'up'], cwd=root,
                                    env={**env, 'FAIL_PROVISION': '1'}, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('owner-only', result.stdout+result.stderr)
            self.assertEqual(len(capture.read_text().splitlines()), 6)  # no Docker after failure

    def test_image_launcher_gives_docker_only_runtime_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = root / 'docker.jsonl'
            scripts = {
                'node': '''#!/usr/bin/env python3
import os, sys
if sys.argv[1:] == ['packages/db/scripts/runtime-role.mjs', 'provision']:
    assert os.environ['DIRECT_URL'].startswith('postgresql://postgres:')
    assert len(os.environ['RUNTIME_DB_PASSWORD']) == 64
else:
    os.execv(os.environ['REAL_NODE'], [os.environ['REAL_NODE'], *sys.argv[1:]])
''',
                'docker': '''#!/usr/bin/env python3
import json, os, sys
from urllib.parse import urlparse
if sys.argv[1] == 'run':
    assert 'DIRECT_URL' not in os.environ and 'RUNTIME_DB_PASSWORD' not in os.environ
    assert 'DIRECT_URL' not in sys.argv
    u=urlparse(os.environ['DATABASE_URL'])
    assert u.username == 'tonyai_runtime' and len(u.password) == 64
    with open(os.environ['CAPTURE'], 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
    print('synthetic-container')
''',
                'curl': '#!/usr/bin/env bash\nexit 1\n',
                'sleep': '#!/usr/bin/env bash\nexit 0\n',
            }
            for name, content in scripts.items():
                path = root / name
                path.write_text(content)
                path.chmod(0o755)
            env = {**os.environ, 'PATH': str(root)+os.pathsep+os.environ['PATH'],
                   'REAL_NODE': shutil.which('node'), 'CAPTURE': str(capture), 'CI': 'true',
                   'API_IMAGE': 'synthetic-api', 'WEB_IMAGE': 'synthetic-web',
                   'DIRECT_URL': 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
                   'DATABASE_URL': 'postgresql://postgres:must-be-replaced@127.0.0.1:54322/postgres',
                   'SUPABASE_URL': 'http://127.0.0.1:54321'}
            result = subprocess.run(['bash', 'infra/scripts/local-image-smoke.sh'], cwd=ROOT,
                                    env=env, capture_output=True, text=True)
            # Stubbed readiness deliberately stops before browser/real HTTP.
            self.assertNotEqual(result.returncode, 0)
            rows = [json.loads(line) for line in capture.read_text().splitlines()]
            self.assertEqual(len(rows), 2)
            self.assertIn('DATABASE_URL', rows[0])
            self.assertNotIn('DIRECT_URL', rows[0])
            self.assertNotIn('must-be-replaced', result.stdout+result.stderr)
