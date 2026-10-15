#!/usr/bin/env python3
"""Secret-safe read-only credential pair probes. No user creation, writes or PD-3 closure."""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, build_opener, ProxyHandler
sys.path.insert(0, str(Path(__file__).resolve().parent))
from selfhost_escrow import NoRedirect
from replacement_host import check, RUNTIME
from replacement_custody_host import collect
from replacement_custody import ENV

HTTP_CASES = {
    'dashboard': ('api-gw', 8000, '/', 'basic'),
    'auth-admin': ('auth', 9999, '/admin/users?page=1&per_page=1', 'bearer'),
    'rest-service': ('rest', 3000, '/', 'bearer'),
    'storage-service': ('storage', 5000, '/bucket', 'bearer'),
    'realtime-admin': ('realtime', 4000, '/api/tenants', 'bearer'),
}
DB_ROLES = ('postgres', 'supabase_admin', 'authenticator', 'pgbouncer', 'supabase_auth_admin',
            'supabase_functions_admin', 'supabase_storage_admin')
SECRET_FIELDS = ('POSTGRES_PASSWORD', 'JWT_SECRET', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'JWT_KEYS', 'JWT_JWKS',
                 'DASHBOARD_PASSWORD', 'SECRET_KEY_BASE', 'REALTIME_DB_ENC_KEY', 'VAULT_ENC_KEY',
                 'PG_META_CRYPTO_KEY', 'S3_PROTOCOL_ACCESS_KEY_ID', 'S3_PROTOCOL_ACCESS_KEY_SECRET',
                 'MINIO_ROOT_PASSWORD', 'LOGFLARE_PUBLIC_ACCESS_TOKEN', 'LOGFLARE_PRIVATE_ACCESS_TOKEN')


def parse_environment(data):
    if not data or len(data) > 25000:
        raise ValueError('Bounded private environment required.')
    import shlex
    result = {}
    for line in data.decode().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'([A-Z][A-Z_0-9]*)=(.*)', line)
        if not match or match[1] in result:
            raise ValueError('Ambiguous environment.')
        value = shlex.split(match[2], comments=True)
        if len(value) > 1:
            raise ValueError('Unsupported environment value.')
        result[match[1]] = value[0] if value else ''
    if any(not result.get(name) for name in SECRET_FIELDS):
        raise ValueError('Incomplete credential inventory.')
    return result


def classify_pair(new, old, success=200, refused=(401,)):
    # Denied transport, redirects, 403 policy refusals and 5xx are not proof of bad credentials.
    if new == success and old in refused:
        return 'PASS'
    if old == success:
        return 'FAIL_OLD_ACCEPTED'
    return 'INCONCLUSIVE'


def probe_pair(request, new_headers, old_headers):
    try:
        first = request(new_headers)
        old = request(old_headers)
        last = request(new_headers)
        return classify_pair(first, old) if last == first else 'INCONCLUSIVE'
    except Exception:
        return 'INCONCLUSIVE'


def http_status(url, headers, s3=False):
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(Request(url, headers=headers), timeout=10) as response:
            return response.status  # Never return bodies containing identities or error echoes.
    except HTTPError as error:
        if s3 and error.code == 403:
            import xml.etree.ElementTree as ET
            try:
                code = ET.fromstring(error.read(4096)).findtext('Code')
                return 401 if code in ('SignatureDoesNotMatch', 'InvalidAccessKeyId') else 403
            except Exception:
                return 0
        return error.code


def container(service, locked):
    name = {'api-gw': 'supabase-envoy', 'realtime': 'realtime-dev.supabase-realtime'}.get(service, 'supabase-' + service)
    raw = subprocess.run(['docker', 'inspect', '--format', '{{json .}}', name], capture_output=True, check=True, timeout=15).stdout
    inspected = json.loads(raw)
    labels = inspected['Config']['Labels']
    if (labels.get('com.docker.compose.project') != 'supabase' or labels.get('com.docker.compose.service') != service
            or inspected['Config']['Image'] != locked[service]['image'] or inspected['State']['Running'] is not True):
        raise ValueError('Container identity differs.')
    networks = inspected['NetworkSettings']['Networks']
    if set(networks) != {'supabase_default'}:
        raise ValueError('Unreviewed Docker network.')
    import ipaddress
    address = networks['supabase_default']['IPAddress']
    if not ipaddress.ip_address(address).is_private:
        raise ValueError('Private consumer path required.')
    return address


def headers(environment, mode):
    if mode == 'basic':
        value = environment['DASHBOARD_USERNAME'] + ':' + environment['DASHBOARD_PASSWORD']
        return {'Authorization': 'Basic ' + base64.b64encode(value.encode()).decode()}
    return {'Authorization': 'Bearer ' + environment['SERVICE_ROLE_KEY'], 'apikey': environment['SERVICE_ROLE_KEY']}


