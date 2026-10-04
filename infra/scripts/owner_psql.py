"""Interactive owner psql with exact-version credentials supplied only through env."""
import os
import subprocess
import sys
from urllib.parse import unquote, urlparse
from pooler import CA_RELATIVE_PATH, ROOT, SafeFailure, validate_pooler


def owner_psql(value, project):
    validate_pooler(value, project, 5432)
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise SafeFailure('Owner psql requires a private interactive terminal.')
    parsed = urlparse(value)
    # Ignore inherited libpq settings, psql startup files and query-history paths.
    env = {key: value for key, value in os.environ.items()
           if key in ('PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE')}
    env.update(PGHOST=parsed.hostname, PGPORT='5432', PGDATABASE='postgres',
               PGUSER=parsed.username, PGPASSWORD=unquote(parsed.password),
               PGSSLMODE='verify-full', PGSSLROOTCERT=str(ROOT / CA_RELATIVE_PATH),
               PGCONNECT_TIMEOUT='15', PSQL_HISTORY=os.devnull)
    result = subprocess.run(['psql', '-X', '--no-password', '--set=ON_ERROR_STOP=1'], env=env, check=False)
    if result.returncode:
        raise SafeFailure('Owner psql did not finish successfully; inspect the private session.')
