#!/usr/bin/env python3
"""One read-only Supabase backup metadata request; no backup download or restore.

API: https://supabase.com/docs/reference/api/v1-list-all-backups
The custom schedule API is Enterprise-only and is deliberately not called for Pro.
"""
import argparse
from datetime import datetime, timezone
import getpass
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import tempfile
from urllib.request import Request, build_opener
from cloud_ops import NoRedirect, write_private_journal
from hosted_probe_runner import validate_receipt_location
from migration_binding import clean, prepare
from pooler import SafeFailure
from terraform_run import ROOT


def summary(payload, now):
    if (not isinstance(payload, dict) or payload.get('region') != 'eu-north-1'
            or not isinstance(payload.get('backups'), list) or len(payload['backups']) > 1000
            or type(payload.get('walg_enabled')) is not bool or type(payload.get('pitr_enabled')) is not bool):
        raise SafeFailure('Unexpected backup metadata or region; no acceptance inferred.')
    completed = []
    for item in payload['backups']:
        if not isinstance(item, dict) or item.get('status') != 'COMPLETED':
            continue
        value = item.get('inserted_at')
        if not isinstance(value, str) or len(value) > 64:
            raise SafeFailure('Unclassifiable backup timestamp.')
        try: timestamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError: raise SafeFailure('Unclassifiable backup timestamp.') from None
        if timestamp.tzinfo is None or (timestamp - now).total_seconds() > 300:
            raise SafeFailure('Backup timestamp has no timezone or is unexpectedly in the future.')
        completed.append(timestamp.astimezone(timezone.utc))
    completed.sort(reverse=True)
    latest = completed[0] if completed else None
    recent = latest is not None and (now - latest).total_seconds() <= 36 * 3600
    return {'region': 'eu-north-1', 'observed_at_utc': now.isoformat(),
            'completed_backup_count': len(completed),
            'latest_completed_backup_inserted_at': latest.isoformat() if latest else None,
            'recent_completed_backup_observed': recent,
            'latest_seven_completed_inserted_at': [value.isoformat() for value in completed[:7]],
            'walg_enabled': payload['walg_enabled'], 'pitr_enabled': payload['pitr_enabled'],
            'custom_schedule_not_queried_on_Pro': True,
            'restore_proven': False, 'storage_file_bytes_proven': False}


def run(candidate, inputs, helper_sha, source, receipt):
    receipt = validate_receipt_location(receipt)
    if receipt.exists(): raise SafeFailure('Backup receipt already exists; no overwrite or retry.')
    clean(ROOT, helper_sha)
    with tempfile.TemporaryDirectory(prefix='tonyai-backup-binding-') as public:
        prepare(Path(source).resolve(), inputs, candidate, Path(public))
    token = getpass.getpass('Supabase Management token with backups_read (memory only): ')
    project = inputs['release']['supabase_project_ref']
    url = 'https://api.supabase.com/v1/projects/' + project + '/database/backups'
    write_private_journal(receipt, {'operation': 'BACKUP_METADATA_GET', 'candidate': candidate,
                                  'attempted': True, 'accepted': False}, exclusive=True)
    try:
        child = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--read-worker'],
            input=json.dumps({'url': url, 'token': token}).encode(), stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, timeout=60, check=False)
        if child.returncode or len(child.stdout) > 1048576: raise ValueError()
        raw = child.stdout
        observed = summary(json.loads(raw), datetime.now(timezone.utc))
        result = {'operation': 'BACKUP_METADATA_GET', 'candidate': candidate,
                  'response_sha256': hashlib.sha256(raw).hexdigest(), 'observations': observed,
                  'accepted': observed['recent_completed_backup_observed']}
        write_private_journal(receipt, result)
        if not result['accepted']: raise SafeFailure('No recent completed backup evidenced; do not hand off QA.')
        return result['accepted']
    except SafeFailure:
        raise
    except Exception:
        raise SafeFailure('Backup metadata read incomplete; raw response/token withheld; no retry.') from None


def read_worker():
    # A separate process enforces a whole-request deadline, including trickling bodies.
    try:
        request_input = json.loads(sys.stdin.buffer.read(32769))
        if (set(request_input) != {'url', 'token'}
                or not __import__('re').fullmatch(r'https://api\.supabase\.com/v1/projects/[a-z]{20}/database/backups', request_input['url'])
                or not isinstance(request_input['token'], str) or len(request_input['token']) > 16000):
            return 1
        request = Request(request_input['url'], headers={'Authorization': 'Bearer ' + request_input['token']}, method='GET')
        with build_opener(NoRedirect).open(request, timeout=15) as response:
            if response.status != 200: return 1
            raw = response.read(1048577)
            if len(raw) > 1048576: return 1
        sys.stdout.buffer.write(raw)
        return 0
    except BaseException:
        return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('helper-sha', 'application-source', 'candidate', 'inputs', 'receipt'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    run(json.loads(Path(args.candidate).read_text()), json.loads(Path(args.inputs).read_text()),
        args.helper_sha, args.application_source, args.receipt)
    print('PASS: recent completed hosted DB backup metadata observed; no restore or Storage-byte proof.')


if __name__ == '__main__':
    if sys.argv[1:] == ['--read-worker']: sys.exit(read_worker())
    try: main()
    except (Exception, KeyboardInterrupt): sys.exit('STOP: backup evidence incomplete; preserve private receipt.')
