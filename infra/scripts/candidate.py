#!/usr/bin/env python3
"""Public image provenance and release binding. Never accepts credential values."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from pooler import SafeFailure
from terraform_run import ROOT, validate_release


def fingerprint(root=ROOT):
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()
    migrations = sorted((root / 'packages/db/prisma/migrations').glob('*/migration.sql'))
    if not migrations:
        raise SafeFailure('No committed migration chain found.')
    return {'lockfile_sha256': digest(root / 'pnpm-lock.yaml'),
            'migrations': [{'name': p.parent.name, 'sha256': digest(p)} for p in migrations]}


def clean_source(sha):
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise SafeFailure('A full source SHA is required.')
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()
    if git('rev-parse', 'HEAD') != sha or git('status', '--porcelain'):
        raise SafeFailure('Candidate requires its exact source SHA and a clean checkout.')


def create(sha, api_digest, web_digest, env=os.environ):
    clean_source(sha)
    if any(not re.fullmatch(r'sha256:[a-f0-9]{64}', d) for d in (api_digest, web_digest)):
        raise SafeFailure('Build must return immutable image digests.')
    project, prefix, domain = (env.get(k, '') for k in ('SUPABASE_PROJECT_REF', 'PREFIX', 'ACA_DEFAULT_DOMAIN'))
    if (not re.fullmatch(r'[a-z]{20}', project) or not re.fullmatch(r'[a-z0-9]{3,12}', prefix)
            or not re.fullmatch(r'[a-z0-9-]+\.germanywestcentral\.azurecontainerapps\.io', domain)
            or not re.fullmatch(r'[a-z0-9]{5,50}', env.get('ACR_NAME', ''))):
        raise SafeFailure('Invalid staging build contract.')
    origins = {kind + '_origin': 'https://' + prefix + '-staging-' + kind + '.' + domain for kind in ('api', 'web')}
    if any(env.get(key.upper()) != value for key, value in origins.items()) or env.get('ACR_HOST') != env['ACR_NAME'] + '.azurecr.io':
        raise SafeFailure('Build origins or registry differ from the contract.')
    return {'schema': 1, 'environment': 'staging', 'source_sha': sha,
            'api_digest': api_digest, 'web_digest': web_digest,
            'registry': env['ACR_HOST'], 'supabase_project_ref': project,
            **origins, **fingerprint()}


def bind(candidate, inputs, sha):
    foundation, release = validate_release(inputs)
    if foundation['environment'] != 'staging' or release['source_sha'] != sha:
        raise SafeFailure('Only the selected staging source can be deployed.')
    env = {'SUPABASE_PROJECT_REF': release['supabase_project_ref'], 'PREFIX': foundation['prefix'],
           'ACA_DEFAULT_DOMAIN': foundation['default_domain'], 'ACR_NAME': foundation['registry_name'],
           'ACR_HOST': foundation['registry_name'] + '.azurecr.io'}
    for kind in ('api', 'web'):
        env[kind.upper() + '_ORIGIN'] = 'https://' + foundation['prefix'] + '-staging-' + kind + '.' + foundation['default_domain']
    expected = create(sha, release['api_digest'], release['web_digest'], env)
    if candidate != expected:
        raise SafeFailure('Candidate provenance differs from source, migrations, lockfile or release target.')
    return expected


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['create', 'verify'])
    parser.add_argument('--sha', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--inputs')
    parser.add_argument('--api-digest')
    parser.add_argument('--web-digest')
    args = parser.parse_args()
    try:
        if args.operation == 'create':
            result = create(args.sha, args.api_digest or '', args.web_digest or '')
            with open(args.candidate, 'x') as target:
                json.dump(result, target, indent=2)
        else:
            bind(json.loads(Path(args.candidate).read_text()), json.loads(Path(args.inputs).read_text()), args.sha)
        print('PASS: candidate source, migration chain, lockfile and staging image binding.')
    except Exception:
        sys.exit('FAIL: candidate provenance refused; details withheld.')
