#!/usr/bin/env python3
"""Start the reviewed composition only after immutable secret escrow has been verified."""
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
from selfhost_pin import GatewayDestinationError


def main():
    if os.geteuid() != 0 or sys.argv[1:] not in ([], ['--https']):
        raise ValueError('Use as root, optionally with --https.')
    subprocess.run(['/usr/local/sbin/tonyai-runtime-guard'], check=True)
    root = Path('/opt/tonyai/supabase')
    marker = json.loads(Path('/etc/tonyai/escrow.json').read_text())
    if hashlib.sha256((root / '.env').read_bytes()).hexdigest() != marker['sha256']:
        raise ValueError('Escrow differs from runtime credentials; save and verify a new immutable version first.')
    os.chdir(root)
    from selfhost_pin import validate, compose_config, redact_gateway
    locked = json.loads((root / 'compose.images.json').read_text())
    if any(not re.fullmatch(r'[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}', service['image']) for service in locked['services'].values()):
        raise ValueError('Image lock must contain only immutable digests.')
    redact_gateway()
    config = compose_config(locked=True)
    validate(config)
    if any(not re.fullmatch(r'[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}', service['image']) for service in config['services'].values()):
        raise ValueError('Every effective service must use an immutable image digest.')
    command = ['docker', 'compose', '--env-file', '.env', '-f', 'docker-compose.yml', '-f', 'compose.qa.yml',
               '-f', 'compose.https.yml', '-f', 'compose.images.json'] + (['--profile', 'https'] if '--https' in sys.argv else [])
    result = subprocess.run(command + ['up', '-d', '--wait', '--wait-timeout', '240'], capture_output=True)
    if result.returncode:
        raise ValueError('Runtime did not become healthy; inspect redacted diagnostics.')
    print('PASS: escrow matches, disks and network boundary verified, runtime healthy.')


if __name__ == '__main__':
    try:
        main()
    except GatewayDestinationError as error:
        sys.exit('FAIL: ' + str(error))
    except Exception:
        sys.exit('FAIL: guarded runtime start refused; sensitive diagnostics withheld.')
