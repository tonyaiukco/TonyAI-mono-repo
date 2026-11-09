#!/usr/bin/env python3
"""Owner-run exact-release smoke. Credentials stay in memory; journal holds IDs only."""
import argparse
import getpass
import json
import os
import re
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import uuid
from candidate import bind
from check_browser_key import check_inputs
from cloud_ops import secret, request, write_private_journal
from deploy_apps import verify
from pooler import SafeFailure, validate_pooler
from public_hosts import public_host_env
from terraform_run import ROOT


def target_for(candidate):
    tenants = []
    for _ in range(2):
        organisation = str(uuid.uuid4())
        user = str(uuid.uuid4())
        tenants.append({'userId': user, 'organisationId': organisation,
                        'subsidiaryId': str(uuid.uuid4()), 'email': 'lp2-smoke-' + user + '@tonyai.test',
                        'name': 'LP2 smoke ' + organisation})
    return {'mode': 'staging', 'sourceSha': candidate['source_sha'],
            'projectRef': candidate['supabase_project_ref'], 'web': candidate['web_origin'],
            'api': candidate['api_origin'] + '/api/v1',
            'supabase': 'https://' + candidate['supabase_project_ref'] + '.supabase.co', 'tenants': tenants}


def auth_call(base, key, method, path, body=None, missing=False):
    status, raw = request(base + '/auth/v1/admin/users' + path, method, key,
                          None if body is None else json.dumps(body).encode())
    if missing and status == 404:
        return None
    if not 200 <= status < 300:
        raise SafeFailure('Synthetic Auth operation failed; preserve the ID journal for cleanup.')
    return json.loads(raw) if raw else {}


def cleanup(target, key):
    # Read and match exact identity before deletion. Never query by broad prefix,
    # never delete application rows or audit_log. Auth accounts are ephemeral.
    failed = False
    for tenant in target['tenants']:
        try:
            path = '/' + tenant['userId']
            user = auth_call(target['supabase'], key, 'GET', path, missing=True)
            if user is None:
                continue
            if (user.get('id') != tenant['userId'] or user.get('email') != tenant['email']
                    or user.get('app_metadata', {}).get('lp2_smoke') != tenant['organisationId']):
                raise SafeFailure('Cleanup identity differs from the journal; refusing deletion.')
            auth_call(target['supabase'], key, 'DELETE', path)
            if auth_call(target['supabase'], key, 'GET', path, missing=True) is not None:
                raise SafeFailure('Synthetic Auth deletion not confirmed.')
        except Exception:
            # One refused account must not strand the other independent account.
            failed = True
    if failed:
        raise SafeFailure('One or more exact-ID Auth cleanups failed; retain the journal and retry.')


def child(script, env):
    result = subprocess.run(['node', str(ROOT / 'infra/scripts' / script)], cwd=ROOT,
                            env=env, capture_output=True, text=True, check=False, timeout=600)
    if result.returncode:
        raise SafeFailure('Fixture or smoke child failed; credentials and browser diagnostics withheld.')


def validate_cleanup_target(target, candidate, release):
    """Validate the journal in-process before a credential read or Auth request."""
    if (not isinstance(target, dict) or target.get('mode') != 'staging'
            or target.get('sourceSha') != candidate['source_sha']
            or target.get('projectRef') != release['supabase_project_ref']
            or target.get('web') != candidate['web_origin']
            or target.get('api') != candidate['api_origin'] + '/api/v1'
            or target.get('supabase') != 'https://' + release['supabase_project_ref'] + '.supabase.co'):
        raise SafeFailure('Cleanup target differs from the selected candidate.')
    tenants = target.get('tenants')
    if not isinstance(tenants, list) or len(tenants) != 2:
        raise SafeFailure('Cleanup requires two synthetic tenants.')
    identifiers = []
    uuid_pattern = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
    for tenant in tenants:
        if not isinstance(tenant, dict):
            raise SafeFailure('Invalid cleanup tenant.')
        ids = [tenant.get(field) for field in ('userId', 'organisationId', 'subsidiaryId')]
        if any(not isinstance(value, str) or not re.fullmatch(uuid_pattern, value) for value in ids):
            raise SafeFailure('Invalid cleanup tenant identifiers.')
        if (not isinstance(tenant.get('email'), str)
                or tenant['email'] != 'lp2-smoke-' + tenant['userId'] + '@tonyai.test'
                or tenant.get('name') != 'LP2 smoke ' + tenant['organisationId']):
            raise SafeFailure('Invalid synthetic cleanup identity.')
        identifiers.extend(ids)
    if len(set(identifiers)) != len(identifiers):
        raise SafeFailure('Cleanup tenants must have disjoint identifiers.')


def run(candidate, inputs, journal_path, cleanup_only=False, direct_secret_version=None):
    return execute(candidate, inputs, journal_path, cleanup_only, direct_secret_version)


