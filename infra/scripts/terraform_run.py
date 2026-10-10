#!/usr/bin/env python3
"""Pinned Terraform entrypoint: explicit backend binding, no ambient TF inputs/debug logs."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from pooler import SafeFailure
from bootstrap_backend import validate as validate_backend
from foundation_contract import validate_foundation

ROOT = Path(__file__).resolve().parents[2]


def clean_environment():
    blocked = ('TF_LOG', 'TF_CLI_ARGS', 'TF_VAR_', 'ARM_ACCESS_KEY', 'ARM_SAS_TOKEN',
               'ARM_CLIENT_SECRET', 'ARM_CLIENT_CERTIFICATE', 'AZAPI_LOG')
    if any(any(key.startswith(prefix) for prefix in blocked) and value for key, value in os.environ.items()):
        raise SafeFailure('Remove Terraform overrides, debug logging and long-lived cloud credentials first.')
    return {k: v for k, v in os.environ.items() if k not in ('TF_WORKSPACE', 'TF_DATA_DIR', 'TF_CLI_CONFIG_FILE')}


def validate_release(inputs):
    if set(inputs) != {'foundation', 'release'}:
        raise SafeFailure('Application input must contain only foundation and release.')
    foundation, release = inputs['foundation'], inputs['release']
    expected = {'subscription_id', 'tenant_id', 'environment', 'resource_group', 'prefix', 'registry_name', 'vault_name', 'default_domain'}
    if set(foundation) != expected or foundation['environment'] not in ('staging', 'production'):
        raise SafeFailure('Unexpected foundation contract.')
    patterns = {
        'subscription_id': r'[a-f0-9-]{36}', 'tenant_id': r'[a-f0-9-]{36}',
        'resource_group': r'[A-Za-z0-9_-]+', 'prefix': r'[a-z0-9]{3,12}',
        'registry_name': r'[a-z0-9]{5,50}', 'vault_name': r'[a-z][a-z0-9-]{1,22}[a-z0-9]',
        'default_domain': r'[a-z0-9-]+\.germanywestcentral\.azurecontainerapps\.io',
    }
    for key, pattern in patterns.items():
        if not isinstance(foundation[key], str) or not re.fullmatch(pattern, foundation[key]):
            raise SafeFailure('Invalid foundation identifier or domain.')
    expected = {'source_sha', 'release_id', 'supabase_project_ref', 'api_digest', 'web_digest', 'database_secret_version', 'backend_secret_version', 'storage_cleanup_hold', 'storage_sweep_interval_seconds'}
    if set(release) - {'runtime_limits'} != expected:
        raise SafeFailure('Release has missing or unknown fields; secret values are prohibited.')
    patterns = {'source_sha': r'[a-f0-9]{40}', 'release_id': r'[a-z][a-z0-9-]{0,29}',
                'supabase_project_ref': r'[a-z]{20}', 'api_digest': r'sha256:[a-f0-9]{64}',
                'web_digest': r'sha256:[a-f0-9]{64}', 'database_secret_version': r'[a-f0-9]{32}',
                'backend_secret_version': r'[a-f0-9]{32}'}
    if any(not isinstance(release[k], str) or not re.fullmatch(p, release[k]) for k, p in patterns.items()):
        raise SafeFailure('Release needs immutable digests, exact versions and a reviewed source SHA.')
    if type(release['storage_cleanup_hold']) is not bool:
        raise SafeFailure('Storage cleanup hold must be a boolean.')
    interval = release['storage_sweep_interval_seconds']
    if type(interval) is not int or not 1 <= interval <= 86400:
        raise SafeFailure('Storage sweep interval must be integer seconds from 1 to 86400.')
    from runtime_limits import validate_limits
    validate_limits(release.get('runtime_limits', {}))
    return foundation, release


def invoke(lane, backend_path, inputs_path, action, before_apply=None):
    if action == 'approved-apply' and lane != 'application':
        raise SafeFailure('Unattended apply is restricted to the application root.')
    env = clean_environment()
    backend = json.loads(Path(backend_path).read_text())
    validate_backend(backend)
    inputs = json.loads(Path(inputs_path).read_text())
    if lane == 'application':
        target, _ = validate_release(inputs)
    else:
        target = validate_foundation(inputs)
    if any(target[k] != backend[k] for k in ('subscription_id', 'tenant_id', 'environment')):
        raise SafeFailure('Backend and infrastructure environment identities differ.')
    folder = ROOT / 'infra' / 'terraform' / lane
    # Never load .auto.tfvars, override files or environment settings from another session.
    if any(folder.glob('*.auto.tfvars*')) or any(folder.glob('*override.tf*')) or any((folder / name).exists() for name in ('terraform.tfvars', 'terraform.tfvars.json')):
        raise SafeFailure('Remove ambient variable/override files from the Terraform root.')
    env.update(ARM_SUBSCRIPTION_ID=target['subscription_id'], ARM_TENANT_ID=target['tenant_id'])
    base = ['terraform', '-chdir=' + str(folder)]
    def call(args):
        if subprocess.run(base + args, env=env, check=False).returncode:
            raise SafeFailure('Terraform failed; correct the cause and resume with the same inputs.')
    call(['init', '-reconfigure', '-input=false', '-lockfile=readonly',
          '-backend-config=use_azuread_auth=true',
          '-backend-config=tenant_id=' + target['tenant_id'],
          '-backend-config=subscription_id=' + target['subscription_id'],
          '-backend-config=storage_account_name=' + backend['storage_account'],
          '-backend-config=container_name=' + lane,
          '-backend-config=key=' + target['environment'] + '.tfstate'])
    if action == 'output':
        call(['output', '-json', 'application_contract'])
        return
    if action == 'approved-apply' or (action == 'apply' and before_apply):
        # The protected environment reviewer approves the release before this
        # job starts. Apply exactly this plan; never silently re-plan at apply.
        # A private temporary directory is deleted even after a failed apply.
        with tempfile.TemporaryDirectory(prefix='tonyai-plan-') as directory:
            plan = str(Path(directory) / 'application.tfplan')
            call(['plan', '-input=false', '-lock-timeout=60s',
                  '-var-file=' + str(Path(inputs_path).resolve()), '-out=' + plan])
            if action != 'approved-apply':
                call(['show', '-no-color', plan])
                if input('Apply this saved plan after draining the API? Type yes: ').strip() != 'yes':
                    raise SafeFailure('Apply declined; API was not drained.')
            if before_apply:
                before_apply()
            call(['apply', '-input=false', '-lock-timeout=60s', plan])
        return
    call([action, *([] if action == 'apply' else ['-input=false']), '-lock-timeout=60s', '-var-file=' + str(Path(inputs_path).resolve())])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lane', choices=['foundation', 'application'])
    parser.add_argument('action', choices=['plan', 'apply', 'output'])
    parser.add_argument('--backend', required=True)
    parser.add_argument('--inputs', required=True)
    args = parser.parse_args()
    try:
        invoke(args.lane, args.backend, args.inputs, args.action)
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))
    except Exception:
        sys.exit('FAIL: configuration invalid; details withheld.')
