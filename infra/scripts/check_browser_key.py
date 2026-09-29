#!/usr/bin/env python3
"""Validate public build inputs and live project/Auth binding without echoing keys."""
import base64
import json
import os
import re
import sys
from auth_settings import validate_auth_settings
from cloud_ops import request, require_success
from pooler import SafeFailure


def validate(key, project_ref):
    if not re.fullmatch(r'[a-z]{20}', project_ref):
        return False
    if re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]+', key):
        return True  # Project binding is checked by a live Auth request below.
    try:
        parts = key.split('.')
        if len(parts) != 3:
            return False
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
        return isinstance(payload, dict) and payload.get('role') == 'anon' and payload.get('ref') == project_ref
    except (ValueError, TypeError):
        return False


def check_inputs(env):
    project = env.get('SUPABASE_PROJECT_REF', '')
    key = env.get('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
    supabase = 'https://' + project + '.supabase.co'
    api = env.get('API_ORIGIN', '')
    if (not validate(key, project) or env.get('NEXT_PUBLIC_SUPABASE_URL') != supabase
            or not re.fullmatch(r'https://[a-z0-9-]+-staging-api\.[a-z0-9.-]+\.germanywestcentral\.azurecontainerapps\.io', api)
            or env.get('NEXT_PUBLIC_API_BASE_URL') != api + '/api/v1'):
        raise SafeFailure('Invalid public key, project or staging build URLs.')
    # A successful request with this public key proves the target project accepts it.
    settings = json.loads(require_success(request(supabase + '/auth/v1/settings', key=key)))
    validate_auth_settings(settings)


if __name__ == '__main__':
    try:
        check_inputs(os.environ)
    except Exception:
        print('FAIL: public build inputs, project binding or Auth settings refused; details withheld.', file=sys.stderr)
        sys.exit(1)
    print('PASS: public build URLs/key accepted by staging; signup and unused providers disabled.')
