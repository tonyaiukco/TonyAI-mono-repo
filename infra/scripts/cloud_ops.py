#!/usr/bin/env python3
"""Owner-only staging operations. Secrets stay in process memory; failures are redacted."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
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
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def command(args, env=None):
    result = subprocess.run(args, cwd=ROOT, env=env, capture_output=True, text=True, check=False)
    if result.returncode:
        raise SafeFailure('Command failed; raw output withheld. Inspect the cloud console securely.')
    return result.stdout.strip()


def secret(vault, name):
    value = command(['az', 'keyvault', 'secret', 'show', '--vault-name', vault,
                     '--name', name, '--query', 'value', '-o', 'tsv', '--only-show-errors'])
    if not value or '<' in value or '\n' in value:
        raise SafeFailure('Required Key Vault secret is empty or still a placeholder.')
    return value


def runtime_secret_id(vault, project):
    # Owner only: Azure returns the value into memory; stdout contains only the validated ID.
    data = json.loads(command(['az', 'keyvault', 'secret', 'show', '--vault-name', vault,
                               '--name', 'database-url', '-o', 'json', '--only-show-errors']))
    if (not re.fullmatch(r'https://' + re.escape(vault) + r'\.vault\.azure\.net/secrets/database-url/[a-f0-9]{32}', data.get('id', ''))
            or data.get('attributes', {}).get('enabled') is not True):
        raise SafeFailure('Invalid or disabled runtime secret version.')
    validate_pooler(data['value'], project, 6543)
    return data['id']


def migrate(vault, project):
    runtime = secret(vault, 'database-url')
    direct = secret(vault, 'direct-url')
    validate_pooler(runtime, project, 6543)
    validate_pooler(direct, project, 5432)
    env = {**os.environ, 'DATABASE_URL': local_ca_url(runtime), 'DIRECT_URL': local_ca_url(direct)}
    # Only deploy the committed migration chain. No reset, migrate dev or seed.
    command(['pnpm', 'db:deploy'], env)
    command(['pnpm', '--filter', '@tonyai/db', 'exec', 'prisma', 'migrate', 'status'], env)
    print('PASS: committed migrations deployed; Prisma migration status is current.')


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


def probe_buckets(base, key):
    for name in BUCKETS:
        path = 'lp2-foundation-probe/' + str(uuid4()) + '.csv'
        payload = b'purpose\nLP2-01 storage probe\n'
        require_success(request(base + '/object/' + name + '/' + path,
                                'POST', key, payload, 'text/csv'))
        try:
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
            require_success(request(base + '/object/' + name, 'DELETE', key,
                                    json.dumps({'prefixes': [path]}).encode()))
            print('PASS: probe object removed: ' + name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['migrate', 'buckets', 'probe-storage', 'runtime-secret-id'])
    parser.add_argument('--vault', required=True)
    parser.add_argument('--project-ref', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z]{20}', args.project_ref):
        raise SafeFailure('Use the 20-letter hosted Supabase project ref, not a URL.')
    if not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]', args.vault):
        raise SafeFailure('Invalid Key Vault name.')
    if os.environ.get('ALLOW_INSECURE_LOCAL_AUTH'):
        raise SafeFailure('Start a clean shell without local-auth settings.')
    release = os.environ.get('RELEASE_SHA', '')
    if (not re.fullmatch(r'[a-f0-9]{40}', release)
            or command(['git', 'rev-parse', 'HEAD']) != release
            or command(['git', 'status', '--porcelain'])):
        raise SafeFailure('Restore a reviewed release and use its clean checkout before cloud operations.')
    if args.operation == 'runtime-secret-id':
        print(runtime_secret_id(args.vault, args.project_ref))
        return
    if args.operation == 'migrate':
        migrate(args.vault, args.project_ref)
        return
    # URL is derived from a strict project ref; credentials cannot be sent to an arbitrary host.
    base = 'https://' + args.project_ref + '.supabase.co/storage/v1'
    key = secret(args.vault, 'supabase-service-role-key')
    if args.operation == 'buckets':
        provision_buckets(base, key)
    else:
        probe_buckets(base, key)


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except (Exception, KeyboardInterrupt):
        print('FAIL: operation interrupted or failed; sensitive details withheld.', file=sys.stderr)
        sys.exit(1)
