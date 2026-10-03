#!/usr/bin/env python3
"""Require successful main-branch CI and full E2E at the exact candidate SHA (D22)."""
import json
import os
import re
import sys
from cloud_ops import command
from pooler import SafeFailure


def verify(repo, sha, read=None):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise SafeFailure('Invalid repository or candidate SHA.')
    if read is None:
        read = lambda path: json.loads(command(['gh', 'api', '--hostname', 'github.com', path]))
    evidence = {}
    for workflow in ('ci.yml', 'e2e.yml'):
        result = read(f'repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&branch=main&per_page=100')
        runs = [r for r in result.get('workflow_runs', []) if
                r.get('head_sha') == sha and r.get('head_branch') == 'main'
                and r.get('event') in ('push', 'workflow_dispatch', 'schedule')
                and r.get('head_repository', {}).get('full_name') == repo]
        # A newer failed or pending run supersedes earlier green evidence.
        latest = max(runs, key=lambda r: (r['run_number'], r.get('run_attempt', 1)), default=None)
        if not latest or latest.get('status') != 'completed' or latest.get('conclusion') != 'success':
            raise SafeFailure('Missing current successful exact-SHA main run: ' + workflow)
        evidence[workflow] = latest['id']
    return evidence


if __name__ == '__main__':
    try:
        if os.environ.get('GITHUB_REF') != 'refs/heads/main':
            raise SafeFailure('Release workflows run from main only.')
        print(json.dumps(verify(os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_SHA'])))
    except Exception:
        sys.exit('FAIL: exact-candidate CI/E2E release checks refused; no cloud login attempted.')
