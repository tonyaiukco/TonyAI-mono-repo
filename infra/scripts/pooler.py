"""Prisma 6 staging TLS/region contract; no credentials are logged or persisted."""
from pathlib import Path
import re
from urllib.parse import urlparse, parse_qs, urlencode

ROOT = Path(__file__).resolve().parents[2]
CA_RELATIVE_PATH = 'infra/certs/prod-ca-2021.crt'
CONTAINER_CA = '/app/' + CA_RELATIVE_PATH


class SafeFailure(Exception):
    """Only fixed, credential-free messages may be surfaced to the operator."""


def validate_pooler(value, project, port):
    parsed = urlparse(value)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if (parsed.scheme not in ('postgres', 'postgresql')
            or not re.fullmatch(r'aws-[0-9]+-eu-central-1\.pooler\.supabase\.com', parsed.hostname or '')
            or parsed.port != port or not (parsed.username or '').endswith('.' + project)
            or not parsed.password or parsed.path != '/postgres'
            or query.get('sslmode') != ['require'] or query.get('sslaccept') != ['strict']
            or query.get('sslcert') != [CONTAINER_CA]
            or 'sslrootcert' in query or parsed.fragment
            or (port == 6543 and query.get('pgbouncer') != ['true'])):
        raise SafeFailure('Pooler URL must match Frankfurt, this project, mode, database and strict TLS contract.')


def local_ca_url(value):
    parsed = urlparse(value)
    query = parse_qs(parsed.query, keep_blank_values=True)
    query['sslcert'] = [str(ROOT / CA_RELATIVE_PATH)]
    return parsed._replace(query=urlencode(query, doseq=True)).geturl()
