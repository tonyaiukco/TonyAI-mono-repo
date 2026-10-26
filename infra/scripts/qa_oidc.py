#!/usr/bin/env python3
"""Inspect only a saved Unit 5 binary; prepare a permanently blocked review draft."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
from candidate import clean_source
from qa_contract import ROOT, load, require, sha256
from qa_discovery import digest
from qa_foundation import QA_ROOT, CONFIG_FILES, bind_snapshot
from qa_oidc_contract import predecessor
from qa_oidc_plan import check_plan


def inspect_plan(request, evidence, binary_path, terraform, *, runner=subprocess.run, now=None):
    before, after, _, _ = predecessor(request, evidence, now=now)
    clean_source(after['release_sha'])
    caller_path = Path(binary_path)
    path = caller_path.resolve(strict=True)
    require(path.is_file() and path.stat().st_size <= 32 * 1024 * 1024)
    binary = path.read_bytes()
    plan_hash = bind_snapshot(binary)
    require(Path(terraform).is_absolute() and Path(terraform).is_file())
    tool_path = Path(terraform).resolve(strict=True)
    tool_hash = sha256(tool_path.read_bytes())
    with tempfile.TemporaryDirectory(prefix='qa-oidc-inspect-') as directory:
        saved = Path(directory) / 'review.tfplan'
        saved.write_bytes(binary)
        saved.chmod(0o600)
        result = runner([str(tool_path), 'show', '-json', str(saved)], cwd=QA_ROOT,
                        env={'PATH': os.defpath, 'HOME': directory, 'CHECKPOINT_DISABLE': '1'},
                        capture_output=True, text=True, timeout=120, check=False)
        require(result.returncode == 0 and len(result.stdout) <= 32 * 1024 * 1024)
        plan = json.loads(result.stdout)
        summary = check_plan(plan, request, evidence, source_bound=True, now=now)
    require(caller_path.resolve(strict=True) == path and path.read_bytes() == binary
            and Path(terraform).resolve(strict=True) == tool_path
            and sha256(tool_path.read_bytes()) == tool_hash)
    clean_source(after['release_sha'])
    return {**summary, 'source_sha': after['release_sha'], 'previous_source_sha': before['release_sha'],
            'saved_plan_path': str(path), 'terraform_path': str(tool_path),
            'terraform_version': '1.13.3', 'terraform_binary_sha256': tool_hash,
            'plan_created_at': plan['timestamp'], 'plan_sha256': plan_hash,
            'request_sha256': digest(request), 'predecessor_sha256': digest(evidence),
            'previous_plan_sha256': evidence['saved_plan']['plan_sha256'],
            'previous_readback_sha256': digest(evidence['after_receipt']),
            'previous_owner_acceptance_sha256': evidence['owner_acceptance_sha256'],
            'before_inputs_sha256': digest(before), 'after_inputs_sha256': digest(after),
            'provider_lock_sha256': sha256((QA_ROOT / '.terraform.lock.hcl').read_bytes()),
            'deployment_policy_sha256': sha256((ROOT / 'infra/config/deployment-policy.json').read_bytes()),
            'configuration_sha256': digest({n: sha256((QA_ROOT / n).read_bytes()) for n in sorted(CONFIG_FILES)})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('request', 'predecessor', 'saved-plan', 'terraform'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--ruleset-id', type=int, required=True, help='Public ruleset ID; never guessed or authenticated by this tool')
    parser.add_argument('--observations', help='Public before receipt plus plan_completed_at; local consistency only')
    args = parser.parse_args()
    try:
        paths = [Path(args.request), Path(args.predecessor)]
        if args.observations:
            paths.append(Path(args.observations))
        hashes = {str(p): sha256(p.read_bytes()) for p in paths}
        request, evidence = load(args.request), load(args.predecessor)
        report = inspect_plan(request, evidence, args.saved_plan, args.terraform)
        report['file_sha256'] = hashes
        from qa_oidc_packet import prepare
        packet = prepare(request, evidence, report, args, load(args.observations) if args.observations else None)
        require(hashes == {str(p): sha256(p.read_bytes()) for p in paths})
    except Exception:
        raise SystemExit('FAIL: QA Unit 5 saved-plan/packet refused; details withheld.') from None
    print(json.dumps(packet, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
