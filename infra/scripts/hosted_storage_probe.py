#!/usr/bin/env python3
"""Bounded exact-release Storage acceptance; no bucket reconciliation or app edits."""
import argparse
import getpass
import json
from pathlib import Path
import re
import sys
from uuid import uuid4
from check_browser_key import check_inputs
from cloud_ops import secret
from hosted_smoke import prepared
from hosted_probe_runner import run as run_probe, validate_receipt_location
from pooler import SafeFailure


def run(candidate, inputs, journal, helper_sha, source):
    validate_receipt_location(journal)
    with prepared(helper_sha, source, candidate, inputs) as (image, bundle, env, seal, _):
        release, foundation = inputs['release'], inputs['foundation']
        public = getpass.getpass('Hosted public browser key: ')
        check_inputs({'SUPABASE_PROJECT_REF': release['supabase_project_ref'], 'NEXT_PUBLIC_SUPABASE_ANON_KEY': public,
                      'PREFIX': foundation['prefix'], 'ACA_DEFAULT_DOMAIN': foundation['default_domain'],
                      'API_ORIGIN': candidate['api_origin'], 'NEXT_PUBLIC_API_BASE_URL': candidate['api_origin'] + '/api/v1',
                      'NEXT_PUBLIC_SUPABASE_URL': 'https://' + release['supabase_project_ref'] + '.supabase.co'})
        user_id = getpass.getpass('Approved disposable Auth user UUID: ')
        if not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', user_id):
            raise SafeFailure('An exact approved disposable identity is required.')
        token = getpass.getpass('That disposable user access token (in memory only): ')
        key = secret(foundation['vault_name'], 'supabase-service-role-key', release['backend_secret_version'])
        payload = {'operation': 'storage', 'projectRef': release['supabase_project_ref'],
                   'origin': 'https://' + release['supabase_project_ref'] + '.supabase.co',
                   'key': key, 'publicKey': public, 'userToken': token, 'userId': user_id,
                   'releaseId': release['release_id'], 'sourceSha': release['source_sha'], 'nonce': str(uuid4())}
        return run_probe(image, bundle, 'storage', payload, Path(journal), seal, env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('helper-sha', 'application-source', 'candidate', 'inputs', 'journal'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    run(json.loads(Path(args.candidate).read_text()), json.loads(Path(args.inputs).read_text()),
        args.journal, args.helper_sha, args.application_source)
    print('PASS: private Storage settings, 12 bounded uploads, signed expiry and exact-object absence.')


if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt):
        sys.exit('STOP: Storage acceptance incomplete; preserve exact object/container receipts; no retry.')
