"""One bounded ARM HTTPS request. No login, credential discovery, redirect or retry."""
import base64
import os
from pathlib import Path
import re
import signal
import ssl
import time
import urllib.error
import urllib.request

from r3_access_repair import require
from r3_access_repair_contract import load, private_path
from r3_noble_common import encoded, read

RESPONSE_LIMIT = 1024 * 1024


class RequestDeadline(BaseException):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('REDIRECT_REFUSED')


class ArmBearerClient:
    """A future owner-supplied short-lived token; never loaded during rendering.

    Claims are selection checks, not signature verification. ARM verifies the
    bearer token. No token, response error text or authentication header is logged.
    """
    def __init__(self, binding):
        require(set(binding) == {'kind', 'tenant', 'principal', 'credential_path'} and
                binding['kind'] == 'OWNER_ARM_BEARER_FILE', 'CLIENT_KIND')
        for name in ('tenant', 'principal'):
            require(isinstance(binding[name], str) and re.fullmatch('[a-f0-9-]{36}', binding[name]), 'CLIENT_ID')
        self.binding = binding
        self.identity = dict(binding)

    def token(self):
        path = Path(self.binding['credential_path'])
        private_path(path)
        token = read(path, 32768).decode('ascii').strip()
        require(re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token), 'TOKEN_FORMAT')
        part = token.split('.')[1]
        claims = load(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        require(claims.get('tid') == self.binding['tenant'] and claims.get('oid') == self.binding['principal'] and
                claims.get('aud') in ('https://management.azure.com/', 'https://management.core.windows.net/') and
                type(claims.get('exp')) is int and claims['exp'] > time.time() + 180, 'TOKEN_SELECTION')
        return token

    def request_once(self, method, url, body=None, headers=None):
        require(method in ('GET', 'PATCH', 'PUT') and url.startswith('https://management.azure.com/subscriptions/') and
                not any(c in url for c in ('\r', '\n', '#', '@')), 'ARM_ORIGIN')
        headers = {} if headers is None else headers
        require(set(headers) <= {'If-Match'} and all(isinstance(v, str) and
                re.fullmatch(r'[\x20-\x7e]{1,256}', v) for v in headers.values()), 'HEADERS')
        data = None if body is None else encoded(body)
        require(data is None or len(data) <= 256 * 1024, 'REQUEST_SIZE')
        require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'EXISTING_TIMER')
        def expire(_sig, _frame):
            raise RequestDeadline()
        old = signal.signal(signal.SIGALRM, expire)
        signal.alarm(15)
        try:
            request = urllib.request.Request(url, data=data, method=method, headers={
                'Authorization': 'Bearer ' + self.token(), 'Content-Type': 'application/json', **headers})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(),
                        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
            try:
                response = opener.open(request, timeout=5)
            except urllib.error.HTTPError as exc:
                # Never retain service error bodies which may echo request details.
                code = exc.code
                exc.close()
                return {'status': code, 'etag': None, 'body': None}
            with response:
                raw = response.read(RESPONSE_LIMIT + 1)
                require(len(raw) <= RESPONSE_LIMIT, 'RESPONSE_SIZE')
                return {'status': response.status, 'etag': response.headers.get('ETag'),
                        'body': load(raw) if raw else None}
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old)
