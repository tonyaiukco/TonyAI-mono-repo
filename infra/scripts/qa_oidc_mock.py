#!/usr/bin/env python3
"""Credential-free MOCK rehearsal in a disposable copy; never init or real plan/apply."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
from qa_contract import ROOT, require
from qa_foundation import QA_ROOT, CONFIG_FILES
from qa_oidc_plan import check_plan


def check(rows):
    # Terraform test JSON lacks the saved-plan envelope and prior-state section.
    # Supply synthetic envelope ONLY here, retaining real change.before values.
    import sys
    sys.path.insert(0, str(ROOT / 'infra/tests'))
    from qa_oidc_fixtures import request, evidence, plan, NOW
    require(not any(r.get('type') == 'diagnostic' and r.get('diagnostic', {}).get('severity') == 'error' for r in rows))
    summary = [r['test_summary'] for r in rows if r.get('type') == 'test_summary']
    require(len(summary) == 1 and summary[0]['failed'] == 0 and summary[0]['passed'] == 2)
    plans = [r['test_plan'] for r in rows if r.get('type') == 'test_plan' and r.get('@testrun') == 'oidc_transition']
    require(len(plans) == 1)
    actual = plans[0]
    value = plan()
    value.update(resource_changes=actual['resource_changes'], output_changes=actual['output_changes'])
    value['prior_state']['values']['root_module']['resources'] = [
        {**{k: r[k] for k in ('address', 'mode', 'type', 'provider_name')}, 'values': r['change']['before']}
        for r in actual['resource_changes'] if r['change']['before'] is not None]
    check_plan(value, request(), evidence(), source_bound=True, now=NOW)


def run(terraform):
    require(Path(terraform).is_absolute() and Path(terraform).is_file())
    with tempfile.TemporaryDirectory(prefix='qa-oidc-mock-') as directory:
        root = Path(directory) / 'infra/terraform/foundation/qa'
        root.mkdir(parents=True)
        policy = Path(directory) / 'infra/config/deployment-policy.json'
        policy.parent.mkdir()
        policy.write_bytes((ROOT / 'infra/config/deployment-policy.json').read_bytes())
        removed = 0
        for name in CONFIG_FILES:
            content = (QA_ROOT / name).read_text()
            lines = content.splitlines(keepends=True)
            # Only mock teardown needs these five guards absent. Never alter
            # checked-in configuration or any resource request, grant or input.
            stripped = [l for l in lines if l.strip() != 'prevent_destroy = true' and l.strip() != 'lifecycle { prevent_destroy = true }']
            removed += len(lines) - len(stripped)
            (root / name).write_text(''.join(stripped))
        require(removed == 5)
        (root / '.terraform.lock.hcl').write_bytes((QA_ROOT / '.terraform.lock.hcl').read_bytes())
        (root / '.terraform').mkdir()
        (root / '.terraform/providers').symlink_to(QA_ROOT / '.terraform/providers', target_is_directory=True)
        (root / 'oidc.tftest.hcl').write_bytes((ROOT / 'infra/tests/fixtures/qa-oidc.tftest.hcl').read_bytes())
        result = subprocess.run([terraform, 'test', '-json', '-verbose', '-filter=oidc.tftest.hcl'], cwd=root,
            env={'PATH': os.defpath, 'HOME': directory, 'CHECKPOINT_DISABLE': '1'}, capture_output=True, text=True, timeout=120)
        require(result.returncode == 0)
        check([json.loads(line) for line in result.stdout.splitlines()])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--terraform', required=True)
    args = parser.parse_args()
    try:
        run(args.terraform)
    except Exception:
        raise SystemExit('FAIL: Unit 5 MOCK transition refused; details withheld.') from None
    print('PASS: Unit 5 actual MOCK changes match policy; synthetic envelope, no saved-binary or live acceptance.')
