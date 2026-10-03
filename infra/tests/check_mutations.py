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
    ('application state grant escapes its container', 'bootstrap_backend.py',
     "if lane == 'application' and config['application_object_id']:", "if config['application_object_id']:"),
    ('deployed secret identity readback removed', 'deploy_apps.py',
     " or actual[name].get('identity') != identity", ''),
    ('Auth exact-origin readback removed', 'supabase_auth.py',
     "if any(actual.get(key) != value for key, value in desired.items()):", 'if False:'),
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
    ('migration project binding removed', 'cloud_ops.py', " or release['supabase_project_ref'] != project", ''),
    ('provider password placeholder normalization removed', 'runtime_urls.py',
     ".replace('[YOUR-PASSWORD]', 'placeholder')", ''),
    ('helper HEAD comparison alone removed', 'cloud_ops.py',
     "            or command(['git', 'rev-parse', 'HEAD']) != release\n", ''),
    ('migration HEAD comparison alone removed', 'cloud_ops.py',
     "command(['git', 'rev-parse', 'HEAD']) != release['source_sha']", 'False'),
    ('helper SHA guard removed', 'cloud_ops.py',
     "    if (not re.fullmatch(r'[a-f0-9]{40}', release)\n            or command(['git', 'rev-parse', 'HEAD']) != release\n            or command(['git', 'status', '--porcelain'])):", '    if False:'),
    ('exact selected version check removed', 'secure_transport.py',
     "                or (version and record['id'].rsplit('/', 1)[1] != version)\n", ''),
    ('enabled version check removed', 'secure_transport.py',
     "                or record.get('attributes', {}).get('enabled') is not True", ''),
    ('rotation project binding removed', 'release_secrets.py',
     "        validate_backend(value, release['supabase_project_ref'])", '        pass'),
    ('bucket size readback removed', 'cloud_ops.py', " or actual.get('file_size_limit') != limit", ''),
    ('bucket MIME readback removed', 'cloud_ops.py', "\n                or set(actual.get('allowed_mime_types') or []) != set(mime_types)", ''),
    ('owner deployer separation removed', 'foundation_contract.py', "if deployer == config['owner_object_id']:", 'if False:'),
    ('unrecorded project adoption allowed', 'supabase_project.py', "if not journal.data.get('project_pending'):", 'if False:'),
    ('unknown project creation reposted', 'supabase_project.py', "    if journal.data.get('project_pending'):", '    if False:'),
    ('repository binding removed', 'configure_oidc.py', "if resource.get('tags', {}).get('githubRepository') != repo:", 'if False:'),
    ('bootstrap disable skipped', 'runtime_urls.py', "    vault.disable('bootstrap-db-password', saved['bootstrap_password_version'])", '    pass'),

]


def main():
    # A green control run prevents existing failures masquerading as killed mutants.
    result = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(INFRA / 'tests')], capture_output=True)
    if result.returncode:
        sys.exit('FAIL: unmodified tests do not pass; mutation evidence is invalid.')
    for name, filename, before, after in MUTANTS:
        with tempfile.TemporaryDirectory(prefix='tonyai-infra-mutant-') as directory:
            target = Path(directory) / 'infra'
            target.mkdir()
            for folder in ('scripts', 'tests', 'terraform', 'config'):
                shutil.copytree(INFRA / folder, target / folder, ignore=shutil.ignore_patterns('__pycache__', '.terraform'))
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
            result = subprocess.run([sys.executable, '-c', runner, str(target / 'tests')], cwd=target.parent, capture_output=True, text=True)
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
