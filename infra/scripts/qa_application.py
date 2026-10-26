#!/usr/bin/env python3
"""Inspect a saved application binary offline and prepare a non-authorizing owner draft."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
from candidate import clean_source
from qa_contract import ROOT, load, release, require, sha256
from qa_discovery import digest
from qa_foundation import bind_snapshot
from qa_release import check_plan

QA_ROOT = ROOT / 'infra/terraform/application/qa'
CONFIG_FILES = {'main.tf', 'variables.tf', 'outputs.tf', 'versions.tf'}


def inspect_plan(inputs, candidate, binary_path, terraform, *, acknowledge_clear_hold=False, runner=subprocess.run):
    release(inputs, candidate)
    source = inputs['release']['source_sha']
    clean_source(source)
    binary_path = Path(binary_path).resolve(strict=True)
    require(binary_path.is_file() and binary_path.stat().st_size <= 32 * 1024 * 1024)
    binary = binary_path.read_bytes()
    plan_hash = bind_snapshot(binary, QA_ROOT, config_files=CONFIG_FILES)
    require(Path(terraform).is_absolute() and Path(terraform).is_file())
    tool_hash = sha256(Path(terraform).read_bytes())
    with tempfile.TemporaryDirectory(prefix='qa-application-inspect-') as directory:
        saved = Path(directory) / 'review.tfplan'
        saved.write_bytes(binary)
        saved.chmod(0o600)
        result = runner([terraform, 'show', '-json', str(saved)], cwd=QA_ROOT,
                        env={'PATH': os.defpath, 'HOME': directory, 'CHECKPOINT_DISABLE': '1'},
                        capture_output=True, text=True, timeout=120, check=False)
        require(result.returncode == 0 and len(result.stdout) <= 32 * 1024 * 1024)
        plan = json.loads(result.stdout)
        check_plan(plan, inputs, acknowledge_clear_hold, source_bound=True)
    require(binary_path.read_bytes() == binary and sha256(Path(terraform).read_bytes()) == tool_hash)
    clean_source(source)
    return {
        'source_sha': source, 'release_id': inputs['release']['release_id'],
        'terraform_version': '1.13.3', 'terraform_binary_sha256': tool_hash, 'plan_created_at': plan['timestamp'],
        'plan_sha256': plan_hash, 'normalized_inputs_sha256': digest(inputs),
        'candidate_sha256': digest(candidate),
        'provider_lock_sha256': sha256((QA_ROOT / '.terraform.lock.hcl').read_bytes()),
        'configuration_sha256': digest({name: sha256((QA_ROOT / name).read_bytes()) for name in sorted(CONFIG_FILES)}),
        'resources': [{'address': r['address'], 'actions': r['change']['actions'],
                       'expected_body_sha256': digest(r['change']['after']['body']),
                       'previous_body_sha256': digest(r['change']['before']['body']) if r['change'].get('before') else None,
                       'id': r['change']['after']['parent_id'] + '/providers/Microsoft.App/containerApps/' + r['change']['after']['name']}
                      for r in sorted(plan['resource_changes'], key=lambda r: r['address'])],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('inputs', 'candidate', 'saved-plan', 'terraform'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--ack-clear-storage-hold', action='store_true')
    parser.add_argument('--observations', help='Optional public pre-release receipt; never authenticated Azure evidence')
    parser.add_argument('--predecessor', help='Optional public predecessor evidence; remains blocked pending owner review')
    parser.add_argument('--github-run-id', help='Opt-in GitHub read; reauthenticate the candidate through the existing downloader')
    args = parser.parse_args()
    try:
        paths = [Path(args.inputs), Path(args.candidate)]
        hashes = [sha256(p.read_bytes()) for p in paths]
        inputs, candidate = load(args.inputs), load(args.candidate)
        provenance = {'verification': 'local_file_only_not_authenticated'}
        if args.github_run_id:
            from qa_candidate_artifact import download
            verified, provenance = download('tonyaiukco/TonyAI-mono-repo', inputs['release']['source_sha'],
                                            args.github_run_id, with_provenance=True)
            require(verified == candidate and provenance['candidate_file_sha256'] == hashes[1])
        report = inspect_plan(inputs, candidate, args.saved_plan, args.terraform,
                              acknowledge_clear_hold=args.ack_clear_storage_hold)
        require(hashes == [sha256(p.read_bytes()) for p in paths])
        report.update(input_file_sha256=hashes[0], candidate_file_sha256=hashes[1])
        from qa_owner_packet import prepare
        packet = prepare(inputs, report, provenance, args,
                         load(args.observations) if args.observations else None,
                         load(args.predecessor) if args.predecessor else None)
    except Exception:
        raise SystemExit('FAIL: QA application saved-plan/packet refused; details withheld.') from None
    print(json.dumps(packet, indent=2, sort_keys=True))


if __name__ == '__main__':
    main()
