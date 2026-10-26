#!/usr/bin/env python3
"""CI-only adapter: exercise the initial oracle on Terraform's computed mock plan."""
import json
from pathlib import Path
import sys
from qa_contract import SUBSCRIPTION, require
from qa_foundation_inputs import initial_inputs
from qa_foundation_plan import check_plan


def check(path):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines()]
    plans = [r['test_plan'] for r in rows if r.get('type') == 'test_plan' and r.get('@testrun') == 'initial_computed_references']
    require(len(plans) == 1 and any(r.get('test_summary', {}).get('failed') == 0 for r in rows))
    inputs = {'config': dict(subscription_id=SUBSCRIPTION, tenant_id='00000000-0000-0000-0000-000000000002',
        owner_object_id='00000000-0000-0000-0000-000000000003', registry_name='tonyaiqatest', vault_name='tonyai-qa-test',
        release_sha='a' * 40, oidc_enabled=False, runtime_secrets_ready=False, smtp_secret_ready=False, apps_ready=False)}
    # test_plan omits real saved-plan metadata. These synthetic fields are ONLY
    # for the oracle exercise; this adapter cannot inspect or authorize a saved plan.
    plan = {**plans[0], 'terraform_version': '1.13.3', 'format_version': '1.2',
            'complete': True, 'errored': False, 'applyable': True,
            'variables': {'config': {'value': initial_inputs(inputs)}}}
    check_plan(plan, inputs, source_bound=True)


if __name__ == '__main__':
    check(sys.argv[1])
    print('PASS: initial foundation computed MOCK matches oracle; no saved-plan source binding or live acceptance.')
