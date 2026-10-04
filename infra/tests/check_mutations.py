#!/usr/bin/env python3
"""Reproduce reported security mutations in disposable source copies."""
import ast
import yaml
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

INFRA = Path(__file__).resolve().parents[1]
MUTANTS = [
    ('approval manifest omitted from summary', 'prepare_release.py', 'json.dumps(inputs, sort_keys=True, indent=2)', "'{}'"),
    ('cleanup Supabase host binding removed', 'cloud_smoke.py', "target.get('supabase') != 'https://' + release['supabase_project_ref'] + '.supabase.co'", 'False'),
    ('cleanup staging mode removed', 'cloud_smoke.py', "target.get('mode') != 'staging'", 'False'),
    ('cleanup tenant count removed', 'cloud_smoke.py', 'len(tenants) != 2', 'False'),
    ('cleanup canonical UUID guard removed', 'cloud_smoke.py', 'if any(not isinstance(value, str) or not re.fullmatch(uuid_pattern, value) for value in ids):', 'if False:'),
    ('cleanup distinct tenant IDs removed', 'cloud_smoke.py', 'if len(set(identifiers)) != len(identifiers):', 'if False:'),
    ('cleanup synthetic email guard removed', 'cloud_smoke.py', "not re.fullmatch(r'lp2-smoke-[a-z0-9-]+@tonyai\\.test', tenant['email'])", 'False'),
    ('cleanup synthetic name guard removed', 'cloud_smoke.py', "tenant.get('name') != 'LP2 smoke ' + tenant['organisationId']", 'False'),
    ('cleanup in-process validation skipped', 'cloud_smoke.py', '        validate_cleanup_target(target, candidate, r)', '        pass'),
    ('last push approval requirement removed', 'github_environment.py', "pull.get('require_last_push_approval') is not True", 'False'),
    ('invalid runner mode exits successfully', '.github/workflows/deploy-staging.yml', '            exit 1', '            exit 0'),
    ('runner validation step removed', '.github/workflows/deploy-staging.yml', '      - name: Require ephemeral JIT runner configuration\n        id: runner-mode\n        env:\n          STAGING_RUNNER_MODE: ${{ vars.STAGING_RUNNER_MODE }}\n        run: |\n          if [ "${STAGING_RUNNER_MODE:-}" != \'ephemeral-jit\' ]; then\n            echo \'::error::Set STAGING_RUNNER_MODE=ephemeral-jit after verifying the JIT provisioner.\'\n            exit 1\n          fi\n', ''),

    ('prepare candidate binding removed', 'prepare_release.py', "    bind(candidate, inputs, env['GITHUB_SHA'])", '    pass'),
    ('prepare backend identity removed', 'prepare_release.py', "if any(backend[k] != foundation[k] for k in ('environment', 'subscription_id', 'tenant_id')):", 'if False:'),
    ('prepare OIDC subscription removed', 'prepare_release.py', "env['AZURE_SUBSCRIPTION_ID'] != foundation['subscription_id']", 'False'),
    ('prepare OIDC tenant removed', 'prepare_release.py', "env['AZURE_TENANT_ID'] != foundation['tenant_id']", 'False'),
    ('approved manifest hash binding removed', 'prepare_release.py', "if env.get('APPROVED_RELEASE_SHA256') != digest:", 'if False:'),
    ('foundation unattended apply allowed', 'terraform_run.py', "if action == 'approved-apply' and lane != 'application':", 'if False:'),
    ('failed plan allowed to apply', 'terraform_run.py', 'if subprocess.run(base + args, env=env, check=False).returncode:', 'if subprocess.run(base + args, env=env, check=False).returncode and False:'),
    ('artifact declared count removed', 'candidate_artifact.py', "listing.get('total_count') != 1", 'False'),
    ('artifact actual count removed', 'candidate_artifact.py', 'len(rows) != 1', 'False'),
    ('artifact network byte bound removed', 'candidate_artifact.py', 'len(archive) > 1_000_000', 'False'),
    ('artifact entry allowlist removed', 'candidate_artifact.py', "source.namelist() != ['candidate.json']", 'False'),
    ('artifact decompressed bound removed', 'candidate_artifact.py', "source.getinfo('candidate.json').file_size > 250_000", 'False'),
    ('cleanup journal binding removed', 'cloud_smoke.py', "if journal['candidate'] != candidate:", 'if False:'),
    ('cleanup source binding removed', 'cloud_smoke.py', "target.get('sourceSha') != candidate['source_sha']", 'False'),
    ('cleanup project binding removed', 'cloud_smoke.py', "target.get('projectRef') != release['supabase_project_ref']", 'False'),
    ('cleanup web binding removed', 'cloud_smoke.py', "target.get('web') != candidate['web_origin']", 'False'),
    ('cleanup API binding removed', 'cloud_smoke.py', "target.get('api') != candidate['api_origin'] + '/api/v1'", 'False'),
    ('created Auth ID check removed', 'cloud_smoke.py', "created.get('id') != tenant['userId']", 'False'),
    ('created Auth email check removed', 'cloud_smoke.py', "created.get('email') != tenant['email']", 'False'),
    ('child process isolation removed', 'cloud_smoke.py', "env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'PLAYWRIGHT_BROWSERS_PATH')}", 'env = dict(os.environ)'),
    ('two tenant requirement removed', 'smoke-contract.mjs', 'target.tenants.length !== 2', 'false'),
    ('local API origin check removed', 'smoke-contract.mjs', "target.api !== 'http://localhost:3001/api/v1'", 'false'),
    ('integration release gate removed', 'release_checks.py', "('ci.yml', 'e2e.yml', 'integration.yml')", "('ci.yml', 'e2e.yml')"),
    ('admin bypass check removed', 'github_environment.py', "            or environment.get('can_admins_bypass') is not False\n", ''),
    ('main repository preflight skipped', 'github_environment.py', '    verify_repository(repo, read)', '    pass'),
    ('ruleset bypass actors allowed', 'github_environment.py', "ruleset.get('bypass_actors') != []", 'False'),
    ('fork returning contributor approval removed', 'github_environment.py', "approval.get('approval_policy') != 'all_external_contributors'", 'False'),
    ('persistent runner mode accepted', 'github_environment.py', "mode.get('value') != 'ephemeral-jit'", 'False'),
    ('candidate environment removed', '.github/workflows/candidate.yml', '    environment: staging\n', ''),
    ('deploy environment removed', '.github/workflows/deploy-staging.yml', '    environment: staging\n', ''),
    ('preview granted OIDC', '.github/workflows/deploy-staging.yml', '    outputs:\n', '      id-token: write\n    outputs:\n'),
    ('approval preview dependency removed', '.github/workflows/deploy-staging.yml', '    needs: validate\n', ''),
    ('candidate gate after login', '.github/workflows/candidate.yml', '      - name: Require exact-candidate CI, integration and full E2E\n        env:\n          GH_TOKEN: ${{ github.token }}\n        run: python3 infra/scripts/release_checks.py\n', ''),
    ('shell expression injected', '.github/workflows/candidate.yml', 'run: python3 infra/scripts/release_checks.py', "run: echo '${{ github.ref }}'"),
    ('build provenance before registry skipped', 'build-images.sh', "python3 - <<'PYVALIDATE'\nimport os,sys\nsys.path.insert(0, 'infra/scripts')\nfrom candidate import create\ncreate(os.environ['RELEASE_SHA'], 'sha256:'+'0'*64, 'sha256:'+'0'*64)\nPYVALIDATE\n", ''),

    ('candidate workflow path check removed', 'candidate_artifact.py',
     "run.get('path') != '.github/workflows/candidate.yml'", 'False'),
    ('candidate artifact digest check removed', 'candidate_artifact.py',
     "artifact.get('digest') != 'sha256:' + hashlib.sha256(archive).hexdigest()", 'False'),
    ('candidate provenance comparison removed', 'candidate.py',
     'if candidate != expected:', 'if False:'),
    ('synthetic cleanup metadata check removed', 'cloud_smoke.py',
     "\n                    or user.get('app_metadata', {}).get('lp2_smoke') != tenant['organisationId']", ''),
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
     '    validate_pooler(direct, project, 5432)\n', ''),
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
            # New provenance tests read the actual migration/lockfile inputs; the
            # local-only guard test executes its copied script, never the original.
            root = INFRA.parent
            for relative in ('pnpm-lock.yaml', 'scripts/rls-probes.mjs', 'scripts/compose-dev.sh', 'packages/db/scripts/runtime-role.mjs'):
                destination = target.parent / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(root / relative, destination)
            shutil.copytree(root / 'packages/db/prisma/migrations', target.parent / 'packages/db/prisma/migrations')
            shutil.copytree(root / '.github/workflows', target.parent / '.github/workflows')
            pattern = 'test_*.py'
            targeted = {'prepare_release.py':'test_prepare_release.py', 'candidate_artifact.py':'test_candidate_artifact.py',
                        'cloud_smoke.py':'test_cloud_smoke.py', 'terraform_run.py':'test_candidate_path.py',
                        'release_checks.py':'test_candidate_path.py', 'smoke-contract.mjs':'test_candidate_path.py',
                        'build-images.sh':'test_build_images.py'}
            if filename.startswith('.github/'): pattern = 'test_workflow_security.py'
            else: pattern = targeted.get(filename, pattern)
            control = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(target / 'tests'), '-p', pattern],
                                     cwd=target.parent, capture_output=True)
            if control.returncode:
                sys.exit('INVALID: unmodified disposable-copy tests do not pass: ' + name)
            path = target.parent / filename if filename.startswith('.github/') else target / 'scripts' / filename
            source = path.read_text()
            if source.count(before) != 1:
                sys.exit('FAIL: mutation anchor changed: ' + name)
            mutated = source.replace(before, after)
            if path.suffix == '.py': ast.parse(mutated)  # Syntax errors are not a valid security-test kill.
            path.write_text(mutated)
            if path.suffix in ('.mjs', '.sh'):
                syntax = subprocess.run(['node', '--check', str(path)] if path.suffix == '.mjs' else ['bash', '-n', str(path)], capture_output=True)
                if syntax.returncode: sys.exit('INVALID: syntax error in mutation: ' + name)
            if path.suffix == '.yml': yaml.load(mutated, Loader=yaml.BaseLoader)
            runner = """import json, sys, unittest
suite = unittest.defaultTestLoader.discover(sys.argv[1], pattern=sys.argv[2])
result = unittest.TextTestRunner(stream=sys.stderr).run(suite)
print(json.dumps({'failures': len(result.failures), 'errors': len(result.errors)}))
"""
            result = subprocess.run([sys.executable, '-c', runner, str(target / 'tests'), pattern], cwd=target.parent, capture_output=True, text=True)
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
