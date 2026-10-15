"""Prevent the legacy hosted/Germany path from deploying the selected Sweden tenant."""
import json
from pathlib import Path
from pooler import SafeFailure


def require_hosted_target(subscription):
    policy = json.loads((Path(__file__).resolve().parents[1] / 'config/deployment-policy.json').read_text())
    if str(subscription).lower() in policy['selfhost_sweden_subscriptions']:
        raise SafeFailure('This subscription requires Sweden VNet/selfhost application integration, which is pending. Legacy hosted roots are blocked.')
