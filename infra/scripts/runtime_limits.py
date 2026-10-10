"""Nonsecret runtime budget validation shared by deployment and readback."""
import json
from pathlib import Path
from pooler import SafeFailure

DEFAULTS = json.loads((Path(__file__).resolve().parents[1] / 'config/runtime-limits.json').read_text())


def validate_limits(overrides):
    if not isinstance(overrides, dict) or set(overrides) - set(DEFAULTS):
        raise SafeFailure('Unknown runtime limit.')
    if any(type(v) is not int or not 1 <= v <= 2147483647 for v in overrides.values()):
        raise SafeFailure('Runtime budgets must be positive bounded integers.')
    limits = {**DEFAULTS, **overrides}
    if (limits['UPLOAD_USER_CONCURRENCY'] > limits['UPLOAD_CONCURRENCY']
            or not max(limits['BULK_DEADLINE_MS'], limits['PDF_TIMEOUT_MS']) + 50000 <= limits['SHUTDOWN_GRACE_MS'] <= 3600000
            or limits['HTTP_HEADERS_TIMEOUT_MS'] > limits['HTTP_BODY_TIMEOUT_MS']
            or limits['MUTATION_USER_CONCURRENCY'] > limits['MUTATION_CONCURRENCY']
            or limits['MUTATION_CONCURRENCY'] >= limits['DB_CONNECTION_LIMIT']
            or limits['IMPORT_CONCURRENCY'] + limits['REPORT_CONCURRENCY'] >= limits['DB_CONNECTION_LIMIT']):
        raise SafeFailure('Incompatible runtime budgets.')
    return limits


def expected_env(release):
    return {**{k: str(v) for k, v in validate_limits(release.get('runtime_limits', {})).items()},
            'NODE_OPTIONS': '--max-old-space-size=768', 'PROXY_MODE': 'azure', 'AZURE_INGRESS_ONLY': 'true'}
