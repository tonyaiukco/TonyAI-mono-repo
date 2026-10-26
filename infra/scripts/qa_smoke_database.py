"""Fixture-only local CA mapping after the existing strict Sweden owner URL check."""
from pathlib import Path
from urllib.parse import urlsplit, parse_qsl, urlencode
from qa_database_url import validate
from qa_contract import require, sha256


def local_url(value, certificate_path, expected_hash):
    validate(value, owner=True)
    path = Path(certificate_path)
    require(path.is_absolute() and sha256(path.read_bytes()) == expected_hash)
    parsed = urlsplit(value)
    query = dict(parse_qsl(parsed.query))
    query['sslcert'] = str(path)
    return parsed._replace(query=urlencode(query)).geturl()
