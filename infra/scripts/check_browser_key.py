#!/usr/bin/env python3
"""Reject privileged Supabase keys before a public web build; never print the key."""
import base64
import json
import os
import re
import sys


def validate(key, project_ref):
    if not re.fullmatch(r'[a-z]{20}', project_ref):
        return False
    # Modern publishable keys carry no decodable project claim. The operator must
    # confirm the project in the dashboard; service keys have a different prefix.
    if re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]+', key):
        return True
    try:
        parts = key.split('.')
        if len(parts) != 3:
            return False
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
        return isinstance(payload, dict) and payload.get('role') == 'anon' and payload.get('ref') == project_ref
    except (ValueError, TypeError):
        return False


if __name__ == '__main__':
    if not validate(os.environ.get('NEXT_PUBLIC_SUPABASE_ANON_KEY', ''),
                    os.environ.get('SUPABASE_PROJECT_REF', '')):
        print('FAIL: a public staging browser key is required; privileged/unknown keys refused.', file=sys.stderr)
        sys.exit(1)
    print('PASS: public browser-key shape; confirm the project in the dashboard.')
