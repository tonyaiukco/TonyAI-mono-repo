"""Fail closed on the existing GitHub staging environment before trusting OIDC."""
import json
from cloud_ops import command
from pooler import SafeFailure


def verify_repository(repo, read):
    """Owner/admin preflight: missing fields or unavailable settings are refusals."""
    base = 'repos/' + repo
    rulesets = read(base + '/rulesets?per_page=100')
    matches = [r for r in rulesets if r.get('name') == 'tonyai-main-release']
    if len(matches) != 1:
        raise SafeFailure('Create the dedicated tonyai-main-release ruleset before federation.')
    ruleset = read(base + '/rulesets/' + str(matches[0]['id']))
    if (ruleset.get('target') != 'branch' or ruleset.get('enforcement') != 'active'
            or ruleset.get('bypass_actors') != []
            or ruleset.get('conditions') != {'ref_name': {'include': ['refs/heads/main'], 'exclude': []}}):
        raise SafeFailure('Main requires an active exact-branch ruleset with no bypass actors.')
    rules = {rule['type']: rule.get('parameters', {}) for rule in ruleset.get('rules', [])}
    pull = rules.get('pull_request', {})
    checks = rules.get('required_status_checks', {})
    contexts = {check.get('context') for check in checks.get('required_status_checks', [])
                if check.get('integration_id') == 15368}  # GitHub Actions, verified from this repo's check runs
    if (not {'deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'} <= rules.keys()
            or pull.get('required_approving_review_count', 0) < 1
            or pull.get('dismiss_stale_reviews_on_push') is not True
            or pull.get('require_last_push_approval') is not True
            or checks.get('strict_required_status_checks_policy') is not True
            or not {'build', 'docker-build', 'rls-probe'} <= contexts):
        raise SafeFailure('Main requires reviewed PRs, current CI checks and no deletion or force pushes.')
    # This personal/public repository supports JIT only. A label is not isolation.
    # GitHub REST does not expose whether a runner's host is destroyed after a job;
    # the owner must also verify the JIT provisioner and fresh-host teardown.
    mode = read(base + '/actions/variables/STAGING_RUNNER_MODE')
    approval = read(base + '/actions/permissions/fork-pr-contributor-approval')
    if mode.get('value') != 'ephemeral-jit' or approval.get('approval_policy') != 'all_external_contributors':
        raise SafeFailure('Require ephemeral JIT hosts and approval for all outside collaborators.')


def verify_environment(repo):
    def read(path):
        return json.loads(command(['gh', 'api', '--hostname', 'github.com',
                                   '-H', 'X-GitHub-Api-Version: 2022-11-28', path]))
    base = 'repos/' + repo + '/environments/staging'
    environment = read(base)
    reviewers = [rule for rule in environment.get('protection_rules', [])
                 if rule.get('type') == 'required_reviewers']
    if (environment.get('name') != 'staging' or len(reviewers) != 1
            or environment.get('can_admins_bypass') is not False
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
    verify_repository(repo, read)


if __name__ == '__main__':
    import argparse
    import sys
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    args = parser.parse_args()
    try:
        verify_environment(args.repo)
        print('PASS: readable GitHub environment, main ruleset and JIT policy prerequisites.')
        print('Owner must separately verify fresh JIT host provisioning and destruction; REST cannot prove host isolation.')
    except Exception:
        sys.exit('FAIL: GitHub release prerequisites missing or unreadable; do not configure federation or dispatch.')
