#!/usr/bin/env python3
"""Owner-only exact-version verification or hidden-entry rotation, without Terraform secrets."""
import argparse
import base64
import getpass
import json
import sys
from pathlib import Path
from pooler import SafeFailure, validate_pooler
from secure_transport import Vault
from terraform_run import validate_release, clean_environment


def validate_backend(value, project):
    if value.startswith('sb_secret_'):
        # Opaque keys need the live project binding check below.
        return
    try:
        payload = json.loads(base64.urlsafe_b64decode(value.split('.')[1] + '==='))
    except Exception:
        raise SafeFailure('Invalid backend API key.') from None
    if payload.get('ref') != project or payload.get('role') != 'service_role':
        raise SafeFailure('Backend key is not this project service role.')


def verify(inputs):
    foundation, release = validate_release(inputs)
    vault = Vault(foundation['vault_name'])
    project = release['supabase_project_ref']
    for name, version in [('database-url', release['database_secret_version']),
                          ('supabase-service-role-key', release['backend_secret_version'])]:
        record = vault.get(name, version)
        if not record:
            raise SafeFailure('Selected secret version is missing.')
        vault.identifier(record, name)
        if name == 'database-url':
            validate_pooler(record['value'], project, 6543)
        else:
            validate_backend(record['value'], project)
            from cloud_ops import request, require_success
            require_success(request('https://' + project + '.supabase.co/storage/v1/bucket', key=record['value']))
    print('PASS: selected versions are enabled, project-bound and use strict pooler TLS.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['verify', 'store'])
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--name', choices=['database-url', 'direct-url', 'supabase-service-role-key'])
    args = parser.parse_args()
    clean_environment()
    inputs = json.loads(Path(args.inputs).read_text())
    if args.operation == 'verify':
        verify(inputs)
        return
    foundation, release = validate_release(inputs)
    if not args.name:
        raise SafeFailure('Choose one named secret.')
    if not sys.stdin.isatty():
        raise SafeFailure('Use a private interactive terminal for hidden secret entry.')
    value = getpass.getpass('New secret value (hidden, memory only): ')
    if args.name.endswith('url'):
        validate_pooler(value, release['supabase_project_ref'], 6543 if args.name == 'database-url' else 5432)
    else:
        validate_backend(value, release['supabase_project_ref'])
    identity = Vault(foundation['vault_name']).put(args.name, value, {'project': release['supabase_project_ref']})
    print('Stored version ID: ' + identity)  # Identifier only, never the value.


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))
    except Exception:
        sys.exit('FAIL: secret operation failed; details withheld.')
