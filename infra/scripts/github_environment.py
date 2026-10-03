"""Fail closed on the existing GitHub staging environment before trusting OIDC."""
import json
from cloud_ops import command
from pooler import SafeFailure


def verify_environment(repo):
    def read(path):
        return json.loads(command(['gh', 'api', '--hostname', 'github.com',
                                   '-H', 'X-GitHub-Api-Version: 2022-11-28', path]))
    base = 'repos/' + repo + '/environments/staging'
    environment = read(base)
    reviewers = [rule for rule in environment.get('protection_rules', [])
                 if rule.get('type') == 'required_reviewers']
    if (environment.get('name') != 'staging' or len(reviewers) != 1
            or reviewers[0].get('prevent_self_review') is not True
            or not reviewers[0].get('reviewers')
            or any(r.get('type') not in ('User', 'Team') or not r.get('reviewer', {}).get('id')
                   for r in reviewers[0]['reviewers'])
            or environment.get('deployment_branch_policy') != {
                'protected_branches': False, 'custom_branch_policies': True}):
        raise SafeFailure('Staging requires reviewers, prevented self-review and selected branch protection.')
    policies = read(base + '/deployment-branch-policies?per_page=100')
    rows = policies.get('branch_policies', [])
    if policies.get('total_count') != 1 or len(rows) != 1 or rows[0].get('name') != 'main' or rows[0].get('type') != 'branch':
        raise SafeFailure('Staging must allow only the main branch, with no tag or wildcard policies.')
