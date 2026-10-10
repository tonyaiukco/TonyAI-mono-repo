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
    if (set(query) - {'pgbouncer', 'sslmode', 'sslaccept', 'sslcert', 'connection_limit', 'pool_timeout'}
            or parsed.scheme not in ('postgres', 'postgresql')
            or not re.fullmatch(r'aws-[0-9]+-eu-central-1\.pooler\.supabase\.com', parsed.hostname or '')
            or parsed.port != port or parsed.username != ('tonyai_runtime' if port == 6543 else 'postgres') + '.' + project
            or not parsed.password or parsed.path != '/postgres'
            or query.get('sslmode') != ['require'] or query.get('sslaccept') != ['strict']
            or query.get('sslcert') != [CONTAINER_CA]
            or 'sslrootcert' in query or parsed.fragment
            or (port == 6543 and query.get('pgbouncer') != ['true'])):
        raise SafeFailure('Pooler URL must match Frankfurt, this project, exact runtime/owner role, mode, database and strict TLS contract.')

    if port == 6543 and {'connection_limit', 'pool_timeout'} & set(query):
        raise SafeFailure('Runtime pool budgets belong in release runtime_limits, not the stored database URL.')

    for name in ('connection_limit', 'pool_timeout'):
        if name in query and (len(query[name]) != 1 or not re.fullmatch(r'[1-9][0-9]*', query[name][0])
                              or int(query[name][0]) > 2147483647):
            raise SafeFailure('Invalid database pool budget.')


def local_ca_url(value):
    parsed = urlparse(value)
    query = parse_qs(parsed.query, keep_blank_values=True)
    query['sslcert'] = [str(ROOT / CA_RELATIVE_PATH)]
    return parsed._replace(query=urlencode(query, doseq=True)).geturl()
