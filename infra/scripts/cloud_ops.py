#!/usr/bin/env python3
"""Owner-only staging operations. Secrets stay in process memory; failures are redacted."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler
from uuid import uuid4
from pooler import SafeFailure, validate_pooler, local_ca_url

ROOT = Path(__file__).resolve().parents[2]
XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
BUCKETS = {
    'evidence': (10 * 1024 * 1024, ['application/pdf', 'image/jpeg', 'image/png', XLSX, 'text/csv']),
    'import-sources': (2 * 1024 * 1024, ['text/csv', XLSX]),
    'report-artifacts': (20 * 1024 * 1024, ['application/pdf']),
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def command(args, env=None):
    result = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, check=False)
    if result.returncode:
        raise SafeFailure('Command failed; raw output withheld. Inspect the cloud console securely.')
    return result.stdout.strip()


def secret(vault, name, version):
    from secure_transport import Vault
    client = Vault(vault)
    record = client.get(name, version)
    if not record or record.get('attributes', {}).get('enabled') is not True or not record.get('value'):
        raise SafeFailure('Required enabled Key Vault secret is missing.')
    client.identifier(record, name, version)
    return record['value']


def runtime_secret_id(vault, project, version):
    from secure_transport import Vault
    client = Vault(vault)
    data = client.get('database-url', version)
    if not data:
        raise SafeFailure('Runtime secret is missing.')
    identity = client.identifier(data, 'database-url', version)
    validate_pooler(data['value'], project, 6543)
    return identity


def migrate(vault, project, direct_version):
    raise SafeFailure('Legacy Prisma CLI migration is disabled: it exposes the URL in child argv. Use reviewed hosted_migrate.py and runbook 03.')


def request(url, method='GET', key=None, body=None, content_type='application/json'):
    headers = {}
    if key:
        headers['apikey'] = key
        if not key.startswith(('sb_secret_', 'sb_publishable_')):
            headers['Authorization'] = 'Bearer ' + key
    if body is not None:
        headers['Content-Type'] = content_type
    req = Request(url, data=body, headers=headers, method=method)
    try:
        with build_opener(NoRedirect).open(req, timeout=30) as response:
            return response.status, response.read()
    except HTTPError as error:
        # Never surface URLs (which may be signed), headers or response bodies.
        return error.code, b''


def require_success(result):
    status, body = result
    if not 200 <= status < 300:
        raise SafeFailure('Storage operation failed; check bucket settings and permissions securely.')
    return body


def provision_buckets(base, key):
    existing = json.loads(require_success(request(base + '/bucket', key=key)))
    names = {bucket['id'] for bucket in existing}
    for name, (limit, mime_types) in BUCKETS.items():
        settings = {'public': False,
                    'file_size_limit': limit, 'allowed_mime_types': mime_types}
        if name not in names:
            require_success(request(base + '/bucket', 'POST', key, json.dumps({'id': name, 'name': name, **settings}).encode()))
        else:
            require_success(request(base + '/bucket/' + name, 'PUT', key, json.dumps(settings).encode()))
        actual = json.loads(require_success(request(base + '/bucket/' + name, key=key)))
        if (actual.get('public') is not False or actual.get('file_size_limit') != limit
                or set(actual.get('allowed_mime_types') or []) != set(mime_types)):
            raise SafeFailure('Bucket configuration verification failed.')
        print('PASS: private bucket settings reconciled: ' + name)


def write_private_journal(path, data, exclusive=False):
    """Persist intent/observations without truncating a previous durable receipt."""
    payload = json.dumps(data, indent=2).encode()
    path = Path(path)
    if exclusive:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        return
    # Updates replace atomically; a failed write leaves the preceding intent.
    fd, temporary = tempfile.mkstemp(prefix='.journal-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def probe_buckets(base, key, journal_path=None):
    if journal_path is None:
        journal_path = Path(tempfile.mkdtemp(prefix='tonyai-storage-probe-')) / 'objects.json'
    objects = [{'bucket': name,
                'path': 'lp2-foundation-probe/' + str(uuid4()) + ('.pdf' if name == 'report-artifacts' else '.csv'),
                'upload_attempted': False, 'cleanup_attempted': False,
                'deletion_acknowledged': False} for name in BUCKETS]
    journal = {'storage_origin': base, 'objects': objects,
               'absence_verified': False}
    write_private_journal(journal_path, journal, exclusive=True)
    print('Private exact-object journal: ' + str(journal_path))
    for entry in objects:
        name, path = entry['bucket'], entry['path']
        pdf = name == 'report-artifacts'
        payload = (b'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
                   b'2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n'
                   b'trailer<</Root 1 0 R>>\n%%EOF\n') if pdf else b'purpose\nLP2-01 storage probe\n'
        entry['upload_attempted'] = True
        write_private_journal(journal_path, journal)
        try:
            # A lost upload acknowledgement may still have committed the bytes.
            require_success(request(base + '/object/' + name + '/' + path,
                                    'POST', key, payload, 'application/pdf' if pdf else 'text/csv'))
            public_status, _ = request(base + '/object/public/' + name + '/' + path)
            if public_status not in (400, 401, 403, 404):
                raise SafeFailure('Public object access was not denied.')
            data = json.loads(require_success(request(base + '/object/sign/' + name + '/' + path,
                                                     'POST', key, b'{"expiresIn":60}')))
            signed = data.get('signedURL', '')
            if not signed.startswith('/object/sign/' + name + '/') or urlparse(signed).netloc:
                raise SafeFailure('Unexpected signed URL shape; refusing to follow it.')
            if require_success(request(base + signed)) != payload:
                raise SafeFailure('Signed download did not return the uploaded bytes.')
            print('PASS: upload, public denial, 60-second signed download bytes: ' + name)
        finally:
            entry['cleanup_attempted'] = True
            try:
                write_private_journal(journal_path, journal)
            finally:
                # The already durable upload intent still identifies exact cleanup
                # even if recording the cleanup attempt fails (e.g. disk full).
                require_success(request(base + '/object/' + name, 'DELETE', key,
                                        json.dumps({'prefixes': [path]}).encode()))
                entry['deletion_acknowledged'] = True
                write_private_journal(journal_path, journal)
            print('PASS: deletion acknowledged for the exact probe path: ' + name)


def migration_release(inputs, vault, project):
    from terraform_run import validate_release
    foundation, release = validate_release(inputs)
    if foundation['vault_name'] != vault or release['supabase_project_ref'] != project:
        raise SafeFailure('Migration target differs from the selected release.')
    if (command(['git', 'rev-parse', 'HEAD']) != release['source_sha']
            or command(['git', 'status', '--porcelain'])):
        raise SafeFailure('Migrations require the selected image source SHA and a clean checkout.')
    return release['source_sha']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['migrate', 'buckets', 'probe-storage', 'runtime-secret-id', 'owner-psql'])
    parser.add_argument('--vault', required=True)
    parser.add_argument('--project-ref', required=True)
    parser.add_argument('--source-sha', help='Reviewed helper source SHA for non-migration operations.')
    parser.add_argument('--secret-version', help='Exact selected version for non-migration operations.')
    parser.add_argument('--direct-secret-version', help='Exact owner session URL version for migrations or owner-psql.')
    parser.add_argument('--inputs', help='Required for migrations: selected application release manifest.')
    parser.add_argument('--journal', help='New private exact-object journal for probe-storage; never reuse an old receipt.')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z]{20}', args.project_ref):
        raise SafeFailure('Use the 20-letter hosted Supabase project ref, not a URL.')
    if not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]', args.vault):
        raise SafeFailure('Invalid Key Vault name.')
    if os.environ.get('ALLOW_INSECURE_LOCAL_AUTH'):
        raise SafeFailure('Start a clean shell without local-auth settings.')
    if args.operation == 'migrate':
        if not args.inputs:
            raise SafeFailure('Migrations require --inputs for the selected release.')
        inputs = json.loads(Path(args.inputs).read_text())
        migration_release(inputs, args.vault, args.project_ref)
        if not re.fullmatch(r'[a-f0-9]{32}', args.direct_secret_version or ''):
            raise SafeFailure('Migrations require the selected --direct-secret-version.')
        migrate(args.vault, args.project_ref, args.direct_secret_version)
        return
    release = args.source_sha or ''
    if (not re.fullmatch(r'[a-f0-9]{40}', release)
            or command(['git', 'rev-parse', 'HEAD']) != release
            or command(['git', 'status', '--porcelain'])):
        raise SafeFailure('Supply --source-sha for the reviewed clean helper checkout before cloud operations.')
    if args.operation == 'owner-psql':
        if not re.fullmatch(r'[a-f0-9]{32}', args.direct_secret_version or ''):
            raise SafeFailure('Owner psql requires an exact --direct-secret-version.')
        from owner_psql import owner_psql
        owner_psql(secret(args.vault, 'direct-url', args.direct_secret_version), args.project_ref)
        return
    if not re.fullmatch(r'[a-f0-9]{32}', args.secret_version or ''):
        raise SafeFailure('Supply an exact --secret-version from the selected release or setup journal.')
    if args.operation == 'runtime-secret-id':
        print(runtime_secret_id(args.vault, args.project_ref, args.secret_version))
        return
    # URL is derived from a strict project ref; credentials cannot be sent to an arbitrary host.
    base = 'https://' + args.project_ref + '.supabase.co/storage/v1'
    key = secret(args.vault, 'supabase-service-role-key', args.secret_version)
    if args.operation == 'buckets':
        provision_buckets(base, key)
    else:
        probe_buckets(base, key, args.journal)


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except (Exception, KeyboardInterrupt):
        print('FAIL: operation interrupted or failed; sensitive details withheld.', file=sys.stderr)
        sys.exit(1)
