#!/usr/bin/env python3
"""Validate dispatch JSON in memory before writing only allowlisted public inputs."""
import json
import os
from pathlib import Path
import sys
from bootstrap_backend import validate as validate_backend
from candidate import bind
from candidate_artifact import download
from terraform_run import validate_release


def prepare(env=os.environ):
    candidate = download(env['GITHUB_REPOSITORY'], env['GITHUB_SHA'], env['CANDIDATE_RUN_ID'])
    inputs = json.loads(env['RELEASE_JSON'])
    backend = json.loads(env['BACKEND_JSON'])
    foundation, _ = validate_release(inputs)
    bind(candidate, inputs, env['GITHUB_SHA'])
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
        prepare()
        print('PASS: approved public candidate/release/backend inputs bound to this workflow SHA.')
    except Exception:
        sys.exit('FAIL: release inputs refused before OIDC login; details withheld.')
