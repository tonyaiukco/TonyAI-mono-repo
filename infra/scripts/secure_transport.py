"""Fixed-origin JSON transports. Secret payloads never reach argv, files or logs."""
import json
import re
import subprocess
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPRedirectHandler
from pooler import SafeFailure


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def json_request(url, method='GET', token=None, body=None, missing_ok=False):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = Request(url, method=method, headers=headers,
                  data=None if body is None else json.dumps(body).encode())
    try:
        with build_opener(NoRedirect).open(req, timeout=60) as response:
            payload = response.read()
            return json.loads(payload) if payload else {}
    except HTTPError as error:
        if error.code == 404 and missing_ok:
            return None
        raise SafeFailure('Remote operation failed; response and credentials withheld. Resume using the journal.') from None
    except Exception:
        raise SafeFailure('Remote operation interrupted; outcome may be unknown. Resume using the journal.') from None


def azure_token(resource):
    result = subprocess.run(['az', 'account', 'get-access-token', '--resource', resource,
                             '--query', 'accessToken', '-o', 'tsv', '--only-show-errors'],
                            capture_output=True, text=True, check=False)
    if result.returncode or not result.stdout.strip():
        raise SafeFailure('Owner Azure login is required; token output withheld.')
    return result.stdout.strip()


class Vault:
    def __init__(self, name):
        if not re.fullmatch(r'[a-z][a-z0-9-]{1,22}[a-z0-9]', name):
            raise SafeFailure('Invalid vault name.')
        self.origin = 'https://' + name + '.vault.azure.net'
        self.token = azure_token('https://vault.azure.net')

    def get(self, name, version=None):
        if not re.fullmatch(r'[a-z0-9-]+', name) or (version and not re.fullmatch(r'[a-f0-9]{32}', version)):
            raise SafeFailure('Invalid secret identifier.')
        path = '/secrets/' + name + ('/' + version if version else '')
        return json_request(self.origin + path + '?api-version=7.4', token=self.token, missing_ok=True)

    def put(self, name, value, tags=None):
        existing = self.get(name)
        if (existing and existing.get('value') == value and existing.get('attributes', {}).get('enabled') is True
                and existing.get('tags', {}) == (tags or {})):
            return self.identifier(existing, name)
        record = json_request(self.origin + '/secrets/' + name + '?api-version=7.4', 'PUT', self.token,
                              {'value': value, 'attributes': {'enabled': True}, 'tags': tags or {}})
        return self.identifier(record, name)

    def identifier(self, record, name, version=None):
        expected = re.escape(self.origin + '/secrets/' + name + '/') + r'[a-f0-9]{32}'
        if (not re.fullmatch(expected, record.get('id', ''))
                or (version and record['id'].rsplit('/', 1)[1] != version)
                or record.get('attributes', {}).get('enabled') is not True):
            raise SafeFailure('Unexpected or disabled vault version.')
        return record['id']

    def disable(self, name, version):
        # PATCH needs no value read and is safe to repeat after a lost response.
        if not re.fullmatch(r'[a-z0-9-]+', name) or not re.fullmatch(r'[a-f0-9]{32}', version):
            raise SafeFailure('Invalid secret identifier.')
        identity = self.origin + '/secrets/' + name + '/' + version
        record = json_request(identity + '?api-version=7.4', 'PATCH', self.token,
                              {'attributes': {'enabled': False}})
        if record.get('id') != identity or record.get('attributes', {}).get('enabled') is not False:
            raise SafeFailure('Bootstrap password disable was not confirmed; resume the same journal.')
