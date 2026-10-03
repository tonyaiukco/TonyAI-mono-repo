"""Reject unknown/untyped owner inputs before Terraform can display or persist them."""
import re
from uuid import UUID
from pooler import SafeFailure


def validate_foundation(inputs):
    if set(inputs) != {'config'} or not isinstance(inputs['config'], dict):
        raise SafeFailure('Foundation input must contain only config.')
    config = inputs['config']
    required = {'subscription_id','tenant_id','environment','prefix','resource_group','registry_name',
                'vault_name','repository','release_sha','owner_object_id'}
    optional = {'deployer_object_id','runtime_secrets_ready','apps_ready'}
    if not required <= set(config) or set(config) - required - optional:
        raise SafeFailure('Unknown foundation fields; secret values are prohibited.')
    if config['environment'] not in ('staging','production'):
        raise SafeFailure('Invalid foundation environment.')
    for key in ('subscription_id','tenant_id','owner_object_id'):
        try:
            UUID(config[key])
        except (ValueError, TypeError, AttributeError):
            raise SafeFailure('Foundation IDs must be UUIDs.') from None
    deployer = config.get('deployer_object_id', '')
    if deployer:
        UUID(deployer)
        if deployer == config['owner_object_id']:
            raise SafeFailure('Foundation owner and deployer must differ.')
    patterns = {'prefix':r'[a-z0-9]{3,12}', 'resource_group':r'[A-Za-z0-9_-]+',
                'registry_name':r'[a-z0-9]{5,50}', 'vault_name':r'[a-z][a-z0-9-]{1,22}[a-z0-9]',
                'repository':r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+','release_sha':r'[a-f0-9]{40}'}
    if any(not isinstance(config[k],str) or not re.fullmatch(p,config[k]) for k,p in patterns.items()):
        raise SafeFailure('Invalid public foundation metadata.')
    if any(type(config.get(k,False)) is not bool for k in ('runtime_secrets_ready','apps_ready')):
        raise SafeFailure('Readiness switches must be booleans.')
    if config.get('apps_ready') and not deployer:
        raise SafeFailure('App grants require the verified deployment principal.')
    return config
