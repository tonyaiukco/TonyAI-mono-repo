"""Bind a newer reviewed helper to the unchanged release source; public bytes only."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
from pooler import SafeFailure
from terraform_run import validate_release

ENGINE_COMMIT = 'c2990dca591cba766e3b7ef5d9e8a84796e47ab7'
ENGINE_SHA256 = '5d42b181631fd20bb0ecc5abcdba72575e7f467a0d52f4d5ef1ff28f0c74e6e9'
CA_PATH = 'infra/certs/prod-ca-2021.crt'
SCHEMA_PATH = 'packages/db/prisma/schema.prisma'
MIGRATIONS = 'packages/db/prisma/migrations'


def git(root, *args):
    result = subprocess.run(['git', *args], cwd=root, capture_output=True, check=False)
    if result.returncode:
        raise SafeFailure('Source binding failed; git output withheld.')
    return result.stdout


def clean(root, sha):
    if (not re.fullmatch(r'[a-f0-9]{40}', sha or '')
            or git(root, 'rev-parse', 'HEAD').decode().strip() != sha
            or git(root, 'status', '--porcelain', '--untracked-files=all').strip()):
        raise SafeFailure('Require the selected full SHA and a clean checkout.')


def committed(root, sha, path):
    # Read Git object bytes, never ignored/symlink/worktree overrides.
    mode = git(root, 'ls-tree', sha, '--', path).decode().split(' ', 1)[0]
    if mode != '100644':
        raise SafeFailure('Migration input must be a tracked regular non-executable file.')
    return git(root, 'show', sha + ':' + path)


def prepare(source, inputs, candidate, destination):
    foundation, release = validate_release(inputs)
    sha = release['source_sha']
    clean(source, sha)
    paths = git(source, 'ls-tree', '-r', '--name-only', sha, '--', MIGRATIONS).decode().splitlines()
    sql_paths = [p for p in paths if re.fullmatch(MIGRATIONS + r'/[a-z0-9_]+/migration\.sql', p)]
    if not sql_paths or set(paths) != set(sql_paths) | {MIGRATIONS + '/migration_lock.toml'}:
        raise SafeFailure('Unexpected committed migration chain files.')
    migrations = [{'name': p.split('/')[-2], 'sql': committed(source, sha, p).decode()} for p in sorted(sql_paths)]
    lock = committed(source, sha, 'pnpm-lock.yaml')
    if b'prisma@6.19.3:' not in lock or ENGINE_COMMIT.encode() not in lock:
        raise SafeFailure('This transport supports only the reviewed Prisma engine version.')
    expected = {'schema': 1, 'environment': 'staging', 'source_sha': sha,
                'api_digest': release['api_digest'], 'web_digest': release['web_digest'],
                'registry': foundation['registry_name'] + '.azurecr.io',
                'supabase_project_ref': release['supabase_project_ref'],
                'lockfile_sha256': hashlib.sha256(lock).hexdigest(),
                'migrations': [{'name': m['name'], 'sha256': hashlib.sha256(m['sql'].encode()).hexdigest()} for m in migrations]}
    for kind in ('api', 'web'):
        expected[kind + '_origin'] = 'https://' + foundation['prefix'] + '-staging-' + kind + '.' + foundation['default_domain']
    if foundation['environment'] != 'staging' or candidate != expected:
        raise SafeFailure('Candidate differs from the selected release, source, lockfile or migrations.')
    schema = committed(source, sha, SCHEMA_PATH).decode()
    bundle = {'schema': schema, 'lockfile': committed(source, sha, MIGRATIONS + '/migration_lock.toml').decode(),
              'migrations': migrations}
    destination = Path(destination)
    (destination / 'pnpm-lock.yaml').write_bytes(lock)
    (destination / 'schema.prisma').write_text(schema)
    (destination / 'ca.crt').write_bytes(committed(source, sha, CA_PATH))
    (destination / 'bundle.json').write_text(json.dumps(bundle))
    checker = destination / 'packages/db/scripts/runtime-role.mjs'
    checker.parent.mkdir(parents=True)
    checker.write_bytes(committed(source, sha, 'packages/db/scripts/runtime-role.mjs'))
    for migration in migrations:
        path = destination / MIGRATIONS / migration['name'] / 'migration.sql'
        path.parent.mkdir(parents=True)
        path.write_text(migration['sql'])

    return foundation['registry_name'] + '.azurecr.io/tonyai/api@' + release['api_digest']


def copy_engine(engine, destination):
    data = Path(engine).read_bytes()
    if hashlib.sha256(data).hexdigest() != ENGINE_SHA256:
        raise SafeFailure('Linux schema-engine checksum differs from the reviewed Prisma build.')
    target = Path(destination) / 'schema-engine'
    target.write_bytes(data)
    target.chmod(0o555)
    if hashlib.sha256(target.read_bytes()).hexdigest() != ENGINE_SHA256:
        raise SafeFailure('Copied engine checksum differs.')
