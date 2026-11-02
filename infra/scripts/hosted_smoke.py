#!/usr/bin/env python3
"""Hosted smoke with separate clean helper/application sources and a Linux fixture."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
from cloud_smoke import execute
from hosted_probe_runner import run as run_probe, validate_receipt_location
from migration_binding import clean, committed, prepare
from migration_runner import inspect_image
from pooler import SafeFailure, validate_pooler
from terraform_run import ROOT

PUBLIC_SCRIPTS = ('hosted-smoke-fixture.mjs', 'hosted-storage-probe.mjs',
                  'smoke-fixture-transaction.mjs', 'smoke-contract.mjs', 'hosted-lifecycle-bootstrap.mjs',
                  'hosted-lifecycle-operator.mjs')


@contextmanager
def prepared(helper_sha, source, candidate, inputs):
    if any(os.environ.get(key) for key in ('DIRECT_URL', 'DATABASE_URL', 'NODE_OPTIONS', 'DEBUG', 'ALLOW_INSECURE_LOCAL_AUTH')):
        raise SafeFailure('Use a clean owner shell; credentials enter only after preparation.')
    clean(ROOT, helper_sha)
    with tempfile.TemporaryDirectory(prefix='tonyai-hosted-public-') as directory:
        bundle = Path(directory)
        image = prepare(Path(source).resolve(), inputs, candidate, bundle)
        for name in PUBLIC_SCRIPTS:
            (bundle / name).write_bytes(committed(ROOT, helper_sha, 'infra/scripts/' + name))
        # Resolve and inspect before any credential read or cloud request; no pull.
        env = inspect_image(image)
        hashes = {p.relative_to(bundle).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in bundle.rglob('*') if p.is_file()}
        seal = hashlib.sha256(json.dumps({'helper_sha': helper_sha, 'candidate': candidate,
                                        'public_files': hashes}, sort_keys=True).encode()).hexdigest()
        for path in bundle.rglob('*'):
            path.chmod(0o755 if path.is_dir() else 0o444)
        bundle.chmod(0o755)
        yield image, bundle, env, seal, hashes['ca.crt']


def run(candidate, inputs, journal, helper_sha, source, direct_version=None, verify_only=False, cleanup_only=False):
    validate_receipt_location(journal)
    if verify_only and cleanup_only:
        raise SafeFailure('Choose one bounded operation.')
    with prepared(helper_sha, source, candidate, inputs) as (image, bundle, env, seal, ca_hash):
        if verify_only:
            return run_probe(image, bundle, 'verify', {'operation': 'verify', 'caSha256': ca_hash},
                             str(journal) + '.runtime.json', seal, env)
        def fixtures(target, url):
            validate_pooler(url, candidate['supabase_project_ref'], 5432)
            return run_probe(image, bundle, 'fixtures', {'operation': 'fixtures', 'target': target,
                             'url': url, 'caSha256': ca_hash}, str(journal) + '.fixture.json', seal, env)
        return execute(candidate, inputs, journal, cleanup_only, direct_version, fixture_runner=fixtures,
                       source_binding=(helper_sha, source))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper-sha', required=True)
    parser.add_argument('--application-source', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--journal', required=True)
    parser.add_argument('--direct-secret-version')
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--cleanup-only', action='store_true')
    args = parser.parse_args()
    result = run(json.loads(Path(args.candidate).read_text()), json.loads(Path(args.inputs).read_text()),
                 Path(args.journal), args.helper_sha, args.application_source, args.direct_secret_version,
                 args.verify_only, args.cleanup_only)
    if args.verify_only:
        print('PASS: separate committed sources and cached Linux runtime verified offline; no cloud request.')
    elif result is not None:
        print('PASS: bounded hosted smoke completed.')


if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt):
        sys.exit('STOP: hosted smoke incomplete; preserve exact private journals; no retry.')
