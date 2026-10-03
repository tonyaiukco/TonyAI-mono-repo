"""Reconcile exact Auth settings and activate a recoverable asymmetric signing key."""
import json
import re
from auth_settings import validate_auth_settings
from cloud_ops import request, require_success
from pooler import SafeFailure


def ensure_signing_key(api, ref, journal):
    path = '/v1/projects/' + ref + '/config/auth/signing-keys'
    keys = api(path)['keys']
    active = [k for k in keys if k['status'] == 'in_use' and k['algorithm'] in ('ES256', 'RS256')]
    if len(active) == 1:
        journal.set(signing_key_id=active[0]['id'])
        return active[0]['id']
    if len(active) > 1:
        raise SafeFailure('Ambiguous active signing keys.')
    saved = journal.data.get('signing_key_id')
    if saved:
        candidates = [k for k in keys if k['id'] == saved and k['algorithm'] == 'ES256' and k['status'] == 'standby']
    elif 'signing_before_ids' in journal.data:
        candidates = [k for k in keys if k['id'] not in journal.data['signing_before_ids']
                      and k['algorithm'] == 'ES256' and k['status'] == 'standby']
    else:
        journal.set(signing_before_ids=[k['id'] for k in keys])
        candidates = [api(path, 'POST', {'algorithm': 'ES256', 'status': 'standby'})]
    if len(candidates) != 1 or not re.fullmatch(r'[a-f0-9-]{36}', candidates[0].get('id', '')):
        raise SafeFailure('Signing-key outcome unknown; reconcile, never blindly create another key.')
    identity = candidates[0]['id']
    journal.set(signing_key_id=identity)
    api(path + '/' + identity, 'PATCH', {'status': 'in_use'})
    current = api(path)['keys']
    if not any(k['id'] == identity and k['algorithm'] == 'ES256' and k['status'] == 'in_use' for k in current):
        raise SafeFailure('Signing key activation did not read back.')
    return identity


def configure_auth(api, ref, origin, public_key, signing_id):
    if not re.fullmatch(r'https://[a-z0-9-]+\.[a-z0-9-]+\.germanywestcentral\.azurecontainerapps\.io', origin):
        raise SafeFailure('Expected an exact HTTPS Azure staging origin.')
    path = '/v1/projects/' + ref + '/config/auth'
    current = api(path)  # May contain secrets: stays in process memory, never saved.
    desired = {key: False for key in current if key.startswith('external_') and key.endswith('_enabled')}
    desired.update(site_url=origin, uri_allow_list=origin + ',' + origin + '/login',
                   disable_signup=True, external_email_enabled=True, external_phone_enabled=False,
                   external_anonymous_users_enabled=False, saml_enabled=False, passkey_enabled=False)
    api(path, 'PATCH', desired)
    actual = api(path)
    if any(actual.get(key) != value for key, value in desired.items()):
        raise SafeFailure('Auth exact-origin/provider policy did not read back.')
    base = 'https://' + ref + '.supabase.co/auth/v1'
    settings = json.loads(require_success(request(base + '/settings', key=public_key)))
    validate_auth_settings(settings)
    jwks = json.loads(require_success(request(base + '/.well-known/jwks.json')))['keys']
    if not any(k.get('kid') == signing_id and k.get('alg') in ('ES256', 'RS256')
               and k.get('kty') in ('EC', 'RSA') and not any(x in k for x in ('d', 'k', 'p', 'q')) for k in jwks):
        raise SafeFailure('Active public JWKS key not visible yet; wait for propagation and resume.')
