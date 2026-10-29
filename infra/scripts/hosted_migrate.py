#!/usr/bin/env python3
"""Separately approved hosted migration/probe with distinct helper and release source."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
from urllib.parse import parse_qs, urlencode, urlparse
from cloud_ops import secret
from migration_binding import clean, copy_engine, prepare
from migration_runner import inspect_image, run
from pooler import SafeFailure, validate_pooler

ROOT = Path(__file__).resolve().parents[2]


def validate_journal(journal, inputs, version):
    versions = journal.get('versions', {})
    if (journal.get('configured') is not True
            or journal.get('project_ref') != inputs['release']['supabase_project_ref']
            or versions.get('direct_url_version') != version
            or versions.get('backend_secret_version') != inputs['release']['backend_secret_version']):
        raise SafeFailure('Canonical journal target or exact secret versions differ from the selected operation.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['verify', 'probe', 'migrate', 'owner-check', 'runtime-check'])
    parser.add_argument('--source-sha', required=True, help='Reviewed clean helper SHA; separate from image source.')
    parser.add_argument('--migration-source', required=True)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--journal', required=True, help='Existing canonical configured setup journal; never overwritten.')
    parser.add_argument('--engine-file', required=True)
    parser.add_argument('--direct-secret-version', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{32}', args.direct_secret_version):
        raise SafeFailure('An exact approved owner secret version is required.')
    if any(os.environ.get(k) for k in ('DATABASE_URL', 'DIRECT_URL', 'NODE_OPTIONS', 'DEBUG', 'ALLOW_INSECURE_LOCAL_AUTH')):
        raise SafeFailure('Use a clean owner shell without ambient credentials or debug overrides.')
    clean(ROOT, args.source_sha)
    inputs = json.loads(Path(args.inputs).read_text())
    candidate = json.loads(Path(args.candidate).read_text())
    validate_journal(json.loads(Path(args.journal).read_text()), inputs, args.direct_secret_version)
    # Bundle holds only committed public input. No URL/password is written to disk.
    with tempfile.TemporaryDirectory(prefix='tonyai-migration-') as work:
        bundle, engine = Path(work) / 'bundle', Path(work) / 'engine'
        bundle.mkdir(mode=0o755); engine.mkdir(mode=0o755)
        image = prepare(Path(args.migration_source).resolve(), inputs, candidate, bundle)
        copy_engine(args.engine_file, engine)
        for path in bundle.rglob('*'): path.chmod(0o755 if path.is_dir() else 0o444)
        docker_env = inspect_image(image)
        if args.operation == 'verify':
            print('PASS: helper, release, candidate, committed inputs, engine and cached image; no secret read or connection.')
            return
        project = inputs['release']['supabase_project_ref']
        runtime = args.operation == 'runtime-check'
        version = inputs['release']['database_secret_version'] if runtime else args.direct_secret_version
        direct = secret(inputs['foundation']['vault_name'], 'database-url' if runtime else 'direct-url', version)
        validate_pooler(direct, project, 6543 if runtime else 5432)
        parsed = urlparse(direct)
        query = parse_qs(parsed.query, keep_blank_values=True)
        query['sslcert'] = ['/migration/ca.crt']
        adjusted = parsed._replace(query=urlencode(query, doseq=True)).geturl()
        print(json.dumps(run(image, bundle, engine, adjusted, args.operation, env=docker_env)))


def interrupted(signum, frame):
    raise KeyboardInterrupt()


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except SafeFailure as error:
        sys.exit('STOP: ' + str(error))
    except (Exception, KeyboardInterrupt):
        sys.exit('STOP: migration helper failed; details withheld; no retry.')
