"""Select existing API keys and prove project binding without creating credentials."""
import base64
import json
import re
import uuid
from check_browser_key import validate
from cloud_ops import request, require_success
from pooler import SafeFailure


def validate_backend(value, project):
    if not re.fullmatch(r'[a-z]{20}', project):
        raise SafeFailure('Invalid Supabase project reference.')
    if not re.fullmatch(r'sb_secret_[A-Za-z0-9_-]+', value):
        try:
            parts = value.split('.')
            payload = json.loads(base64.urlsafe_b64decode(parts[1] + '===')) if len(parts) == 3 else {}
        except Exception:
            raise SafeFailure('Invalid backend API key.') from None
        if payload.get('ref') != project or payload.get('role') != 'service_role':
            raise SafeFailure('Backend key is not this project service role.')
    rows = json.loads(require_success(request('https://' + project + '.supabase.co/storage/v1/bucket', key=value)))
    if not isinstance(rows, list):
        raise SafeFailure('Backend project binding probe returned an unexpected response.')


def select_keys(rows, project):
    if not isinstance(rows, list):
        raise SafeFailure('Unexpected API key inventory.')
    values = []
    for modern, legacy in [('publishable', 'anon'), ('secret', 'service_role')]:
        # A malformed or ambiguous modern inventory must not silently downgrade.
        matches = [row for row in rows if row.get('type') == modern
                   or str(row.get('api_key', '')).startswith('sb_' + modern + '_')]
        if not matches:
            matches = [row for row in rows if row.get('name') == legacy]
        if len(matches) != 1 or not isinstance(matches[0].get('api_key'), str) or not matches[0]['api_key']:
            raise SafeFailure('Expected one existing public/backend key; reconcile ambiguous keys in Supabase.')
        values.append(matches[0]['api_key'])
    public, backend = values
    if not validate(public, project):
        raise SafeFailure('Invalid public API key or project binding.')
    validate_backend(backend, project)
    endpoint = 'https://' + project + '.supabase.co/auth/v1/settings'
    if request(endpoint, key='sb_publishable_invalid_' + uuid.uuid4().hex)[0] != 401:
        raise SafeFailure('Auth endpoint did not reject the invalid-key control.')
    if not isinstance(json.loads(require_success(request(endpoint, key=public))), dict):
        raise SafeFailure('Public project binding probe returned an unexpected response.')
    return public, backend
