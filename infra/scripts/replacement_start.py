#!/usr/bin/env python3
"""Bounded r02 first-database/full start. No HTTPS activation or recovery fallback."""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from replacement_host import check, safe_path, RUNTIME
from replacement_custody import ENV, verify_marker
from replacement_custody_host import collect
from replacement_bundle import write_new, encoded
from selfhost_pin import validate, redact_gateway


def command():
    return ['docker', 'compose', '--env-file', '.env', '-f', 'docker-compose.yml', '-f', 'compose.qa.yml',
            '-f', 'compose.https.yml', '-f', 'compose.r02.yml', '-f', 'compose.images.json']


def main():
    if sys.argv[1:] not in (['database-first-start'], ['runtime-start']):
        raise ValueError('Use an explicit isolated startup stage.')
    first = sys.argv[1] == 'database-first-start'
    contract = check()
    os.chdir(RUNTIME)
    subprocess.run(['/usr/local/sbin/tonyai-runtime-guard'], check=True, capture_output=True)
    journal = json.loads(safe_path('/etc/tonyai/initialization-r02.json').read_bytes())
    if journal != dict(generation='r02', vm_id=contract['vm_id'], source_sha256=contract['source_sha256'], state='started'):
        raise ValueError('Initialization provenance differs.')
    stage = 'environment' if first else 'intrinsic'
    files = collect(stage)
    verify_marker(json.loads(safe_path('/etc/tonyai/escrow-r02-' + stage + '.json').read_bytes()), contract, stage, files)
    if not first:
        verify_marker(json.loads(safe_path('/etc/tonyai/escrow-r02-environment.json').read_bytes()),
                      contract, 'environment', {ENV: files[ENV]})
    redact_gateway()
    result = subprocess.run(command() + ['--profile', '*', 'config', '--format', 'json'], capture_output=True, check=True)
    config = json.loads(result.stdout)
    validate(config)
    locked = json.loads(safe_path(RUNTIME / 'compose.images.json').read_bytes())['services']
    if any(not re.fullmatch(r'[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}', value['image']) or value.get('platform') != 'linux/amd64' for value in locked.values()):
        raise ValueError('Immutable amd64 image digests required.')
    if any(service.get('restart') != 'no' for service in config['services'].values()):
        raise ValueError('R02 containers must resume only through the custody guard.')
    if set(config['services']) != set(locked) or any(service['image'] != locked[name]['image'] for name, service in config['services'].items()):
        raise ValueError('Effective image digest mismatch.')
    environment = config['services']['realtime']['environment']
    if environment['DB_ENC_WRITE_GCM'] != 'true' or len(environment['DB_ENC_KEY_GCM'].encode()) != 32:
        raise ValueError('Realtime GCM configuration differs.')
    if first:
        if Path('/srv/tonyai/database/db-config/pgsodium_root.key').exists():
            raise ValueError('First start requires freshly generated intrinsic material.')
        if any((Path('/srv/tonyai/database/postgres')).iterdir()):
            raise ValueError('First start refuses an initialized database.')
        write_new('/etc/tonyai/database-first-start-r02.json', encoded({'source_sha256': contract['source_sha256']}))
    result = subprocess.run(command() + ['up', '-d', '--wait', '--wait-timeout', '240'] + (['db'] if first else []), capture_output=True, timeout=300)
    if result.returncode:
        raise ValueError('Start interrupted; retain journal, never auto-reset.')
    print('PASS: isolated r02 startup stage completed; acceptance and activation remain gated.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('FAIL: r02 startup refused/interrupted; preserve custody and isolation.')
