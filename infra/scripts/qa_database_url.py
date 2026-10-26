#!/usr/bin/env python3
"""Owner-only pre-storage URL check; status only, no cloud calls or value output."""
import argparse
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit
from qa_contract import CA_PATH, require


def validate(value, owner=False):
    require(isinstance(value, str) and value == value.strip() and len(value) < 8192)
    parsed = urlsplit(value)
    require(parsed.scheme == 'postgresql' and parsed.hostname == 'db.qa.tonyai.internal'
            and parsed.port == 5432 and parsed.path == '/postgres' and not parsed.fragment)
    require(unquote(parsed.username or '') == ('postgres' if owner else 'tonyai_runtime'))
    require(bool(parsed.password) and not any(c.isspace() for c in value))
    pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
    require(len(pairs) == len(dict(pairs)))
    required = {'sslmode': 'require', 'sslaccept': 'strict', 'sslcert': CA_PATH}
    # Runtime Prisma adds/validates its own connection limits; do not allow URL
    # host, role, credential, options or TLS overrides under alternative names.
    require(dict(pairs) == required)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-file', required=True)
    parser.add_argument('--owner', action='store_true')
    args = parser.parse_args()
    try:
        validate(Path(args.private_file).read_text(), args.owner)
    except Exception:
        raise SystemExit('FAIL: private QA DB URL refused; details withheld.') from None
    print('PASS: URL role/host/TLS syntax only; actual Prisma TLS and role checks remain required.')
