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


def managed_auth_settings(origin):
    """Management API names for the LP4-01 policy in supabase/config.toml."""
    return {
        'site_url': origin,
        'uri_allow_list': ','.join((origin, origin + '/login', origin + '/auth/confirm')),
        'disable_signup': True,
        # The provider switch also controls password sign-in. Keep it enabled.
        'external_email_enabled': True,
        'external_phone_enabled': False,
        'external_anonymous_users_enabled': False,
        'saml_enabled': False,
        'passkey_enabled': False,
        'password_min_length': 12,
        'mailer_otp_exp': 3600,
        'mailer_secure_email_change_enabled': True,
        'mailer_autoconfirm': True,
        'security_update_password_require_reauthentication': False,
        # Disable/enable rotates the password; never mail a password-change alert.
        'mailer_notifications_password_changed_enabled': False,
    }


def validate_managed_auth_settings(settings, origin):
    """Private management readback, never the reduced public /settings response."""
    for key, expected in managed_auth_settings(origin).items():
        if type(settings.get(key)) is not type(expected) or settings[key] != expected:
            raise SafeFailure('Auth lifecycle setting drift: ' + key + '.')
    if any(value is not False for key, value in settings.items()
           if key.startswith('external_') and key.endswith('_enabled')
           and key != 'external_email_enabled'):
        raise SafeFailure('Auth has an unused provider enabled.')
