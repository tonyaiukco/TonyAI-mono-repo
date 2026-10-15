#!/usr/bin/env python3
"""Owner-only runtime-secret escrow/restore. Secret bytes stay in memory and SSH stdin."""
import argparse
import hashlib
import ipaddress
import json
import re
import subprocess
import sys
from urllib.request import Request, build_opener, HTTPRedirectHandler
from pathlib import Path

SECRET = 'supabase-runtime-env'


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Vault redirects are prohibited.')


def capture(command, data=None):
    result = subprocess.run(command, input=data, capture_output=True)
    if result.returncode:
        raise ValueError('Private subprocess failed; output withheld.')
    return result.stdout


def validate_contract(contract):
    sub = contract['subscription_id']
    if not re.fullmatch(r'[a-f0-9-]{36}', sub) or contract['environment'] not in ('staging', 'production'):
        raise ValueError('Invalid deployment identity.')
    environment = 'qa' if contract['environment'] == 'staging' else 'prod'
    expected = f'https://tonyai-{environment}-rec-{sub[:8]}.vault.azure.net'
    if contract['recovery_vault_url'] != expected or not ipaddress.ip_address(contract['public_ip']).is_global:
        raise ValueError('Unexpected recovery vault or host.')
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['save', 'verify', 'restore'])
    parser.add_argument('--contract', required=True)
    parser.add_argument('--key', required=True)
    parser.add_argument('--known-hosts', required=True)
    parser.add_argument('--version')
    args = parser.parse_args()
    contract = json.loads(Path(args.contract).read_text())
    origin = validate_contract(contract)
    account = json.loads(capture(['az', 'account', 'show', '-o', 'json']))
    if account['id'] != contract['subscription_id'] or account['tenantId'] != contract['tenant_id']:
        raise ValueError('CLI account differs from reviewed deployment.')
    token = json.loads(capture(['az', 'account', 'get-access-token', '--resource', 'https://vault.azure.net', '-o', 'json']))['accessToken']
    ssh = ['ssh', '-i', args.key, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
           '-o', 'UserKnownHostsFile=' + args.known_hosts, 'tonyaiops@' + contract['public_ip']]
    opener = build_opener(NoRedirect())
    def api(method, suffix, body=None):
        if not re.fullmatch(r'(?:/[a-f0-9]{32})?', suffix):
            raise ValueError('Invalid immutable vault version.')
        req = Request(origin + '/secrets/' + SECRET + suffix + '?api-version=7.4',
                      data=json.dumps(body).encode() if body else None, method=method,
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with opener.open(req, timeout=30) as response:
            return json.load(response)
    def validate_value(value):
        data = value.encode()
        if not data or len(data) > 25 * 1024 or "COMPOSE_FILE='" not in value or "POSTGRES_PASSWORD='" not in value:
            raise ValueError('Unexpected runtime environment payload.')
        return data
    if args.action == 'save':
        value = capture(ssh + ['sudo cat /opt/tonyai/supabase/.env']).decode()
        validate_value(value)
        saved = api('PUT', '', {'value': value, 'contentType': 'application/x-dotenv', 'attributes': {'enabled': True}})
        version = saved.get('id', '').removeprefix(origin + '/secrets/' + SECRET + '/')
    else:
        version = args.version or ''
    if not re.fullmatch('[a-f0-9]{32}', version):
        raise ValueError('Exact secret version is required.')
    restored = api('GET', '/' + version)['value']
    data = validate_value(restored)
    if args.action in ('save', 'verify'):
        current = capture(ssh + ['sudo cat /opt/tonyai/supabase/.env'])
        if current != data:
            raise ValueError('Immutable vault version differs from live credentials.')
    else:
        capture(ssh + ['sudo python3 /home/tonyaiops/selfhost_restore_env.py'], data)
    marker = json.dumps({'version': version, 'vault': origin, 'sha256': hashlib.sha256(data).hexdigest()}).encode()
    capture(ssh + ["sudo sh -c 'umask 077; cat > /etc/tonyai/escrow.json'"], marker)
    record = Path(args.contract).with_name('runtime-escrow.json')
    if record.is_symlink():
        raise ValueError('Recovery record must not be a symlink.')
    record.write_bytes(marker)
    record.chmod(0o600)
    print('PASS: immutable recovery version verified: ' + origin + '/secrets/' + SECRET + '/' + version)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('FAIL: escrow/restore did not complete; sensitive diagnostics withheld. Do not start or rotate the runtime.')
