"""Read-only S3 ListBuckets signing for the locked Storage consumer; no SDK logging."""
from datetime import datetime, timezone
import hashlib
import hmac
from urllib.parse import urlsplit


def headers(url, environment, now=None):
    now = now or datetime.now(timezone.utc)
    date = now.strftime('%Y%m%d'); timestamp = now.strftime('%Y%m%dT%H%M%SZ')
    parsed = urlsplit(url)
    if parsed.path != '/s3/' or parsed.query:
        raise ValueError('Only the read-only S3 root probe is supported.')
    empty_hash = hashlib.sha256(b'').hexdigest()
    canonical_headers = f'host:{parsed.netloc}\nx-amz-content-sha256:{empty_hash}\nx-amz-date:{timestamp}\n'
    signed_headers = 'host;x-amz-content-sha256;x-amz-date'
    canonical = '\n'.join(['GET', '/s3/', '', canonical_headers, signed_headers, empty_hash])
    scope = date + '/swedencentral/s3/aws4_request'
    to_sign = '\n'.join(['AWS4-HMAC-SHA256', timestamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = ('AWS4' + environment['S3_PROTOCOL_ACCESS_KEY_SECRET']).encode()
    for part in [date, 'swedencentral', 's3', 'aws4_request']:
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return {'Host': parsed.netloc, 'x-amz-content-sha256': empty_hash, 'x-amz-date': timestamp,
            'Authorization': 'AWS4-HMAC-SHA256 Credential=' + environment['S3_PROTOCOL_ACCESS_KEY_ID'] + '/' + scope + ', SignedHeaders=' + signed_headers + ', Signature=' + signature}
