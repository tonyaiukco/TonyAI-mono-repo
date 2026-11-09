"""One derivation of hosted public origins: custom hosts only once their TLS binding is live."""
import json
from pathlib import Path
import re
from pooler import SafeFailure

KINDS = ('api', 'web')


def parent_domain():
    return json.loads((Path(__file__).resolve().parents[1] / 'config/public-hosts.json').read_text())['parent_domain']


def is_public_host(host):
    parent = re.escape(parent_domain())
    return (isinstance(host, str) and len(host) <= 253
            and re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+' + parent, host) is not None)


def validate_public_hosts(value):
    """None, or {web, api, bound} with distinct hosts under the reviewed parent domain."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'web', 'api', 'bound'} or type(value['bound']) is not bool:
        raise SafeFailure('Public hosts need web, api and a boolean bound.')
    if not all(is_public_host(value[kind]) for kind in KINDS):
        raise SafeFailure('Public hosts must be lowercase DNS names under ' + parent_domain() + '.')
    if value['web'] == value['api']:
        raise SafeFailure('Web and API need distinct public hosts.')
    return value


def generated_origins(foundation):
    return {kind: 'https://' + foundation['prefix'] + '-' + foundation['environment'] + '-' + kind + '.'
            + foundation['default_domain'] for kind in KINDS}


def public_origins(foundation):
    hosts = validate_public_hosts(foundation.get('public_hosts'))
    if hosts and hosts['bound']:
        return {kind: 'https://' + hosts[kind] for kind in KINDS}
    return generated_origins(foundation)


def web_origins(foundation):
    """CORS and Auth origins, public first; the generated host keeps serving after binding."""
    public, generated = public_origins(foundation)['web'], generated_origins(foundation)['web']
    return [public] if public == generated else [public, generated]


def hosts_from_env(env):
    """WEB_HOST/API_HOST: both or neither. Workflows set them only once bound; an owner shell
    between runbook 11's steps 5 and 7 adds HOSTS_BOUND=false to describe the unbound stage."""
    web, api, bound = env.get('WEB_HOST', ''), env.get('API_HOST', ''), env.get('HOSTS_BOUND', 'true')
    if not web and not api:
        if bound != 'true':
            raise SafeFailure('HOSTS_BOUND needs WEB_HOST and API_HOST.')
        return None
    if bound not in ('true', 'false'):
        raise SafeFailure('HOSTS_BOUND must be true or false.')
    return validate_public_hosts({'web': web, 'api': api, 'bound': bound == 'true'})


def public_host_env(foundation):
    """The WEB_HOST/API_HOST pair a bound foundation implies, for hosts_from_env readers."""
    hosts = validate_public_hosts(foundation.get('public_hosts'))
    return {'WEB_HOST': hosts['web'], 'API_HOST': hosts['api']} if hosts and hosts['bound'] else {}
