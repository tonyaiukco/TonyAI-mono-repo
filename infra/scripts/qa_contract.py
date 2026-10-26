"""Strict public Sweden QA build/release contracts; no credentials or cloud calls."""
import hashlib
import json
from pathlib import Path
import re
from candidate import fingerprint
from mail_settings import validate_mail
from pooler import SafeFailure
from runtime_limits import validate_limits

ROOT = Path(__file__).resolve().parents[2]
SUBSCRIPTION = "cb7efc2f-37a7-4672-b62c-93c207bcd33d"
SUBNET = (f"/subscriptions/{SUBSCRIPTION}/resourceGroups/tonyai-staging-data/"
          "providers/Microsoft.Network/virtualNetworks/tonyai-staging-data-vnet/subnets/container-apps")
GROUP = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/tonyai-staging-apps"
CA_PATH = "/app/infra/certs/qa-db-ca.crt"


def require(condition):
    if not condition:
        raise SafeFailure("QA public contract refused; inspect inputs privately.")


def fields(value, names, optional=""):
    require(isinstance(value, dict) and set(names.split()) <= value.keys()
            and value.keys() <= set((names + " " + optional).split()))


def match(pattern, value):
    require(isinstance(value, str) and re.fullmatch(pattern, value) is not None)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def load(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result)
            result[key] = value
        return result
    return json.loads(Path(path).read_text(), object_pairs_hook=unique)


def foundation(value):
    fields(value, "subscription_id tenant_id environment region resource_group prefix registry_name vault_name default_domain apps_subnet_id")
    require(value['subscription_id'] == SUBSCRIPTION and value['environment'] == 'staging'
            and value['region'] == 'swedencentral' and value['resource_group'] == 'tonyai-staging-apps'
            and value['prefix'] == 'tonyai' and value['apps_subnet_id'] == SUBNET)
    match(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value['tenant_id'])
    match(r'[a-z0-9]{5,50}', value['registry_name'])
    match(r'[a-z][a-z0-9-]{1,22}[a-z0-9]', value['vault_name'])
    match(r'[a-z0-9-]+\.swedencentral\.azurecontainerapps\.io', value['default_domain'])
    return value


def origins(value):
    return {kind: f"https://tonyai-staging-{kind}.{value['default_domain']}" for kind in ('api', 'web')}


BUILD_FIELDS = 'source_sha supabase_origin jwt_issuer db_ca_sha256 browser_key_sha256 node_image'


def build(value):
    fields(value, BUILD_FIELDS)
    match(r'[a-f0-9]{40}', value['source_sha'])
    # The scoped r02 DNS name is supplied after R3, never guessed or discovered here.
    match(r'https://tonyai-staging-cb7efc2f-r02\.[a-z0-9-]+\.swedencentral\.cloudapp\.azure\.com', value['supabase_origin'])
    require(value['jwt_issuer'] == value['supabase_origin'] + '/auth/v1')
    for name in ('db_ca_sha256', 'browser_key_sha256'):
        match(r'[a-f0-9]{64}', value[name])
    match(r'(?:docker\.io/library/node|public\.ecr\.aws/docker/library/node)@sha256:[a-f0-9]{64}', value['node_image'])
    return value


def target(value):
    fields(value, 'foundation build')
    foundation(value['foundation'])
    build(value['build'])
    return value


def candidate(value, expected_target, root=ROOT):
    fields(value, 'schema target api_digest web_digest lockfile_sha256 migrations')
    require(type(value['schema']) is int and value['schema'] == 1)
    require(target(value['target']) == expected_target)
    for name in ('api_digest', 'web_digest'):
        match(r'sha256:[a-f0-9]{64}', value[name])
    source = fingerprint(root)
    require(value['lockfile_sha256'] == source['lockfile_sha256'] and value['migrations'] == source['migrations'])
    return value


def release(value, image_candidate, root=ROOT):
    fields(value, 'foundation release')
    foundation(value['foundation'])
    rel = value['release']
    fields(rel, BUILD_FIELDS + ' release_id api_digest web_digest database_secret_version backend_secret_version storage_cleanup_hold storage_sweep_interval_seconds runtime_limits', 'mail')
    bound = {key: rel[key] for key in BUILD_FIELDS.split()}
    build(bound)
    candidate(image_candidate, {'foundation': value['foundation'], 'build': bound}, root)
    require(all(rel[key] == image_candidate[key] for key in ('api_digest', 'web_digest')))
    match(r'[a-z][a-z0-9-]{0,29}', rel['release_id'])
    for key in ('database_secret_version', 'backend_secret_version'):
        match(r'[a-f0-9]{32}', rel[key])
    require(type(rel['storage_cleanup_hold']) is bool)
    interval = rel['storage_sweep_interval_seconds']
    require(type(interval) is int and 1 <= interval <= 86400)
    limits = validate_limits(rel['runtime_limits'])
    # Capacity expansion needs its own measured DB/replica review.
    require(limits['DB_CONNECTION_LIMIT'] == 5)
    validate_mail(rel)
    return value

def has_unknown(value):
    if isinstance(value, dict):
        return any(has_unknown(v) for v in value.values())
    if isinstance(value, list):
        return any(has_unknown(v) for v in value)
    return value is True