def database_status(image, role, password):
    if role not in DB_ROLES or re.search('[\r\n\x00]', password):
        raise ValueError('Unreviewed login probe.')
    script = 'IFS= read -r PGPASSWORD; export PGPASSWORD; export PGPASSFILE=/dev/null PGCONNECT_TIMEOUT=5; exec psql -X -w -qAt -h db -p 5432 -U ' + role + " -d postgres -c 'SELECT 1'"
    try:
        result = subprocess.run(['docker', 'run', '--rm', '-i', '--network', 'supabase_default', '--entrypoint', '/bin/sh', image,
                                 '-c', script], input=(password + '\n').encode(), capture_output=True, timeout=20)
    except (subprocess.TimeoutExpired, OSError):
        return 0
    if result.returncode == 0 and result.stdout.strip() == b'1':
        return 200
    if result.returncode == 2 and b'password authentication failed for user' in result.stderr:
        return 401
    return 0


def evaluate(old, new, request_for, db_request):
    if any(old[name] == new[name] for name in SECRET_FIELDS):
        raise ValueError('Credential reuse detected.')
    outcomes = {}
    for name, (_, _, _, mode) in HTTP_CASES.items():
        outcomes[name] = probe_pair(request_for(name), headers(new, mode), headers(old, mode))
    for role in DB_ROLES:
        outcomes['db-' + role] = probe_pair(lambda h: db_request(role, h['password']),
            {'password': new['POSTGRES_PASSWORD']}, {'password': old['POSTGRES_PASSWORD']})
    return outcomes


def jwt_challenges(old, new, origin, request_for):
    outcomes = {}
    for algorithm in ('HS256', 'ES256'):
        for role in ('anon', 'service_role'):
            claims = dict(role=role, iss=origin + '/auth/v1', iat=int(time.time()), exp=int(time.time()) + 300)
            tokens = []
            for environment in (new, old):
                key = environment['JWT_SECRET'] if algorithm == 'HS256' else next(k for k in json.loads(environment['JWT_KEYS']) if k.get('kty') == 'EC' and 'd' in k)
                payload = json.dumps(dict(key=key, claims=claims, algorithm=algorithm)).encode()
                result = subprocess.run(['/opt/tonyai-tools/node-v22.23.3-linux-x64/bin/node', '/usr/local/lib/tonyai/replacement_jwt.mjs'], input=payload, capture_output=True, check=True, timeout=10)
                tokens.append({'Authorization': 'Bearer ' + result.stdout.decode()})
            for consumer in ('rest-service', 'storage-service', 'realtime-admin'):
                # Endpoints requiring service_role cannot give an anon positive control.
                # Their unsupported result remains INCONCLUSIVE, never a false PASS.
                outcomes[consumer + '-' + algorithm + '-' + role] = probe_pair(request_for(consumer), *tokens)
    return outcomes


def main():
    if sys.argv[1:] != ['--old-runtime-stdin'] or os.geteuid() != 0:
        raise ValueError('Use the approved private owner pipe on the r02 host.')
    contract = check()
    old = parse_environment(sys.stdin.buffer.read(25001))
    new = parse_environment(collect('environment')[ENV])
    locked = json.loads((RUNTIME / 'compose.images.json').read_bytes())['services']
    def request_for(name):
        service, port, path, _ = HTTP_CASES[name]
        address = container(service, locked)
        return lambda values: http_status(f'http://{address}:{port}{path}', values)
    container('db', locked)
    outcomes = evaluate(old, new, request_for, lambda role, password: database_status(locked['db']['image'], role, password))
    outcomes.update(jwt_challenges(old, new, 'https://' + contract['public_hostname'], request_for))
    from replacement_s3 import headers as s3_headers
    storage = container('storage', locked)
    url = f'http://{storage}:5000/s3/'
    outcomes['storage-s3'] = probe_pair(lambda h: http_status(url, h, s3=True), s3_headers(url, new), s3_headers(url, old))
    # These probes are deliberately scoped. A good password matrix cannot close PD-3.
    print(json.dumps({'format': 1, 'generation': 'r02', 'pd3': 'OPEN', 'results': outcomes,
        'binding': {key: contract[key] for key in ('vm_id', 'vm_uuid', 'source_sha256')},
        'remaining': ['anon positive-control qualification', 'refresh/session retirement',
                      'encryption consumer exercise', 'disabled listeners', 'external credentials', 'old endpoint containment']}))
    if any(value != 'PASS' for value in outcomes.values()):
        raise ValueError('One or more consumer probes failed or are inconclusive.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('FAIL: credential acceptance incomplete; PD-3 remains OPEN; sensitive diagnostics withheld.')
