"""Checkpoint the owner session URL before disabling its bootstrap password copy."""
import re
from urllib.parse import quote, urlparse
from pooler import SafeFailure, CONTAINER_CA, validate_pooler


def transfer_urls(api, vault, ref, journal):
    saved = journal.data.get('url_checkpoint')
    if saved:
        for name, port in [('direct-url', 5432)]:
            record = vault.get(name, saved[name.replace('-', '_') + '_version'])
            if not record or record.get('tags', {}).get('project') != ref:
                raise SafeFailure('Checkpoint URL is missing or belongs to another project.')
            vault.identifier(record, name, saved[name.replace('-', '_') + '_version'])
            validate_pooler(record['value'], ref, port)
    else:
        poolers = api('/v1/projects/' + ref + '/config/database/pooler')
        try:
            # The provider's literal password placeholder is not valid URL userinfo in Python 3.12.
            # Substitute only that marker for host discovery; actual passwords come from the vault.
            hosts = {urlparse(p['connection_string'].replace('[YOUR-PASSWORD]', 'placeholder')).hostname
                     for p in poolers if p.get('database_type') == 'PRIMARY'}
        except (KeyError, TypeError, AttributeError, ValueError):
            raise SafeFailure('Malformed provider pooler metadata; connection details withheld.') from None
        if len(hosts) != 1 or not re.fullmatch(r'aws-[0-9]+-eu-central-1\.pooler\.supabase\.com', next(iter(hosts)) or ''):
            raise SafeFailure('No unambiguous Frankfurt primary pooler host.')
        password = vault.get('bootstrap-db-password')
        if not password or not password.get('value'):
            raise SafeFailure('Missing bootstrap DB password; recover it securely before URL setup.')
        bootstrap = vault.identifier(password, 'bootstrap-db-password')
        saved = {'bootstrap_password_version': bootstrap.rsplit('/', 1)[1]}
        for name, port in [('direct-url', 5432)]:
            value = ('postgresql://postgres.' + ref + ':' + quote(password['value'], safe='') + '@' + next(iter(hosts))
                     + ':' + str(port) + '/postgres?sslmode=require&sslaccept=strict&sslcert=' + CONTAINER_CA
                     + ('&pgbouncer=true' if port == 6543 else ''))
            validate_pooler(value, ref, port)
            identity = vault.put(name, value, {'project': ref})
            saved[name.replace('-', '_') + '_version'] = identity.rsplit('/', 1)[1]
        # Durable IDs only. A retry can use the owner URL even if disabling succeeded but its reply was lost.
        journal.set(url_checkpoint=saved)
    vault.disable('bootstrap-db-password', saved['bootstrap_password_version'])
    return {key: saved[key] for key in ('direct_url_version',)}