def execute(candidate, inputs, journal_path, cleanup_only=False, direct_secret_version=None,
            fixture_runner=None, source_binding=None):
    # Every entry to live execution proves provenance itself. No caller-supplied
    # boolean or callback may stand in for the candidate/release/source checks.
    if source_binding is None:
        bind(candidate, inputs, inputs['release']['source_sha'])
    else:
        from migration_binding import clean, prepare
        if (not isinstance(source_binding, tuple) or len(source_binding) != 2
                or (not cleanup_only and not callable(fixture_runner))):
            raise SafeFailure('Hosted execution requires both clean sources and its Linux fixture.')
        helper_sha, application_source = source_binding
        clean(ROOT, helper_sha)
        with tempfile.TemporaryDirectory(prefix='tonyai-smoke-recheck-') as public:
            prepare(Path(application_source).resolve(), inputs, candidate, Path(public))
    f, r = inputs['foundation'], inputs['release']
    if cleanup_only:
        journal = json.loads(Path(journal_path).read_text())
        if journal['candidate'] != candidate:
            raise SafeFailure('Cleanup candidate differs from the ID journal.')
        target = journal['target']
        validate_cleanup_target(target, candidate, r)
        key = secret(f['vault_name'], 'supabase-service-role-key', r['backend_secret_version'])
        cleanup(target, key)
        if any(not item.get('matches_intent') for item in journal.get('auth_create_observations', [])):
            raise SafeFailure('Unexpected Auth create response requires owner review; cleanup covers intended IDs only.')
        return
    if not re.fullmatch(r'[a-f0-9]{32}', direct_secret_version or ''):
        raise SafeFailure('Fixture provisioning requires an exact --direct-secret-version.')
    database = secret(f['vault_name'], 'direct-url', direct_secret_version)
    validate_pooler(database, r['supabase_project_ref'], 5432)
    key = secret(f['vault_name'], 'supabase-service-role-key', r['backend_secret_version'])
    verify(inputs)  # No fixture writes until exact running images/revisions match.
    public = getpass.getpass('Staging public browser key: ')
    check_inputs({'SUPABASE_PROJECT_REF': r['supabase_project_ref'], 'NEXT_PUBLIC_SUPABASE_ANON_KEY': public,
                  'PREFIX': f['prefix'], 'ACA_DEFAULT_DOMAIN': f['default_domain'],
                  'API_ORIGIN': candidate['api_origin'], 'NEXT_PUBLIC_API_BASE_URL': candidate['api_origin'] + '/api/v1',
                  'NEXT_PUBLIC_SUPABASE_URL': 'https://' + r['supabase_project_ref'] + '.supabase.co', **public_host_env(f)})
    target = target_for(candidate)
    # Intent is durable before any Auth POST; no passwords/tokens in this file.
    journal = {'candidate': candidate, 'target': target, 'auth_create_observations': []}
    write_private_journal(journal_path, journal, exclusive=True)
    passwords = [secrets.token_urlsafe(32), secrets.token_urlsafe(32)]
    try:
        for tenant, password in zip(target['tenants'], passwords):
            created = auth_call(target['supabase'], key, 'POST', '', {
                'id': tenant['userId'], 'email': tenant['email'], 'password': password,
                'email_confirm': True, 'app_metadata': {'lp2_smoke': tenant['organisationId']}})
            response_id = created.get('id') if isinstance(created, dict) else None
            valid_id = isinstance(response_id, str) and re.fullmatch(
                r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', response_id)
            matches = (isinstance(created, dict) and response_id == tenant['userId']
                       and created.get('email') == tenant['email'])
            # Preserve a returned unexpected ID without ever authorizing its deletion.
            # Never persist the raw response (which may carry credentials/metadata).
            journal['auth_create_observations'].append({
                'intended_id': tenant['userId'], 'response_id': response_id if valid_id else None,
                'response_id_valid': bool(valid_id), 'matches_intent': matches})
            write_private_journal(journal_path, journal)
            if not matches:
                raise SafeFailure('Created identity differs from recorded intent; preserve the journal for owner review.')
        env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'PLAYWRIGHT_BROWSERS_PATH')}
        env['SMOKE_TARGET_JSON'] = json.dumps(target)
        if fixture_runner is None:
            child('smoke-fixtures.mjs', {**env, 'DIRECT_URL': database})
        else:
            fixture_runner(target, database)
        # The browser child never receives the DB URL or backend credential.
        browser_env = {k: v for k, v in env.items() if k in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'PLAYWRIGHT_BROWSERS_PATH', 'SMOKE_TARGET_JSON')}
        browser_env.update(SMOKE_PUBLIC_KEY=public, SMOKE_PASSWORD_1=passwords[0], SMOKE_PASSWORD_2=passwords[1])
        child('image-smoke.mjs', browser_env)
        verify(inputs)  # Refuse qualification if another deploy raced the smoke.
    finally:
        cleanup(target, key)
    with open(str(journal_path) + '.passed.json', 'x') as stream:
        json.dump({'candidate': candidate, 'release': r, 'checks': [
            'arm-readback-before-and-after', 'browser-login-download', 'pdf-xlsx-csv',
            'two-tenant-api-postgrest-isolation', 'exact-auth-cleanup'], 'result': 'passed'}, stream, indent=2)
    print('PASS: exact deployed candidate smoke and exact-ID Auth cleanup; synthetic application/audit rows retained.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--journal', required=True)
    parser.add_argument('--cleanup-only', action='store_true')
    parser.add_argument('--direct-secret-version', help='Exact owner session URL version, required except for cleanup-only.')
    args = parser.parse_args()
    try:
        run(json.loads(Path(args.candidate).read_text()), json.loads(Path(args.inputs).read_text()), args.journal, args.cleanup_only, args.direct_secret_version)
    except (Exception, KeyboardInterrupt):
        sys.exit('FAIL: cloud smoke/cleanup incomplete. Keep the ID journal and run --cleanup-only; details withheld.')
