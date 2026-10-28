"""Fence hosted QA from the paused self-hosted subscription resources."""
import json
from pathlib import Path
from pooler import SafeFailure


def require_hosted_target(subscription, resource_group=None, prefix=None, environment='staging'):
    policy = json.loads((Path(__file__).resolve().parents[1] / 'config/deployment-policy.json').read_text())
    if str(subscription).lower() in policy['selfhost_sweden_subscriptions']:
        from hosted_target import require_exception_target
        require_exception_target(subscription, resource_group, prefix, environment)
    elif (str(resource_group).lower().startswith('tonyai-qatmp') or str(prefix).lower() == 'tonyaiqt'):
        from hosted_target import require_exception_target
        require_exception_target(subscription, resource_group, prefix, environment)
