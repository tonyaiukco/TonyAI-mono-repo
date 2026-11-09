#!/usr/bin/env python3
"""Owner-only Supabase creation/configuration; all secret values stay in memory or Key Vault."""
import argparse
import getpass
import json
from pathlib import Path
import re
import sys
from cloud_ops import provision_buckets
from operation_journal import Journal
from pooler import SafeFailure
from runtime_urls import transfer_urls
from supabase_keys import select_keys
from secure_transport import Vault, json_request
from supabase_project import ensure_project
from supabase_auth import configure_auth, ensure_signing_key


def transfer_runtime(api, vault, ref, journal):
    public, backend = select_keys(api('/v1/projects/' + ref + '/api-keys?reveal=true'), ref)
    identity = vault.put('supabase-service-role-key', backend, {'project': ref})
    versions = transfer_urls(api, vault, ref, journal)
    versions['backend_secret_version'] = identity.rsplit('/', 1)[1]
    provision_buckets('https://' + ref + '.supabase.co/storage/v1', backend)
    return public, versions


def run(args):
    config = json.loads(Path(args.config).read_text())
    required = {'organization_id', 'organization_slug', 'name', 'vault', 'web_origin'}
    if set(config) - {'public_web_host'} != required or not all(isinstance(v, str) and v and '<' not in v for v in config.values()):
        raise SafeFailure('Complete the nonsecret Supabase configuration first.')
    if not all(re.fullmatch(r'[a-zA-Z0-9_-]+', config[k]) for k in ('organization_id', 'organization_slug', 'name')):
        raise SafeFailure('Invalid project or organization identifier.')
    from terraform_run import clean_environment
    from foundation_contract import validate_foundation
    from session_resources import restore
    from public_hosts import is_public_host
    clean_environment()
    foundation = validate_foundation(json.loads(Path(args.foundation).read_text()))
    session = restore(foundation['subscription_id'], foundation['resource_group'])
    if (session['VAULT_NAME'] != config['vault'] or session['WEB_ORIGIN'] != config['web_origin']
            or session['AZURE_TENANT_ID'] != foundation['tenant_id']):
        raise SafeFailure('Supabase target does not match the verified Azure foundation.')
    public_web_host = config.get('public_web_host')
    hosts = foundation.get('public_hosts') or {}
    # Before any key is revealed: only the foundation's certified web host may become the site URL.
    if public_web_host is not None and (not is_public_host(public_web_host) or public_web_host != hosts.get('web')
                                        or hosts.get('certificates') is not True):
        raise SafeFailure("public_web_host must be the foundation's web host, and only once its certificate exists.")
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
    # The journal stays bound to the original target; a later public host must not orphan it.
    journal = Journal(args.journal, {k: v for k, v in config.items() if k != 'public_web_host'})
    try:
        reconcile_only = getattr(args, 'reconcile_auth_only', False)
        if reconcile_only and (journal.data.get('configured') is not True
                               or not re.fullmatch(r'[a-z]{20}', journal.data.get('project_ref') or '')):
            raise SafeFailure('Auth-only reconciliation requires a completed journal with its saved project reference.')
        ref = ensure_project(api, vault, journal)
        project = api('/v1/projects/' + ref)
        if project.get('status') != 'ACTIVE_HEALTHY':
            raise SafeFailure('Project is still provisioning; wait, then resume the same journal.')
        if reconcile_only:
            public, _ = select_keys(api('/v1/projects/' + ref + '/api-keys?reveal=true'), ref)
            keys = api('/v1/projects/' + ref + '/config/auth/signing-keys')['keys']
            active = [key for key in keys if key.get('status') == 'in_use'
                      and key.get('algorithm') in ('ES256', 'RS256')]
            if len(active) != 1:
                raise SafeFailure('Auth reconciliation needs exactly one active asymmetric signing key; inspect before rotating.')
            configure_auth(api, ref, config['web_origin'], public, active[0]['id'], public_web_host=config.get('public_web_host'))
            print('PASS: existing hosted Auth policy and public JWKS reconciled; no secret transfer or key rotation.')
            return
        if journal.data.get('configured'):
            print('PASS: initial setup already completed; use verification/rotation runbooks for subsequent changes.')
            return
        public, versions = transfer_runtime(api, vault, ref, journal)
        signing = ensure_signing_key(api, ref, journal)
        configure_auth(api, ref, config['web_origin'], public, signing, public_web_host=config.get('public_web_host'))
        journal.set(versions=versions, configured=True)
        print('PASS: Stockholm project, private buckets, Auth/JWKS and vault bindings reconciled.')
        print('Project reference: ' + ref + '; version IDs are in the nonsecret journal.')
    finally:
        journal.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--journal', required=True)
    parser.add_argument('--foundation', required=True)
    parser.add_argument('--reconcile-auth-only', action='store_true',
                        help='Reconcile Auth on an already configured project; no provisioning or secret transfer.')
    parser.add_argument('--billing-approved', action='store_true', required=True)
    args = parser.parse_args()
    try:
        run(args)
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))
    except Exception:
        sys.exit('FAIL: operation interrupted; details withheld. Resume the same journal.')
