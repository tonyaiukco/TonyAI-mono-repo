"""Public API mail release parameters; passwords stay in Key Vault."""
import re
from pooler import SafeFailure

MAIL_ENV = {'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM', 'APP_URL'}


def validate_mail(release):
    if 'mail' not in release:
        return None
    mail = release['mail']
    fields = {'host', 'port', 'secure', 'user', 'from', 'password_secret_version'}
    if not isinstance(mail, dict) or set(mail) != fields:
        raise SafeFailure('Mail requires all public parameters and one password version; no secret values.')
    if (not isinstance(mail['host'], str)
            or not re.fullmatch(r'(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', mail['host'])
            or '.' not in mail['host'] or mail['host'].endswith('.localhost')
            or re.fullmatch(r'[0-9.]+', mail['host'])):
        raise SafeFailure('SMTP host must be the provider DNS name, not loopback or a URL.')
    if type(mail['port']) is not int or not 1 <= mail['port'] <= 65535 or type(mail['secure']) is not bool:
        raise SafeFailure('SMTP port must be 1–65535 and secure must be a boolean.')
    if (not isinstance(mail['user'], str) or not re.fullmatch(r'[^\s<>]{1,256}', mail['user'])
            or not isinstance(mail['from'], str) or not re.fullmatch(r'[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+', mail['from'])
            or not isinstance(mail['password_secret_version'], str)
            or not re.fullmatch(r'[a-f0-9]{32}', mail['password_secret_version'])):
        raise SafeFailure('Mail needs a username, sender address and exact password version.')
    return mail


def mail_environment(foundation, release):
    mail = validate_mail(release)
    if mail is None:
        return {}
    origin = 'https://' + foundation['prefix'] + '-' + foundation['environment'] + '-web.' + foundation['default_domain']
    return {'SMTP_HOST': {'value': mail['host']}, 'SMTP_PORT': {'value': str(mail['port'])},
            'SMTP_SECURE': {'value': str(mail['secure']).lower()}, 'SMTP_USER': {'value': mail['user']},
            'SMTP_PASSWORD': {'secretRef': 'smtp-password'}, 'MAIL_FROM': {'value': mail['from']},
            'APP_URL': {'value': origin}}


def verify_mail_environment(items, foundation, release, kind):
    expected = mail_environment(foundation, release) if kind == 'api' else {}
    actual = [item for item in items if item.get('name') in MAIL_ENV]
    if len(actual) != len(expected) or {item['name'] for item in actual} != set(expected):
        raise SafeFailure('Unexpected, duplicate or missing mail environment settings.')
    for item in actual:
        wanted = expected[item['name']]
        field = next(iter(wanted))
        other = 'value' if field == 'secretRef' else 'secretRef'
        if item.get(field) != wanted[field] or item.get(other) not in (None, ''):
            raise SafeFailure('Mail environment differs from the reviewed release.')


def validate_smtp_password(value):
    if not isinstance(value, str) or not value.strip() or '\n' in value or '\r' in value:
        raise SafeFailure('SMTP password must be nonempty and single-line.')
