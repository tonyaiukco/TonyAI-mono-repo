#!/usr/bin/env python3
"""One bounded no-mail lifecycle bootstrap; no seed, invite, resend or cohort access."""
import argparse
from datetime import datetime, timezone
import getpass
import json
from pathlib import Path
import re
import secrets
import sys
from uuid import uuid4
from cloud_ops import secret, write_private_journal
from cloud_smoke import auth_call
from hosted_smoke import prepared
from hosted_probe_runner import run as run_probe, validate_receipt_location
from pooler import SafeFailure, validate_pooler


def target_for(candidate):
    user, organisation = str(uuid4()), str(uuid4())
    return {'mode': 'hosted-l10-lifecycle', 'sourceSha': candidate['source_sha'],
            'projectRef': candidate['supabase_project_ref'], 'userId': user, 'organisationId': organisation,
            'email': 'lp2-l10-' + user + '@tonyai.test', 'name': 'L10 synthetic acceptance ' + organisation}


def ban_state(user, want_banned):
    value = user.get('banned_until') if isinstance(user, dict) else None
    if value is None:
        return not want_banned
    try:
        until = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if until.tzinfo is None:
            return False
        return (until > datetime.now(timezone.utc)) is want_banned
    except (ValueError, TypeError, AttributeError):
        return False


def quarantine(base, key, target):
    user = auth_call(base, key, 'GET', '/' + target['userId'], missing=True)
    if user is None:
        return True
    if (user.get('id') != target['userId'] or user.get('email') != target['email']
            or user.get('app_metadata', {}).get('l10_lifecycle_bootstrap') != target['organisationId']):
        raise SafeFailure('Bootstrap quarantine identity differs; no foreign mutation.')
    auth_call(base, key, 'PUT', '/' + target['userId'], {'ban_duration': '876000h', 'password': secrets.token_urlsafe(32) + 'Aa1!'})
    user = auth_call(base, key, 'GET', '/' + target['userId'])
    return (isinstance(user, dict) and user.get('id') == target['userId']
            and user.get('email') == target['email']
            and user.get('app_metadata', {}).get('l10_lifecycle_bootstrap') == target['organisationId']
            and ban_state(user, True))


def run(candidate, inputs, journal_path, helper_sha, source, direct_version):
    journal_path = validate_receipt_location(journal_path)
    if journal_path.exists() or not re.fullmatch(r'[a-f0-9]{32}', direct_version or ''):
        raise SafeFailure('Require a fresh private journal and exact owner-secret version.')
    with prepared(helper_sha, source, candidate, inputs) as (image, bundle, env, seal, ca_hash):
        foundation, release = inputs['foundation'], inputs['release']
        password = getpass.getpass('New no-mail bootstrap password from your password manager: ')
        if not 12 <= len(password) <= 128:
            raise SafeFailure('Bootstrap password must satisfy the hosted policy.')
        database = secret(foundation['vault_name'], 'direct-url', direct_version)
        validate_pooler(database, release['supabase_project_ref'], 5432)
        key = secret(foundation['vault_name'], 'supabase-service-role-key', release['backend_secret_version'])
        target = target_for(candidate)
        journal = {'candidate': candidate, 'target': target, 'auth_attempted': False,
                   'bootstrap_complete': False, 'intended_auth_quarantined_on_failure': False,
                   'quarantine_attempted': False, 'unexpected_response_requires_review': False,
                   'unexpected_response_id': None, 'retirement_required': True}
        write_private_journal(journal_path, journal, exclusive=True)
        base = 'https://' + target['projectRef'] + '.supabase.co'
        try:
            journal['auth_attempted'] = True; write_private_journal(journal_path, journal)
            created = auth_call(base, key, 'POST', '', {'id': target['userId'], 'email': target['email'],
                                'password': password, 'email_confirm': True, 'ban_duration': '876000h',
                                'app_metadata': {'l10_lifecycle_bootstrap': target['organisationId']}})
            response_id = created.get('id') if isinstance(created, dict) else None
            if isinstance(response_id, str) and re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', response_id):
                journal['unexpected_response_id'] = response_id if response_id != target['userId'] else None
            journal['unexpected_response_requires_review'] = response_id != target['userId']
            write_private_journal(journal_path, journal)
            if (not isinstance(created, dict) or response_id != target['userId'] or created.get('email') != target['email']
                    or created.get('app_metadata', {}).get('l10_lifecycle_bootstrap') != target['organisationId']
                    or not ban_state(created, True)):
                raise SafeFailure('Bootstrap Auth response differs; preserve exact observations, no foreign cleanup.')
            # Born-banned identity cannot sign in before the atomic audited rows exist.
            run_probe(image, bundle, 'bootstrap', {'operation': 'bootstrap', 'target': target,
                      'url': database, 'caSha256': ca_hash}, str(journal_path) + '.container.json', seal, env)
            updated = auth_call(base, key, 'PUT', '/' + target['userId'], {'ban_duration': 'none'})
            if updated.get('id') != target['userId'] or updated.get('email') != target['email']:
                raise SafeFailure('Bootstrap unban response differs; no retry.')
            observed = auth_call(base, key, 'GET', '/' + target['userId'])
            if (observed.get('id') != target['userId'] or observed.get('email') != target['email']
                    or observed.get('app_metadata', {}).get('l10_lifecycle_bootstrap') != target['organisationId']
                    or not ban_state(observed, False)):
                raise SafeFailure('Bootstrap unban readback did not pass; no retry.')
            journal['bootstrap_complete'] = True; write_private_journal(journal_path, journal)
            return {'status': 'BOOTSTRAP_CREATED'}
        except BaseException:
            if journal['auth_attempted']:
                # No deletion: DB rows may have committed even if acknowledgement was lost.
                # Ban only the exact intended metadata-matched identity, preserving D17.
                journal['quarantine_attempted'] = True
                try:
                    write_private_journal(journal_path, journal)
                finally:
                    try:
                        journal['intended_auth_quarantined_on_failure'] = quarantine(base, key, target)
                    finally:
                        write_private_journal(journal_path, journal)
                if not journal['intended_auth_quarantined_on_failure']:
                    raise SafeFailure('Bootstrap quarantine unconfirmed; stop and preserve exact journal.') from None
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('helper-sha', 'application-source', 'candidate', 'inputs', 'journal', 'direct-secret-version'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    run(json.loads(Path(args.candidate).read_text()), json.loads(Path(args.inputs).read_text()), args.journal,
        args.helper_sha, args.application_source, args.direct_secret_version)
    print('PASS: separate no-mail synthetic administrator created; exact-organisation retirement still required.')


if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt):
        sys.exit('STOP: bootstrap incomplete; inspect private exact-ID/quarantine receipts; no retry or deletion.')
