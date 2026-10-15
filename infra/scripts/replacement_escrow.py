#!/usr/bin/env python3
"""Owner-only r02 escrow; no legacy/latest fallback, secret output or CLI values."""
import argparse
import json
import re
import subprocess
import sys
from urllib.request import Request, build_opener, ProxyHandler
from pathlib import Path
from selfhost_escrow import NoRedirect
from replacement_bundle import private_read, write_new, encoded
from replacement_host import validate_contract
from replacement_custody import unpack, marker


def capture(command, data=None):
    result = subprocess.run(command, input=data, capture_output=True, timeout=90)
    if result.returncode:
        raise ValueError('Private command failed.')
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['save', 'verify', 'restore'])
    parser.add_argument('--stage', choices=['environment', 'intrinsic'], required=True)
    for field in ('contract', 'ssh-target', 'key', 'known-hosts', 'record'):
        parser.add_argument('--' + field, required=True)
    parser.add_argument('--version')
    args = parser.parse_args()
    contract = validate_contract(json.loads(private_read(args.contract)))
    # Public hostname is authenticated by the separately verified known-hosts file.
    if args.ssh_target != 'tonyaiops@' + contract['public_hostname']:
        raise ValueError('SSH target must match the generation hostname.')
    account = json.loads(capture(['az', 'account', 'show', '-o', 'json']))
    if account['id'] != contract['subscription_id'] or account['tenantId'] != contract['tenant_id']:
        raise ValueError('Wrong owner account.')
    token = json.loads(capture(['az', 'account', 'get-access-token', '--resource', 'https://vault.azure.net', '-o', 'json']))['accessToken']
    ssh = ['ssh', '-F', '/dev/null', '-i', args.key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
           '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + str(Path(args.known_hosts).resolve()), args.ssh_target]
    remote = 'sudo /usr/bin/python3 -I -B /usr/local/lib/tonyai/replacement_custody_host.py '
    origin = contract['recovery_vault_url']; secret = 'supabase-r02-' + args.stage
    opener = build_opener(ProxyHandler({}), NoRedirect())
    def api(method, version='', value=None):
        if version and not re.fullmatch('[a-f0-9]{32}', version):
            raise ValueError('Invalid exact version.')
        path = origin + '/secrets/' + secret + ('/' + version if version else '')
        request = Request(path + '?api-version=7.4', method=method,
                          data=encoded({'value': value, 'contentType': 'application/json'}) if value else None,
                          headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with opener.open(request, timeout=30) as response:
            result = json.load(response)
        if version and result.get('id') != path:
            raise ValueError('Vault returned a different immutable version.')
        return result
    if args.action == 'restore':
        if args.stage != 'intrinsic' or not args.version:
            raise ValueError('Restore requires the complete intrinsic custody version.')
        restored = json.loads(api('GET', args.version)['value'])
        files = unpack(restored, contract, 'intrinsic')
        record = marker(contract, 'intrinsic', args.version, files)
        if json.loads(private_read(args.record)) != record:
            raise ValueError('Restore record differs from the approved custody version.')
        capture(ssh + ['sudo /usr/bin/python3 -I -B /usr/local/lib/tonyai/replacement_restore.py'], encoded({'envelope': restored, 'record': record}))
        capture(ssh + [remote + 'verify intrinsic'])
        print('PASS: exact r02 environment restored; runtime remains stopped.')
        return
    live = capture(ssh + [remote + 'export ' + args.stage])
    value = json.loads(live); files = unpack(value, contract, args.stage)
    version = args.version
    if args.action == 'save':
        if Path(args.record).exists() or Path(args.record).is_symlink():
            raise ValueError('Never overwrite custody evidence.')
        saved = api('PUT', value=live.decode())
        version = saved['id'].removeprefix(origin + '/secrets/' + secret + '/')
    if not version or not re.fullmatch('[a-f0-9]{32}', version):
        raise ValueError('Exact version required; latest is prohibited.')
    restored = json.loads(api('GET', version)['value'])
    if unpack(restored, contract, args.stage) != files:
        raise ValueError('Vault bytes differ from host generation.')
    record = marker(contract, args.stage, version, files)
    if capture(ssh + [remote + 'export ' + args.stage]) != live:
        raise ValueError('Host changed during escrow.')
    if args.action == 'save':
        write_new(args.record, encoded(record))
        capture(ssh + [remote + 'mark ' + args.stage], encoded(record))
    else:
        if json.loads(private_read(args.record)) != record:
            raise ValueError('Private recovery record differs.')
        capture(ssh + [remote + 'verify ' + args.stage])
    print('PASS: exact r02 recovery version verified; no secret values returned.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('FAIL: r02 escrow incomplete; retain evidence and keep the host isolated.')
