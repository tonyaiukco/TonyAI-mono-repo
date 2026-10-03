#!/usr/bin/env python3
"""Owner-run exact-release smoke. Credentials stay in memory; journal holds IDs only."""
import argparse
import getpass
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import uuid
from candidate import bind
from check_browser_key import check_inputs
from cloud_ops import secret, request
from deploy_apps import verify
from pooler import SafeFailure, validate_pooler
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


def run(candidate, inputs, journal_path, cleanup_only=False):
    bind(candidate, inputs, inputs['release']['source_sha'])
    f, r = inputs['foundation'], inputs['release']
    key = secret(f['vault_name'], 'supabase-service-role-key', r['backend_secret_version'])
    if cleanup_only:
        journal = json.loads(Path(journal_path).read_text())
        if journal['candidate'] != candidate:
            raise SafeFailure('Cleanup candidate differs from the ID journal.')
        target = journal['target']
        # Validate every target/ID using the same contract without credentials.
        child('validate-smoke.mjs', {**os.environ, 'SMOKE_TARGET_JSON': json.dumps(target)})
        if (target['sourceSha'] != candidate['source_sha'] or target['projectRef'] != r['supabase_project_ref']
                or target['web'] != candidate['web_origin'] or target['api'] != candidate['api_origin'] + '/api/v1'):
            raise SafeFailure('Cleanup target differs from the selected candidate.')
        cleanup(target, key)
        return
    verify(inputs)  # No fixture writes until exact running images/revisions match.
    public = getpass.getpass('Staging public browser key: ')
    check_inputs({'SUPABASE_PROJECT_REF': r['supabase_project_ref'], 'NEXT_PUBLIC_SUPABASE_ANON_KEY': public,
                  'PREFIX': f['prefix'], 'ACA_DEFAULT_DOMAIN': f['default_domain'],
                  'API_ORIGIN': candidate['api_origin'], 'NEXT_PUBLIC_API_BASE_URL': candidate['api_origin'] + '/api/v1',
                  'NEXT_PUBLIC_SUPABASE_URL': 'https://' + r['supabase_project_ref'] + '.supabase.co'})
    target = target_for(candidate)
    # Intent is durable before any Auth POST; no passwords/tokens in this file.
    with open(journal_path, 'x') as stream:
        json.dump({'candidate': candidate, 'target': target}, stream, indent=2)
    passwords = [secrets.token_urlsafe(32), secrets.token_urlsafe(32)]
    try:
        for tenant, password in zip(target['tenants'], passwords):
            created = auth_call(target['supabase'], key, 'POST', '', {
                'id': tenant['userId'], 'email': tenant['email'], 'password': password,
                'email_confirm': True, 'app_metadata': {'lp2_smoke': tenant['organisationId']}})
            if created.get('id') != tenant['userId'] or created.get('email') != tenant['email']:
                raise SafeFailure('Created identity differs from recorded intent.')
        database = secret(f['vault_name'], 'database-url', r['database_secret_version'])
        validate_pooler(database, r['supabase_project_ref'], 6543)
        env = {**os.environ, 'SMOKE_TARGET_JSON': json.dumps(target)}
        child('smoke-fixtures.mjs', {**env, 'DATABASE_URL': database})
        # The browser child never receives the DB URL or backend credential.
        browser_env = {k: v for k, v in env.items() if not any(word in k for word in ('SECRET', 'TOKEN', 'PASSWORD', 'DATABASE', 'DIRECT_URL', 'SERVICE_KEY', 'SERVICE_ROLE'))}
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
    args = parser.parse_args()
    try:
        run(json.loads(Path(args.candidate).read_text()), json.loads(Path(args.inputs).read_text()), args.journal, args.cleanup_only)
    except (Exception, KeyboardInterrupt):
        sys.exit('FAIL: cloud smoke/cleanup incomplete. Keep the ID journal and run --cleanup-only; details withheld.')
