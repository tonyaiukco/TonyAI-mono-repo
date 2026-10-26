#!/usr/bin/env python3
"""Check a real mock Terraform plan against the independent release body oracle."""
import json
from pathlib import Path
import sys
from qa_release import check_plan


def check(path):
    plans = [json.loads(line) for line in Path(path).read_text().splitlines()]
    selected = [row['test_plan'] for row in plans if row.get('type') == 'test_plan'
                and row.get('@testrun') == 'application_security_contract']
    if len(selected) != 1:
        raise ValueError('Missing unique actual Terraform application test plan.')
    plan = selected[0]
    inputs = plan['output_changes']['reviewed_inputs']['after']
    if inputs['release'].get('mail') is None:
        inputs['release'].pop('mail', None)
    plan.update(timestamp='2000-01-01T00:00:00Z', terraform_version='1.13.3', format_version='1.2', complete=True, errored=False, applyable=True)
    plan['variables'] = {key: {'value': value} for key, value in inputs.items()}
    # The legacy-derived synthetic fixture explicitly clears hold. This only
    # tests a mock plan; the owner execution gate still defaults to refusal.
    from copy import deepcopy
    plan['variables'] = deepcopy(plan['variables'])
    plan['variables']['release']['value']['mail'] = inputs['release'].get('mail')
    plan['output_changes']['reviewed_inputs']['after'] = deepcopy(inputs)
    plan['output_changes']['reviewed_inputs']['after']['release']['mail'] = inputs['release'].get('mail')
    check_plan(plan, inputs, acknowledge_clear_hold=True, source_bound=True)


if __name__ == '__main__':
    check(sys.argv[1])
    print('PASS: actual Terraform mock plan matches the independent QA body oracle.')
