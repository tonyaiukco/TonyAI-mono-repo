#!/usr/bin/env python3
"""Owner-only exact-version verification or hidden-entry rotation, without Terraform secrets."""
import argparse
import getpass
import json
import sys
from pathlib import Path
from pooler import SafeFailure, validate_pooler
from secure_transport import Vault
from foundation_contract import validate_foundation
import re
from supabase_keys import validate_backend
from terraform_run import validate_release, clean_environment


def verify(inputs):
    foundation, release = validate_release(inputs)
    vault = Vault(foundation['vault_name'])
    project = release['supabase_project_ref']
    for name, version in [('database-url', release['database_secret_version']),
                          ('supabase-service-role-key', release['backend_secret_version'])]:
        record = vault.get(name, version)
        if not record:
            raise SafeFailure('Selected secret version is missing.')
        vault.identifier(record, name, version)
        if name == 'database-url':
            validate_pooler(record['value'], project, 6543)
        else:
            validate_backend(record['value'], project)
    print('PASS: selected versions are enabled, project-bound and use strict pooler TLS.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['verify', 'store'])
    parser.add_argument('--inputs', help='Complete release manifest for verification or rotation.')
    parser.add_argument('--foundation', help='Initial runtime storage only: foundation configuration.')
    parser.add_argument('--project-ref', help='Initial runtime storage only: hosted project reference.')
    parser.add_argument('--name', choices=['database-url', 'direct-url', 'supabase-service-role-key'])
    args = parser.parse_args()
    clean_environment()
    if args.foundation:
        if (args.inputs or args.operation != 'store' or args.name != 'database-url'
                or not re.fullmatch(r'[a-z]{20}', args.project_ref or '')):
            raise SafeFailure('Initial runtime storage needs only --foundation, --project-ref and --name database-url.')
        foundation = validate_foundation(json.loads(Path(args.foundation).read_text()))
        project = args.project_ref
    else:
        if not args.inputs or args.project_ref:
            raise SafeFailure('Use a complete --inputs release, or the initial runtime storage arguments.')
        inputs = json.loads(Path(args.inputs).read_text())
        foundation, release = validate_release(inputs)
        project = release['supabase_project_ref']
    if args.operation == 'verify':
        verify(inputs)
        return
    if not args.name:
        raise SafeFailure('Choose one named secret.')
    if not sys.stdin.isatty():
        raise SafeFailure('Use a private interactive terminal for hidden secret entry.')
    value = getpass.getpass('New secret value (hidden, memory only): ')
    if args.name.endswith('url'):
        validate_pooler(value, project, 6543 if args.name == 'database-url' else 5432)
    else:
        validate_backend(value, project)
    identity = Vault(foundation['vault_name']).put(args.name, value, {'project': project})
    print('Stored version ID: ' + identity)  # Identifier only, never the value.


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))
    except Exception:
        sys.exit('FAIL: secret operation failed; details withheld.')
