#!/usr/bin/env python3
"""Separate owner-approved Sweden smoke; prepare is offline and never authorizes."""
import argparse
import getpass
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import tempfile
import warnings
from candidate import clean_source
from cloud_smoke import auth_call, cleanup
from cloud_ops import secret
from qa_candidate_artifact import download
from qa_contract import load, require
from qa_database_url import validate as validate_database
from qa_discovery import digest
from qa_images import public_material
from qa_smoke_contract import bind, target_for, validate_journal
from qa_smoke_readback import collect, stamp, stable
from qa_smoke_child import child


def write_new(path, value):
    """Exclusive, private, durable intent before the first remote mutation."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    parent = os.open(Path(path).parent, os.O_RDONLY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def prepare(evidence, accepted_hash, journal_path):
    context = bind(evidence, accepted_hash)
    journal = dict(schema=1, evidence_sha256=digest(evidence), target=target_for(context['inputs']))
    write_new(journal_path, journal)
    return dict(status='BLOCKED_DRAFT', authorization=False, authenticated_provenance=False,
                journal_sha256=digest(journal), evidence_sha256=digest(evidence))


def authenticate(evidence):
    unit = evidence['unit7']
    wanted = unit['candidate_provenance']
    candidate, provenance = download('tonyaiukco/TonyAI-mono-repo', unit['inputs']['release']['source_sha'],
                                     wanted['run_id'], with_provenance=True)
    require(candidate == unit['candidate'] and provenance == wanted)


def credentials(inputs, certificate):
    # Explicit owner terminal channel; never application-vault direct-url or env.
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        public = getpass.getpass('QA public anon key (hidden): ')
        public_material(inputs['release'], public, certificate)
        database = getpass.getpass('Owner-only QA fixture database URL (hidden): ')
    validate_database(database, owner=True)
    return public, database


def backend_key(inputs):
    return secret(inputs['foundation']['vault_name'], 'supabase-service-role-key',
                  inputs['release']['backend_secret_version'])


def exercise(target, database, public, key, certificate):
    passwords = [secrets.token_urlsafe(32), secrets.token_urlsafe(32)]
    for tenant, password in zip(target['tenants'], passwords):
        created = auth_call(target['supabase'], key, 'POST', '', dict(id=tenant['userId'],
            email=tenant['email'], password=password, email_confirm=True,
            app_metadata={'lp2_smoke': tenant['organisationId']}))
        require(created.get('id') == tenant['userId'] and created.get('email') == tenant['email'])
    env = {k: v for k, v in os.environ.items() if k in
           ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'PLAYWRIGHT_BROWSERS_PATH')}
    env['SMOKE_TARGET_JSON'] = json.dumps(target)
    with tempfile.TemporaryDirectory(prefix='qa-smoke-public-ca-') as directory:
        ca = Path(directory) / 'ca.crt'
        ca.write_bytes(certificate)
        child('smoke-fixtures.mjs', {**env, 'DIRECT_URL': database, 'SMOKE_DB_CA_FILE': str(ca)})
    # Neither owner database URL, backend key nor their ambient aliases reach this child.
    child('image-smoke.mjs', {**env, 'SMOKE_PUBLIC_KEY': public,
                            'SMOKE_PASSWORD_1': passwords[0], 'SMOKE_PASSWORD_2': passwords[1]})


def run(evidence, accepted_hash, journal_path, journal_hash, certificate_path=None, *, cleanup_only=False):
    context = bind(evidence, accepted_hash)
    inputs = context['inputs']
    target = validate_journal(load(journal_path), journal_hash, evidence, inputs)
    attempt_path, passed_path = Path(str(journal_path) + '.attempt.json'), Path(str(journal_path) + '.passed.json')
    if cleanup_only:
        attempt = load(attempt_path)
        require(attempt == dict(journal_sha256=journal_hash, evidence_sha256=accepted_hash))
    else:
        require(not os.path.lexists(attempt_path) and not os.path.lexists(passed_path))
    authenticate(evidence)
    before = stable(context, collect(evidence, context))  # Actual readback before credentials.
    if cleanup_only:
        cleanup(target, backend_key(inputs))
        return
    certificate = Path(certificate_path).read_bytes()  # Public material only.
    public, database = credentials(inputs, certificate)
    key = backend_key(inputs)
    # Recheck after interactive input, before any Auth/fixture mutation.
    require(stable(context, collect(evidence, context)) == before)
    write_new(attempt_path, dict(journal_sha256=journal_hash, evidence_sha256=accepted_hash))
    try:
        exercise(target, database, public, key, certificate)
        require(stable(context, collect(evidence, context)) == before)
    finally:
        cleanup(target, key)
    require(stable(context, collect(evidence, context)) == before)
    write_new(passed_path, dict(result='passed', scope='narrow-smoke-only', authorization=False,
        journal_sha256=journal_hash, evidence_sha256=accepted_hash,
        release_id=inputs['release']['release_id'], source_sha=inputs['release']['source_sha'],
        api_digest=inputs['release']['api_digest'], web_digest=inputs['release']['web_digest'],
        public_readback_sha256=digest(before), completed_at=stamp(),
        checks=['browser-login-download', 'pdf-xlsx-csv', 'two-tenant-api-postgrest-isolation',
                'same-release-public-readbacks', 'exact-auth-cleanup'], application_audit_rows_retained=True))


def interrupted(_signal, _frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['prepare', 'run', 'cleanup'])
    for name in ('evidence', 'accepted-evidence-sha256', 'journal'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--journal-sha256')
    parser.add_argument('--public-db-ca')
    parser.add_argument('--helper-source-sha', help='Reviewed clean helper checkout; distinct from historical candidate SHA.')
    parser.add_argument('--approved-smoke', action='store_true')
    parser.add_argument('--approved-cleanup', action='store_true')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        evidence = load(args.evidence)
        if args.operation == 'prepare':
            print(json.dumps(prepare(evidence, args.accepted_evidence_sha256, args.journal), sort_keys=True))
            return
        require(args.approved_cleanup if args.operation == 'cleanup' else args.approved_smoke)
        clean_source(args.helper_source_sha)
        require(sys.stdin.isatty())  # Never fall back to echoing credentials from redirected stdin.
        run(evidence, args.accepted_evidence_sha256, args.journal, args.journal_sha256,
            args.public_db_ca, cleanup_only=args.operation == 'cleanup')
    except (Exception, KeyboardInterrupt):
        raise SystemExit('FAIL: QA smoke/cleanup incomplete; preserve the bound journal. Sensitive details withheld.') from None
    print('PASS: exact Auth cleanup' if args.operation == 'cleanup' else
          'PASS: narrow QA smoke and exact Auth cleanup; application/audit rows retained. Operational acceptance remains separate.')


if __name__ == '__main__':
    main()
