#!/usr/bin/env python3
"""Owner-only Supabase creation/configuration; all secret values stay in memory or Key Vault."""
import argparse
import base64
import getpass
import json
import re
import sys
from urllib.parse import quote, urlparse
from cloud_ops import provision_buckets
from operation_journal import Journal
from pooler import SafeFailure, CONTAINER_CA, validate_pooler
from secure_transport import Vault, json_request
from supabase_project import ensure_project
from supabase_auth import configure_auth, ensure_signing_key


def transfer_runtime(api, vault, ref):
    # Read provider-created legacy keys; never create a duplicate on retry.
    keys = api('/v1/projects/' + ref + '/api-keys?reveal=true')
    values = {}
    for name, role in [('anon', 'anon'), ('service_role', 'service_role')]:
        matches = [k for k in keys if k.get('name') == name and k.get('api_key')]
        if len(matches) != 1:
            raise SafeFailure('Expected one provider-created legacy key; reconcile keys in Supabase.')
        value = matches[0]['api_key']
        payload = json.loads(base64.urlsafe_b64decode(value.split('.')[1] + '==='))
        if payload.get('ref') != ref or payload.get('role') != role:
            raise SafeFailure('Provider key is bound to the wrong project or role.')
        values[name] = value
    backend = vault.put('supabase-service-role-key', values['service_role'], {'project': ref})
    poolers = api('/v1/projects/' + ref + '/config/database/pooler')
    hosts = {urlparse(p['connection_string']).hostname for p in poolers if p.get('database_type') == 'PRIMARY'}
    if len(hosts) != 1 or not re.fullmatch(r'aws-[0-9]+-eu-central-1\.pooler\.supabase\.com', next(iter(hosts)) or ''):
        raise SafeFailure('No unambiguous Frankfurt primary pooler host.')
    password = vault.get('bootstrap-db-password')
    if not password or not password.get('value'):
        raise SafeFailure('Missing bootstrap DB password; recover it securely before URL setup.')
    versions = {'backend_secret_version': backend.rsplit('/', 1)[1]}
    for name, port in [('database-url', 6543), ('direct-url', 5432)]:
        value = ('postgresql://postgres.' + ref + ':' + quote(password['value'], safe='') + '@' + next(iter(hosts))
                 + ':' + str(port) + '/postgres?sslmode=require&sslaccept=strict&sslcert=' + CONTAINER_CA
                 + ('&pgbouncer=true' if port == 6543 else ''))
        validate_pooler(value, ref, port)
        identity = vault.put(name, value, {'project': ref})
        versions[name.replace('-', '_') + '_version'] = identity.rsplit('/', 1)[1]
    provision_buckets('https://' + ref + '.supabase.co/storage/v1', values['service_role'])
    return values['anon'], versions


def run(args):
    config = json.load(open(args.config))
    required = {'organization_id', 'organization_slug', 'name', 'vault', 'web_origin'}
    if set(config) != required or not all(isinstance(v, str) and v and '<' not in v for v in config.values()):
        raise SafeFailure('Complete the nonsecret Supabase configuration first.')
    if not all(re.fullmatch(r'[a-zA-Z0-9_-]+', config[k]) for k in ('organization_id', 'organization_slug', 'name')):
        raise SafeFailure('Invalid project or organization identifier.')
    from terraform_run import clean_environment
    from foundation_contract import validate_foundation
    from session_resources import restore
    clean_environment()
    foundation = validate_foundation(json.load(open(args.foundation)))
    session = restore(foundation['subscription_id'], foundation['resource_group'])
    if (session['VAULT_NAME'] != config['vault'] or session['WEB_ORIGIN'] != config['web_origin']
            or session['AZURE_TENANT_ID'] != foundation['tenant_id']):
        raise SafeFailure('Supabase target does not match the verified Azure foundation.')
    if not sys.stdin.isatty():
        raise SafeFailure('Use a private interactive terminal for hidden token entry.')
    token = getpass.getpass('Supabase management token (hidden, memory only): ')
    if not token:
        raise SafeFailure('A management token is required.')
    def api(path, method='GET', body=None):
        if not path.startswith('/v1/projects'):
            raise SafeFailure('Unexpected management API path.')
        return json_request('https://api.supabase.com' + path, method, token, body)
    vault = Vault(config['vault'])
    journal = Journal(args.journal, config)
    try:
        ref = ensure_project(api, vault, journal)
        project = api('/v1/projects/' + ref)
        if project.get('status') != 'ACTIVE_HEALTHY':
            raise SafeFailure('Project is still provisioning; wait, then resume the same journal.')
        if journal.data.get('configured'):
            print('PASS: initial setup already completed; use verification/rotation runbooks for subsequent changes.')
            return
        public, versions = transfer_runtime(api, vault, ref)
        signing = ensure_signing_key(api, ref, journal)
        configure_auth(api, ref, config['web_origin'], public, signing)
        journal.set(versions=versions, configured=True)
        print('PASS: Frankfurt project, private buckets, Auth/JWKS and vault bindings reconciled.')
        print('Project reference: ' + ref + '; version IDs are in the nonsecret journal.')
    finally:
        journal.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--journal', required=True)
    parser.add_argument('--foundation', required=True)
    parser.add_argument('--billing-approved', action='store_true', required=True)
    args = parser.parse_args()
    try:
        run(args)
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))
    except Exception:
        sys.exit('FAIL: operation interrupted; details withheld. Resume the same journal.')
