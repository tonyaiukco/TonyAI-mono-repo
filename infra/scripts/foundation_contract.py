"""Reject unknown/untyped owner inputs before Terraform can display or persist them."""
import re
from uuid import UUID
from pooler import SafeFailure
from deployment_policy import require_hosted_target


def validate_foundation(inputs):
    if set(inputs) != {'config'} or not isinstance(inputs['config'], dict):
        raise SafeFailure('Foundation input must contain only config.')
    config = inputs['config']
    require_hosted_target(config.get('subscription_id'), config.get('resource_group'),
                          config.get('prefix'), config.get('environment'))
    required = {'subscription_id','tenant_id','environment','prefix','resource_group','registry_name',
                'vault_name','repository','release_sha','owner_object_id'}
    optional = {'deployer_object_id','runtime_secrets_ready','smtp_secret_ready','apps_ready','monitoring','email'}
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
    if any(type(config.get(k,False)) is not bool for k in ('runtime_secrets_ready','smtp_secret_ready','apps_ready')):
        raise SafeFailure('Readiness switches must be booleans.')
    if config.get('apps_ready') and not deployer:
        raise SafeFailure('App grants require the verified deployment principal.')
    monitoring = config.get('monitoring')
    if monitoring is not None:
        patterns = {'operator_name': r'[A-Za-z][A-Za-z0-9 ._-]{1,79}',
                    'operator_email': r'[^@ <>]+@[^@ <>]+\.[^@ <>]+',
                    'api_digest': r'sha256:[a-f0-9]{64}', 'supabase_project_ref': r'[a-z]{20}',
                    'database_secret_version': r'[a-f0-9]{32}', 'backend_secret_version': r'[a-f0-9]{32}'}
        if (not config.get('runtime_secrets_ready') or not isinstance(monitoring, dict)
                or set(monitoring) != set(patterns)
                or any(not isinstance(monitoring[k], str) or not re.fullmatch(p, monitoring[k]) for k,p in patterns.items())):
            raise SafeFailure('Monitoring needs named operator, immutable release references and runtime grants.')
    validate_email(config)
    return config


def validate_email(config):
    email = config.get('email')
    if email is None:
        if config['prefix'] == 'tonyaiqt':
            raise SafeFailure('Hosted QA requires the ACS Email identity configuration.')
        return
    required = {'client_id', 'principal_id', 'tenant_id'}
    if (not isinstance(email, dict) or not required <= set(email)
            or set(email) - required - {'custom_domain', 'custom_domain_verified'}):
        raise SafeFailure('Email accepts only nonsecret Entra IDs and optional domain settings.')
    if any(not isinstance(email[k], str) or not re.fullmatch(
            r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', email[k])
            or email[k] == '00000000-0000-0000-0000-000000000000' for k in required):
        raise SafeFailure('Email identities must be nonzero canonical UUIDs.')
    if (email['tenant_id'] != config['tenant_id']
            or email['principal_id'] in (config['owner_object_id'], config.get('deployer_object_id'))):
        raise SafeFailure('SMTP needs a separate principal in the foundation tenant.')
    domain = email.get('custom_domain')
    verified = email.get('custom_domain_verified', False)
    if (type(verified) is not bool or (verified and domain is None)
            or (domain is not None and (not isinstance(domain, str) or len(domain) > 253
                or not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', domain)))):
        raise SafeFailure('Use a DNS domain; link it only after owner-run verification.')
