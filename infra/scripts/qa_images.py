#!/usr/bin/env python3
"""Explicitly approved QA build/push; all public inputs are bound before login."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import tempfile
from candidate import clean_source, fingerprint
from qa_contract import ROOT, load, match, origins, require, sha256, target
from scan_browser_assets import scan


def public_material(build, key, certificate):
    """Reject service credentials and private keys without printing any material."""
    require(isinstance(key, str) and len(key) < 8192 and sha256(key.encode()) == build['browser_key_sha256'])
    # r02 currently publishes signed legacy anon JWTs, not hosted project keys.
    parts = key.split('.')
    require(len(parts) == 3 and all(re.fullmatch(r'[A-Za-z0-9_-]+', p) for p in parts))
    claims = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
    require(claims.get('role') == 'anon')
    require(len(certificate) < 65536 and sha256(certificate) == build['db_ca_sha256'])
    pem = certificate.decode('ascii').strip()
    require(re.fullmatch(r'-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----', pem) is not None)
    ssl.PEM_cert_to_DER_cert(pem)


def build_command(kind, selected, directory):
    foundation, build = selected['foundation'], selected['build']
    registry = foundation['registry_name'] + '.azurecr.io'
    cmd = ['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--file', f'apps/{kind}/Dockerfile',
           '--label', 'org.opencontainers.image.revision=' + build['source_sha'],
           '--build-arg', 'NODE_IMAGE=' + build['node_image'], '--provenance=mode=min', '--sbom=true',
           '--tag', f"{registry}/tonyai/{kind}:{build['source_sha']}",
           '--metadata-file', str(directory / (kind + '.json'))]
    if kind == 'api':
        cmd += ['--build-arg', 'QA_DB_CA_SHA256=' + build['db_ca_sha256'],
                '--secret', 'id=qa_db_ca,src=' + str(directory / 'db-ca.crt')]
    else:
        for key in ('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_API_BASE_URL'):
            cmd += ['--build-arg', key]
    return cmd + ['--push', '.']


def run(cmd, env=None):
    # Build output can include browser keys/build values. Keep it private and
    # bounded by the workflow timeout; never echo child output into public logs.
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(cmd, cwd=ROOT, env=env, stdout=output, stderr=output, timeout=1800)
        require(result.returncode == 0)


def build_images(selected, key, certificate, output):
    target(selected)
    public_material(selected['build'], key, certificate)
    clean_source(selected['build']['source_sha'])
    require(not output.exists())
    # Verify account metadata before any registry mutation. No credential queries.
    account = json.loads(subprocess.check_output(['az', 'account', 'show', '--query', '{id:id,tenantId:tenantId}', '-o', 'json'], text=True))
    require(account == {'id': selected['foundation']['subscription_id'], 'tenantId': selected['foundation']['tenant_id']})
    from auth_settings import validate_auth_settings
    from cloud_ops import request, require_success
    endpoint = selected['build']['supabase_origin'] + '/auth/v1/settings'
    require(request(endpoint, key='invalid-qa-key')[0] == 401)
    validate_auth_settings(json.loads(require_success(request(endpoint, key=key))))
    env = {**os.environ, 'NEXT_PUBLIC_SUPABASE_ANON_KEY': key,
           'NEXT_PUBLIC_SUPABASE_URL': selected['build']['supabase_origin'],
           'NEXT_PUBLIC_API_BASE_URL': origins(selected['foundation'])['api'] + '/api/v1'}
    result = {'schema': 1, 'target': selected, **fingerprint()}
    with tempfile.TemporaryDirectory(prefix='tonyai-qa-build-') as directory:
        work = Path(directory)
        (work / 'db-ca.crt').write_bytes(certificate)
        run(['openssl', 'x509', '-in', str(work / 'db-ca.crt'), '-noout'])
        run(['az', 'acr', 'login', '--name', selected['foundation']['registry_name'], '--output', 'none'])
        for kind in ('api', 'web'):
            run(build_command(kind, selected, work), env)
            digest = load(work / (kind + '.json'))['containerimage.digest']
            match(r'sha256:[a-f0-9]{64}', digest)
            result[kind + '_digest'] = digest
            image = selected['foundation']['registry_name'] + f'.azurecr.io/tonyai/{kind}@' + digest
            run(['docker', 'pull', '--platform', 'linux/amd64', image])
            container = subprocess.check_output(['docker', 'create', '--platform', 'linux/amd64', image], text=True).strip()
            match(r'[a-f0-9]{64}', container)
            try:
                if kind == 'api':
                    run(['docker', 'cp', container + ':/app/infra/certs/qa-db-ca.crt', str(work / 'image-ca.crt')])
                    require((work / 'image-ca.crt').read_bytes() == certificate)
                else:
                    run(['docker', 'cp', container + ':/app/apps/web/.next/static', str(work / 'static')])
                    scan(work / 'static')
            finally:
                run(['docker', 'rm', container])
    with output.open('x') as stream:
        json.dump(result, stream, indent=2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True)
    parser.add_argument('--public-db-ca', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--approved-push', action='store_true')
    args = parser.parse_args()
    try:
        require(args.approved_push)
        build_images(load(args.target), os.environ['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
                     Path(args.public_db_ca).read_bytes(), Path(args.output))
    except Exception:
        raise SystemExit('FAIL: QA candidate not published as accepted; inspect partial images privately. A retry needs new approval.') from None
    print('PASS: immutable QA candidate with BuildKit provenance/SBOM and browser scan; live image acceptance remains required.')
