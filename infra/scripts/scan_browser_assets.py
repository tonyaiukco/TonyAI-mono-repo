#!/usr/bin/env python3
"""Fail on privileged Supabase key material in compiled browser assets; redact matches."""
import base64
import json
from pathlib import Path
import re
import sys


def scan(directory):
    files = list(directory.rglob('*'))
    if not any(path.is_file() for path in files):
        raise ValueError('Browser asset directory is empty or missing.')
    for path in files:
        if not path.is_file():
            continue
        data = path.read_bytes()
        if b'sb_secret_' in data:
            raise ValueError('Privileged key marker in browser assets; do not deploy.')
        for payload in re.findall(rb'eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+', data):
            try:
                claims = json.loads(base64.urlsafe_b64decode(payload + b'=' * (-len(payload) % 4)))
            except (ValueError, TypeError):
                continue
            if isinstance(claims, dict) and claims.get('role') == 'service_role':
                raise ValueError('Privileged JWT in browser assets; do not deploy.')


if __name__ == '__main__':
    try:
        scan(Path(sys.argv[1]))
    except Exception:
        print('FAIL: browser scan rejected assets; details withheld.', file=sys.stderr)
        sys.exit(1)
    print('PASS: browser assets contain no secret-key marker or service-role JWT.')
