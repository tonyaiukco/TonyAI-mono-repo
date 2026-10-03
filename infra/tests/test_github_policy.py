"""Owner pre-federation trust root fails closed, independently of environment rules."""
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from github_environment import verify_repository
from pooler import SafeFailure


def ruleset():
    return {'target':'branch', 'enforcement':'active', 'bypass_actors':[],
            'conditions':{'ref_name':{'include':['refs/heads/main'], 'exclude':[]}},
            'rules':[{'type':'deletion'}, {'type':'non_fast_forward'},
                     {'type':'pull_request', 'parameters':{'required_approving_review_count':1, 'dismiss_stale_reviews_on_push':True}},
                     {'type':'required_status_checks', 'parameters':{'strict_required_status_checks_policy':True,
                      'required_status_checks':[{'context':c, 'integration_id':15368} for c in ('build','docker-build','rls-probe')]}}]}


class RepositoryPolicyTests(unittest.TestCase):
    def check(self, rule=None, listing=None, mode='ephemeral-jit', approval='all_external_contributors'):
        responses = {'rulesets?per_page=100': [{'name':'tonyai-main-release', 'id':123}] if listing is None else listing,
                     'rulesets/123': ruleset() if rule is None else rule,
                     'actions/variables/STAGING_RUNNER_MODE': {'value':mode},
                     'actions/permissions/fork-pr-contributor-approval': {'approval_policy':approval}}
        verify_repository('owner/repo', lambda path: responses[path.removeprefix('repos/owner/repo/')])

    def test_valid_policy_and_missing_disabled_bypass_or_wrong_branch(self):
        self.check()
        for listing in ([], [{'name':'wrong','id':123}], [{'name':'tonyai-main-release','id':123}]*2):
            with self.assertRaises(SafeFailure): self.check(listing=listing)
        for field,value in [('enforcement','evaluate'),('target','tag'),('bypass_actors',[{'actor_type':'RepositoryRole','actor_id':5}]),
                            ('conditions',{'ref_name':{'include':['~ALL'], 'exclude':[]}}),('bypass_actors',None)]:
            rule=ruleset();rule[field]=value
            with self.subTest(field=field), self.assertRaises(SafeFailure): self.check(rule)

    def test_each_required_rule_and_parameter(self):
        for name in ('deletion','non_fast_forward','pull_request','required_status_checks'):
            rule=ruleset();rule['rules']=[r for r in rule['rules'] if r['type']!=name]
            with self.subTest(name=name), self.assertRaises(SafeFailure): self.check(rule)
        for index,field,value in [(2,'required_approving_review_count',0),(2,'dismiss_stale_reviews_on_push',False),
                                  (3,'strict_required_status_checks_policy',False)]:
            rule=ruleset();rule['rules'][index]['parameters'][field]=value
            with self.subTest(field=field), self.assertRaises(SafeFailure): self.check(rule)
        for context in ('build','docker-build','rls-probe'):
            rule=ruleset();rule['rules'][3]['parameters']['required_status_checks']=[{'context':c, 'integration_id':15368} for c in ('build','docker-build','rls-probe') if c!=context]
            with self.assertRaises(SafeFailure): self.check(rule)

    def test_status_source_cannot_be_an_arbitrary_commit_status(self):
        rule=ruleset();rule['rules'][3]['parameters']['required_status_checks'][0].pop('integration_id')
        with self.assertRaises(SafeFailure): self.check(rule)

    def test_runner_configuration_and_fork_approval_fail_closed(self):
        for mode in (None, 'persistent', 'github-hosted', ''):
            with self.assertRaises(SafeFailure): self.check(mode=mode)
        for policy in (None, 'first_time_contributors', 'first_time_contributors_new_to_github'):
            with self.assertRaises(SafeFailure): self.check(approval=policy)
