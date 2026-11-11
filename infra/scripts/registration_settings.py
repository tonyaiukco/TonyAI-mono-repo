"""Self-service registration release parameters; the code itself stays in Key Vault."""
import re
from pooler import SafeFailure

REGISTRATION_ENV = {'REGISTRATION_CODE', 'REGISTRATION_ALLOW_PLACEHOLDER_CONSENT'}
SECRET_NAME = 'registration-code'
# The shape the API accepts (REGISTRATION_CODE_PATTERN in @tonyai/shared-types):
# a code of any other shape stops the API at boot. test_registration_settings
# holds the two expressions equal.
CODE_PATTERN = r'[A-Za-z0-9]{5}'
# Codes this repository publishes: the local development default, in
# apps/api/.env.example and scripts/bootstrap.sh. Anyone who has read the
# repository knows them, so no vault may hold one.
PUBLISHED_CODES = frozenset({'local'})


def validate_registration(foundation, release):
    """The optional block: one exact secret version and the placeholder allowance."""
    if 'registration' not in release:
        return None
    registration = release['registration']
    fields = {'code_secret_version', 'allow_placeholder_consent'}
    if not isinstance(registration, dict) or set(registration) != fields:
        raise SafeFailure('Registration requires one code version and the placeholder allowance; no secret values.')
    if (not isinstance(registration['code_secret_version'], str)
            or not re.fullmatch(r'[a-f0-9]{32}', registration['code_secret_version'])):
        raise SafeFailure('Registration needs the exact Key Vault version of its code.')
    if type(registration['allow_placeholder_consent']) is not bool:
        raise SafeFailure('The placeholder allowance must be a boolean.')
    # Only where no real customer registers: a production release cannot be
    # written that opens registration over the placeholder KVKK notice.
    if registration['allow_placeholder_consent'] and foundation.get('environment') != 'staging':
        raise SafeFailure('The placeholder notice may be allowed on staging only.')
    return registration


def registration_environment(foundation, release):
    registration = validate_registration(foundation, release)
    if registration is None:
        return {}
    return {'REGISTRATION_CODE': {'secretRef': SECRET_NAME},
            'REGISTRATION_ALLOW_PLACEHOLDER_CONSENT': {'value': str(registration['allow_placeholder_consent']).lower()}}


def verify_registration_environment(items, foundation, release, kind):
    expected = registration_environment(foundation, release) if kind == 'api' else {}
    actual = [item for item in items if item.get('name') in REGISTRATION_ENV]
    if len(actual) != len(expected) or {item['name'] for item in actual} != set(expected):
        raise SafeFailure('Unexpected, duplicate or missing registration environment settings.')
    for item in actual:
        wanted = expected[item['name']]
        field = next(iter(wanted))
        other = 'value' if field == 'secretRef' else 'secretRef'
        if item.get(field) != wanted[field] or item.get(other) not in (None, ''):
            raise SafeFailure('Registration environment differs from the reviewed release.')


def validate_registration_code(value):
    # Never the value in the message: it is the secret.
    if not isinstance(value, str) or not re.fullmatch(CODE_PATTERN, value):
        raise SafeFailure('Registration code must be exactly 5 letters or digits.')
    if isinstance(value, str) and value in PUBLISHED_CODES:
        raise SafeFailure('That registration code is the published development default; choose another.')
