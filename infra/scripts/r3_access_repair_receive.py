"""Separately approved strict-pinned SSH fetch of private recovery evidence only."""
import argparse
import os
from pathlib import Path
import sys

if __name__ == '__main__':
    import tempfile
    _cache = tempfile.TemporaryDirectory(prefix='r3-access-receive-cache-')
    sys.pycache_prefix = _cache.name
    sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_access_repair import require, sha256
from r3_access_repair_contract import approve, durable, freshness, load
from r3_access_repair_custody import probe, seal, validate_export, validate_summary
from r3_noble_common import read
from r3_policy_receive import capture_signals, known_host, receive, ssh_argv


def execute(packet, approval_raw, approval_hash, fresh_raw, summary_raw, interrupted):
    os.umask(0o077)
    plan, proposal, fresh = approve(packet, approval_raw, approval_hash, fresh_raw, 'export')
    custody, target = plan['custody'], plan['target']
    require(fresh['host_key_fingerprint'] == known_host(read(custody['known_hosts'], 16384), target['connection']['host']), 'HOST_PIN')
    require(fresh['repair_summary_sha256'] == sha256(summary_raw), 'SUMMARY_BINDING')
    packet = Path(packet)
    require(summary_raw == read(packet / 'repair-summary.json'), 'CANONICAL_REPAIR_SUMMARY')
    control_summary = load(summary_raw)
    require(control_summary['status'] in ('KEY_APPENDED_CUSTODY_REQUIRED', 'PARTIAL_REVIEW_REQUIRED') and
            control_summary['phase'] == 'repair',
            'REPAIR_SUMMARY_STATE')
    marker = load(read(packet / 'repair-consumed.json'))
    require(marker['delivery_sha256'] == sha256(read(packet / 'delivery.json')), 'REPAIR_CONSUMPTION_BINDING')
    summary = control_summary['guest_summary']
    if summary is not None:
        validate_summary(summary, proposal)
    complete_arm = (summary is not None and control_summary['status'] == 'KEY_APPENDED_CUSTODY_REQUIRED'
                    and control_summary['custody']['sealed'] is True)
    durable(packet / 'export-consumed.json', {'approval_sha256': approval_hash,
            'repair_summary_sha256': sha256(summary_raw), 'attempts': 1})
    output = packet / 'export-capture'
    output.mkdir(mode=0o700)
    result = {'status': 'PARTIAL_REVIEW_REQUIRED', 'failure': None, 'sealed': False,
              'qualification': False, 'installation_success': False, 'policy_generated': False}
    try:
        probe(custody, output)
        require(not interrupted, 'INTERRUPTED')
        freshness(fresh)
        disposition = receive(ssh_argv({'target': target, 'custody': custody}),
                              read(packet / 'export.py'), output, interrupted)
        durable(output / 'capture.json', disposition)
        # Preserve a semantic record even when transport failed; validation
        # cannot convert truncated/refused output into successful custody.
        if complete_arm:
            checked = validate_export(read(output / 'guest.json'), proposal, summary)
        else:
            checked = {'status': 'PARTIAL_REVIEW_REQUIRED', 'reason': 'NO_COMPLETE_ARM_RECEIPT'}
        durable(output / 'validation.json', checked)
        require(disposition['returncode'] == 0 and disposition['failure'] is None and
                disposition['cleanup_errors'] == [] and not interrupted, 'FETCH_PARTIAL')
        result.update(checked)
    except Exception as exc:
        result['failure'] = type(exc).__name__
    finally:
        durable(output / 'result.json', result)
        result['custody'] = seal(custody, output, packet / 'export-capture.tar.age')
        result['sealed'] = result['custody']['sealed']
        if not result['sealed']:
            result['status'] = 'PARTIAL_REVIEW_REQUIRED'
        if interrupted:
            result.update(status='PARTIAL_REVIEW_REQUIRED', interruption=interrupted[0])
        durable(packet / 'export-summary.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--packet', type=Path, required=True)
    parser.add_argument('--approval', type=Path, required=True)
    parser.add_argument('--approval-sha256', required=True)
    parser.add_argument('--fresh', type=Path, required=True)
    parser.add_argument('--repair-summary', type=Path, required=True)
    parser.add_argument('--execute', action='store_true', required=True)
    args = parser.parse_args()
    with capture_signals() as interrupted:
        result = execute(args.packet, read(args.approval), args.approval_sha256,
                         read(args.fresh), read(args.repair_summary), interrupted)
    print(result['status'])
    raise SystemExit(0 if result['sealed'] and result['status'] == 'REPAIR_EVIDENCE_VERIFIED_REVIEW_REQUIRED' else 2)
