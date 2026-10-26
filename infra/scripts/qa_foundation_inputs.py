"""Initial Sweden foundation inputs: public identifiers and four explicit false gates."""
from qa_contract import SUBSCRIPTION, fields, match, require

FLAGS = ('oidc_enabled', 'runtime_secrets_ready', 'smtp_secret_ready', 'apps_ready')
DEFAULTS = dict(environment='staging', resource_group='tonyai-staging-apps',
                prefix='tonyai', repository='tonyaiukco/TonyAI-mono-repo')
UUID = r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'


def initial_inputs(value):
    fields(value, 'config')
    config = value['config']
    fields(config, 'subscription_id tenant_id owner_object_id registry_name vault_name release_sha '
           + ' '.join(FLAGS), ' '.join(DEFAULTS))
    require(config['subscription_id'] == SUBSCRIPTION)
    for key in ('tenant_id', 'owner_object_id'):
        match(UUID, config[key])
    for key, pattern in {'registry_name': r'[a-z0-9]{5,50}',
                         'vault_name': r'[a-z][a-z0-9-]{1,22}[a-z0-9]',
                         'release_sha': r'[a-f0-9]{40}'}.items():
        match(pattern, config[key])
    require(all(config[key] is False for key in FLAGS))
    require(all(config.get(key, default) == default for key, default in DEFAULTS.items()))
    return {**DEFAULTS, **config}
