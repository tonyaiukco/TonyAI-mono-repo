#!/usr/bin/env python3
"""Reproduce reported security mutations in disposable source copies."""
import ast
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

INFRA = Path(__file__).resolve().parents[1]
MUTANTS = [
    ('unrecorded app adoption restored', 'configure_oidc.py',
     "        if apps:\n            raise SafeFailure('Unrecorded Entra app already uses the staging name; refusing adoption.')\n        app = az(",
     "        app = apps[0] if apps else az("),
    ('app ownership check removed', 'configure_oidc.py', "    validate_owners('app', client, operator)", '    pass'),
    ('principal ownership check removed', 'configure_oidc.py', "    validate_owners('sp', principal['id'], operator)", '    pass'),
    ('principal credential check removed', 'configure_oidc.py',
     "if principal.get('passwordCredentials') != [] or principal.get('keyCredentials') != []:", 'if False:'),
    ('runtime URL validation skipped', 'cloud_ops.py', "    validate_pooler(data['value'], project, 6543)", '    pass'),
    ('query allowlist removed', 'pooler.py', "set(query) - {'pgbouncer', 'sslmode', 'sslaccept', 'sslcert', 'connection_limit'}", 'False'),
    ('public download denial removed', 'cloud_ops.py', 'if public_status not in (400, 401, 403, 404):', 'if False:'),
    ('build Auth validation removed', 'check_browser_key.py', '    validate_auth_settings(settings)', '    pass'),
    ('redirect handler removed', 'cloud_ops.py', 'build_opener(NoRedirect)', 'build_opener()'),
    ('public readback check removed', 'cloud_ops.py', "actual.get('public') is not False or ", ''),
    ('migration URL validation skipped', 'cloud_ops.py',
     '    validate_pooler(runtime, project, 6543)\n    validate_pooler(direct, project, 5432)\n', ''),
    ('signed bytes comparison removed', 'cloud_ops.py',
     'if require_success(request(base + signed)) != payload:', 'if False:'),
    ('cleanup prefix emptied', 'cloud_ops.py', "{'prefixes': [path]}", "{'prefixes': []}"),
    ('database path check removed', 'pooler.py', " or parsed.path != '/postgres'", ''),
    ('error body returned', 'cloud_ops.py', "return error.code, b''", 'return error.code, error.read()'),
]


def main():
    # A green control run prevents existing failures masquerading as killed mutants.
    result = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(INFRA / 'tests')], capture_output=True)
    if result.returncode:
        sys.exit('FAIL: unmodified tests do not pass; mutation evidence is invalid.')
    for name, filename, before, after in MUTANTS:
        with tempfile.TemporaryDirectory(prefix='tonyai-infra-mutant-') as directory:
            target = Path(directory)
            for folder in ('scripts', 'tests'):
                shutil.copytree(INFRA / folder, target / folder, ignore=shutil.ignore_patterns('__pycache__'))
            path = target / 'scripts' / filename
            source = path.read_text()
            if source.count(before) != 1:
                sys.exit('FAIL: mutation anchor changed: ' + name)
            mutated = source.replace(before, after)
            ast.parse(mutated)  # Syntax errors are not a valid security-test kill.
            path.write_text(mutated)
            runner = """import json, sys, unittest
suite = unittest.defaultTestLoader.discover(sys.argv[1])
result = unittest.TextTestRunner(stream=sys.stderr).run(suite)
print(json.dumps({'failures': len(result.failures), 'errors': len(result.errors)}))
"""
            result = subprocess.run([sys.executable, '-c', runner, str(target / 'tests')], capture_output=True, text=True)
            if result.returncode:
                sys.exit('INVALID: mutation test process failed: ' + name)
            summary = json.loads(result.stdout.strip().splitlines()[-1])
            if summary['errors']:
                sys.exit('INVALID: mutation caused a test error, not an assertion failure: ' + name)
            if not summary['failures']:
                sys.exit('SURVIVED: ' + name)
            print('KILLED: ' + name)
    print(f'PASS: all {len(MUTANTS)} mutations detected by assertion failures, with no test errors.')


if __name__ == '__main__':
    main()
