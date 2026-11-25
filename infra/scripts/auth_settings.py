"""Public Auth settings assertions. Missing or newly enabled providers fail closed."""
import hashlib
import json

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


def managed_auth_settings(origin, public_web_host=None):
    """Management API names for the LP4-01 policy in supabase/config.toml.

    A bound public web host becomes the site URL; the generated origin stays allowed."""
    origins = (('https://' + public_web_host,) if public_web_host else ()) + (origin,)
    return {
        'site_url': origins[0],
        'uri_allow_list': ','.join(o + path for o in origins for path in ('', '/login', '/auth/confirm')),
        'disable_signup': True,
        # The provider switch also controls password sign-in. Keep it enabled.
        'external_email_enabled': True,
        'external_phone_enabled': False,
        'external_anonymous_users_enabled': False,
        'saml_enabled': False,
        'passkey_enabled': False,
        # K4's accepted direct-PostgREST residual lasts at most one hour.
        'jwt_exp': 3600,
        # Auth counts from the last refresh. Allow the JWT lifetime plus the client's
        # full idle hour so a recently active tab can resume after token expiry.
        'sessions_inactivity_timeout': 2,  # Management API hours
        'password_min_length': 12,
        'mailer_otp_exp': 3600,
        'mailer_secure_email_change_enabled': True,
        'mailer_autoconfirm': True,
        # pre-g5-security-hardening: a password change from a session older than
        # 24 hours needs the emailed code; the app's email-link flows are fresher.
        'security_update_password_require_reauthentication': True,
        # Disable/enable rotates the password; never mail a password-change alert.
        'mailer_notifications_password_changed_enabled': False,
    }


AUTH_POLICY_DIGEST_PREFIX = 'authpolicy-v1:'


def auth_policy_digest():
    """The managed Auth policy's digest, its hosts left out (pre-g5-security-hardening).

    The owner's `supabase_setup.py --reconcile-auth-only` applies the policy and reads it back
    through the private management API (`validate_managed_auth_settings`), then prints this
    digest; the owner records it as the QA variable `QA_AUTH_POLICY_DIGEST`. The QA deploy
    refuses a release whose policy digest is not the recorded one, so no release reaches QA
    on an Auth policy the owner has not applied and verified there. The site URL and redirect
    list depend on the environment's hosts and are verified by the same readback."""
    policy = managed_auth_settings('https://origin.invalid')
    for key in ('site_url', 'uri_allow_list'):
        policy.pop(key)
    canonical = json.dumps(policy, sort_keys=True, separators=(',', ':'))
    return AUTH_POLICY_DIGEST_PREFIX + hashlib.sha256(canonical.encode()).hexdigest()


def validate_managed_auth_settings(settings, origin, public_web_host=None):
    """Private management readback, never the reduced public /settings response."""
    for key, expected in managed_auth_settings(origin, public_web_host).items():
        if type(settings.get(key)) is not type(expected) or settings[key] != expected:
            raise SafeFailure('Auth lifecycle setting drift: ' + key + '.')
    if any(value is not False for key, value in settings.items()
           if key.startswith('external_') and key.endswith('_enabled')
           and key != 'external_email_enabled'):
        raise SafeFailure('Auth has an unused provider enabled.')
