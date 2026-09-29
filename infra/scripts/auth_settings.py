"""Public Auth settings assertions. Missing or newly enabled providers fail closed."""
from pooler import SafeFailure


def validate_auth_settings(settings):
    external = settings.get('external')
    if (settings.get('disable_signup') is not True
            or settings.get('saml_enabled') is not False
            or settings.get('passkeys_enabled', False) is not False
            or not isinstance(external, dict)
            or external.get('email') is not True
            or external.get('anonymous_users') is not False
            or external.get('phone') is not False
            or any(value is not False for name, value in external.items() if name != 'email')):
        raise SafeFailure('Auth must disable signup, anonymous, phone, SAML and all unused providers.')
