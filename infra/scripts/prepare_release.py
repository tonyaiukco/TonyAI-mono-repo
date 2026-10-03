#!/usr/bin/env python3
"""Validate dispatch JSON in memory before writing only allowlisted public inputs."""
import json
import hashlib
import os
from pathlib import Path
import sys
from bootstrap_backend import validate as validate_backend
from candidate import bind
from candidate_artifact import download
from terraform_run import validate_release


def manifest(env):
    candidate = download(env['GITHUB_REPOSITORY'], env['GITHUB_SHA'], env['CANDIDATE_RUN_ID'])
    inputs = json.loads(env['RELEASE_JSON'])
    validate_release(inputs)
    bind(candidate, inputs, env['GITHUB_SHA'])
    digest = hashlib.sha256(json.dumps(inputs, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return candidate, inputs, digest


def preview(env=os.environ):
    _, inputs, digest = manifest(env)
    with open(env['GITHUB_STEP_SUMMARY'], 'a') as stream:
        stream.write('### Release manifest awaiting independent approval\n\n'
                     + 'Candidate run: ' + env['CANDIDATE_RUN_ID'] + '\n\n'
                     + 'Source SHA: `' + env['GITHUB_SHA'] + '`\n\n'
                     + 'Canonical manifest SHA-256: `' + digest + '`\n\n'
                     + '```json\n' + json.dumps(inputs, sort_keys=True, indent=2) + '\n```\n'
                     + '\nReview every field, including both secret version IDs. '
                     + 'This is a manifest review; no Terraform plan or cloud validation has run.\n')
    with open(env['GITHUB_OUTPUT'], 'a') as stream:
        stream.write('release_sha256=' + digest + '\n')


def prepare(env=os.environ):
    candidate, inputs, digest = manifest(env)
    if env.get('APPROVED_RELEASE_SHA256') != digest:
        raise ValueError('Approved manifest hash mismatch')
    backend = json.loads(env['BACKEND_JSON'])
    foundation, _ = validate_release(inputs)
    validate_backend(backend)
    if any(backend[k] != foundation[k] for k in ('environment', 'subscription_id', 'tenant_id')):
        raise ValueError('Backend identity mismatch')
    if (env['AZURE_SUBSCRIPTION_ID'] != foundation['subscription_id']
            or env['AZURE_TENANT_ID'] != foundation['tenant_id']):
        raise ValueError('OIDC identity mismatch')
    directory = Path('.infra-local/staging')
    directory.mkdir(parents=True, exist_ok=True)
    for name, value in [('candidate', candidate), ('release', inputs), ('backend', backend)]:
        with (directory / (name + '.json')).open('x') as stream:
            json.dump(value, stream, indent=2)


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--preview']:
            preview()
            print('PASS: validated public manifest and hash published for independent approval.')
        else:
            prepare()
            print('PASS: approved public candidate/release/backend inputs bound to this workflow SHA.')
    except Exception:
        sys.exit('FAIL: release inputs refused before OIDC login; details withheld.')
