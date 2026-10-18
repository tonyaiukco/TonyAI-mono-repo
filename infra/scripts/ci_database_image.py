#!/usr/bin/env python3
"""Bind the disposable GitHub CI database to a reviewed immutable image."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[2]
POLICY = ROOT / 'infra/selfhost/database-image-policy.json'
REGISTRY = 'ghcr.io'


class QualificationFailure(ValueError):
    """A fixed diagnostic that contains no command output or environment data."""


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value):
        raise QualificationFailure('Expected a reviewed stable extension version.')
    return tuple(int(part) for part in value.split('.'))


def command(*argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=600)
    if result.returncode:
        operation = {
            ('supabase', '--version'): 'CLI version query',
            ('docker', 'ps'): 'existing container query',
            ('docker', 'pull'): 'immutable image pull',
            ('docker', 'tag'): 'default image tag',
            ('docker', 'image'): 'image metadata query',
            ('docker', 'container'): 'container metadata query',
        }.get(argv[:2], 'image qualification command')
        limited = any(marker in result.stderr.lower() for marker in
                      ('toomanyrequests', 'data limit exceeded', '429 too many requests'))
        reason = 'registry request limit' if limited else 'command refused'
        raise QualificationFailure(f'{operation} failed ({reason}); diagnostics withheld.')
    return result.stdout.strip()


def context(root=ROOT):
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('CI') != 'true':
        raise QualificationFailure('Only a disposable GitHub CI stack is supported.')
    if os.environ.get('SUPABASE_INTERNAL_IMAGE_REGISTRY') != REGISTRY:
        raise QualificationFailure('The reviewed source registry is required.')
    policy = json.loads((root / POLICY.relative_to(ROOT)).read_text())
    if version(policy['minimum_supautils']) < (3, 4, 2) or version(policy['supautils']) < version(policy['minimum_supautils']):
        raise QualificationFailure('Database extension is below the reviewed advisory floor.')
    if command('supabase', '--version') != policy['cli_version']:
        raise QualificationFailure('Unreviewed Supabase CLI version.')
    config = tomllib.loads((root / 'supabase/config.toml').read_text())
    if (config['db']['major_version'] != 17 or config['db'].get('orioledb_version')
            or config.get('experimental', {}).get('orioledb_version')):
        raise QualificationFailure('Unreviewed database engine.')
    # `start` runs user SQL before the post-start identity check. Upstream
    # platform bootstrap is necessary, but repository SQL must wait for verify.
    if (any(path.exists() or path.is_symlink() for path in
            (root / 'supabase/migrations', root / 'supabase/seed.sql'))
            or config['db'].get('migrations', {}).get('schema_paths', [])
            or config['db'].get('seed', {}).get('sql_paths', ['./seed.sql']) not in ([], ['./seed.sql'])):
        raise QualificationFailure('Supabase startup repository SQL is not permitted before image verification.')
    # A linked project can override the embedded CLI image. CI must be unlinked.
    version_path = root / 'supabase/.temp/postgres-version'
    if ((version_path.exists() and version_path.read_text().strip() != policy['image_tag'].split(':')[1])
            or (root / 'supabase/.temp/project-ref').exists()):
        raise QualificationFailure('Linked or overridden database refused.')
    return policy, 'supabase_db_' + config['project_id']


def verify_image(policy, reference):
    metadata = json.loads(command('docker', 'image', 'inspect', reference, '--format',
        '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}}}'))
    if metadata != {'id': policy['config_digest'], 'os': 'linux', 'architecture': 'amd64'}:
        raise QualificationFailure('Database image content/platform differs from the reviewed digest.')


def prepare(root=ROOT):
    policy, container = context(root)
    if command('docker', 'ps', '-aq', '--filter', 'name=^/' + container + '$'):
        raise QualificationFailure('CI must start a fresh disposable database.')
    reference = REGISTRY + '/' + policy['image']
    tag = REGISTRY + '/' + policy['image_tag']
    command('docker', 'pull', '--platform', policy['platform'], reference)
    verify_image(policy, reference)
    # The pinned CLI resolves cached images before pulling. Seed its embedded
    # default tag from the reviewed digest, then check the running image again.
    # Do not rely on the mutable tag or an unsupported version-file override.
    command('docker', 'tag', reference, tag)
    verify_image(policy, tag)


def verify(root=ROOT):
    policy, container = context(root)
    metadata = json.loads(command('docker', 'container', 'inspect', container, '--format',
        '{"id":{{json .Image}},"reference":{{json .Config.Image}},"running":{{json .State.Running}}}'))
    if metadata != {'id': policy['config_digest'], 'reference': REGISTRY + '/' + policy['image_tag'], 'running': True}:
        raise QualificationFailure('Running database differs from the reviewed image.')
    verify_image(policy, metadata['id'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'verify'])
    args = parser.parse_args()
    (prepare if args.action == 'prepare' else verify)()
    print('PASS: disposable CI database image identity verified.')


if __name__ == '__main__':
    try:
        main()
    except QualificationFailure as error:
        sys.exit(f'FAIL: {error} No migration or seed is authorized.')
    except Exception:
        sys.exit('FAIL: CI database image qualification refused; no migration or seed is authorized.')
