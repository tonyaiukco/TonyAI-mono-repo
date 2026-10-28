"""Exact, nonsecret opt-in for hosted QA; no wildcard exceptions."""
import json
from pathlib import Path
import re
from pooler import SafeFailure

EXCEPTION_PATH = Path(__file__).resolve().parents[1] / 'config/hosted-qa-exception.json'
FIELDS = {'subscription', 'resource_group', 'prefix', 'backend_resource_group', 'backend_storage_account'}


def hosted_exception():
    try:
        value = json.loads(EXCEPTION_PATH.read_text())
        valid = (isinstance(value, dict) and set(value) == FIELDS
                 and all(isinstance(v, str) for v in value.values())
                 and re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', value['subscription'])
                 and value['subscription'] != '00000000-0000-0000-0000-000000000000'
                 and value['resource_group'] == 'tonyai-qatmp-apps'
                 and value['prefix'] == 'tonyaiqt'
                 and value['backend_resource_group'] == 'tonyai-qatmp-tfstate'
                 and re.fullmatch(r'tonyaiqt[a-z0-9]{1,16}', value['backend_storage_account']))
        if valid:
            return value
    except (OSError, ValueError, TypeError):
        pass
    raise SafeFailure('Sweden hosted QA needs the reviewed exact exception; placeholders are not deployment inputs.')


def require_exception_target(subscription, resource_group, prefix, environment):
    exception = hosted_exception()
    if (subscription != exception['subscription'] or resource_group != exception['resource_group']
            or prefix != exception['prefix'] or environment != 'staging'):
        raise SafeFailure('Hosted QA subscription, group, prefix and staging environment must match exactly.')


def require_hosted_backend(config):
    # Hosted writer boundary only. Shared shape validation also supports the paused lane.
    from deployment_policy import require_hosted_target
    subscription = config.get('subscription_id')
    policy_path = Path(__file__).resolve().parents[1] / 'config/deployment-policy.json'
    policy = json.loads(policy_path.read_text())
    if (str(subscription).lower() not in policy['selfhost_sweden_subscriptions']
            and not str(config.get('resource_group', '')).lower().startswith('tonyai-qatmp')
            and not str(config.get('storage_account', '')).startswith('tonyaiqt')):
        return
    require_hosted_target(subscription, 'tonyai-qatmp-apps', 'tonyaiqt', config.get('environment'))
    exception = hosted_exception()
    if (config.get('resource_group') != exception['backend_resource_group']
            or config.get('storage_account') != exception['backend_storage_account']
            or config.get('location', 'swedencentral') != 'swedencentral'):
        raise SafeFailure('Hosted QA backend must match its dedicated group and account exactly.')
