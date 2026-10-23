"""One separately approved B collection, private bounded receive and offline validation."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_noble_common import ENV, digest, encoded, file_hash, kill_group, read, run, write
from r3_policy_evidence import B_PURPOSE, DOCUMENT_LIMIT, load
from r3_policy_packet import ROOT, payload, sources
from r3_policy_target import IMDS_FIELDS, validate_target
from r3_policy_validate import require, sha


def approved(packet, approval_data, expected_hash):
    require(digest(approval_data) == expected_hash)
    approval = load(approval_data)
    proposal_bytes = read(packet / 'proposal.json')
    proposal = load(proposal_bytes)
    require(set(proposal) == {'format', 'purpose', 'source', 'target', 'custody',
            'execution_authorized', 'historical_B_rebound'})
    require(type(proposal['format']) is int and proposal['format'] == 1 and proposal['purpose'] == B_PURPOSE
            and proposal['execution_authorized'] is False and proposal['historical_B_rebound'] is False)
    require(approval.get('action') == 'ONE_POLICY_EVIDENCE_COLLECTION'
            and approval.get('proposal_sha256') == digest(proposal_bytes)
            and type(approval.get('attempts')) is int and approval['attempts'] == 1
            and isinstance(approval.get('owner_authorization_reference'), str)
            and 0 < len(approval['owner_authorization_reference']) <= 2000)
    source = proposal['source']
    require(set(source) == {'base_sha', 'published_sha', 'files', 'sha256'}
            and isinstance(source['published_sha'], str)
            and re.fullmatch('[a-f0-9]{40}', source['published_sha']) is not None
            and re.fullmatch('[a-f0-9]{40}', source['base_sha']) is not None)
    require(source['files'] == sources() and source['sha256'] == digest(encoded(source['files'])))
    require(subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], timeout=10).decode().strip() == source['published_sha'])
    require(not subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain', '--untracked-files=all'], timeout=10))
    # Porcelain alone misses assume-unchanged/skip-worktree modifications.
    for name, expected in source['files'].items():
        tracked = subprocess.check_output(['git', '-C', str(ROOT), 'show', source['published_sha'] + ':' + name], timeout=10)
        require(digest(tracked) == expected)
    guest = read(packet / 'guest.py')
    require(guest == payload(proposal))
    index = load(read(packet / 'packet.json'))
    require(index == {'proposal_sha256': digest(proposal_bytes), 'guest_sha256': digest(guest),
                      'state': 'PREPARED_UNAPPROVED_UNEXECUTED'})
    target, custody = proposal['target'], proposal['custody']
    require(isinstance(target, dict) and set(target) == {'imds', 'connection', 'control_plane'})
    require(isinstance(target['imds'], dict) and set(target['imds']) == set(IMDS_FIELDS)
            and all(isinstance(v, str) and 0 < len(v) <= 2048 for v in target['imds'].values()))
    require(target['imds']['location'] == 'swedencentral')
    connection = target['connection']
    require(set(connection) == {'host', 'user'} and re.fullmatch('[a-z_][a-z0-9_-]{0,31}', connection['user']) is not None
            and re.fullmatch('[A-Za-z0-9][A-Za-z0-9.-]{0,252}', connection['host']) is not None)
    require(isinstance(custody, dict) and set(custody) == {'known_hosts', 'known_hosts_sha256',
            'recipient', 'recipient_sha256', 'age', 'age_sha256', 'ssh_public_key', 'ssh_public_key_sha256'})
    for key in ('known_hosts', 'age', 'ssh_public_key'):
        require(isinstance(custody[key], str) and Path(custody[key]).is_absolute()
                and re.fullmatch(r'/[A-Za-z0-9_./-]{1,1023}', custody[key]) is not None)
        sha(custody[key + '_sha256'])
        require(digest(read(custody[key], 32 * 1024 * 1024)) == custody[key + '_sha256'])
    from r3_noble_inputs import recipient
    recipient(custody['recipient'], custody['recipient_sha256'])
    public_key = read(custody['ssh_public_key'], 16384).decode()
    recipient(public_key, custody['ssh_public_key_sha256'])
    import stat
    require(stat.S_ISSOCK(os.stat(os.environ.get('SSH_AUTH_SOCK', '')).st_mode))
    fresh_bytes = read(approval['fresh_control_plane_readback'])
    require(digest(fresh_bytes) == approval['fresh_control_plane_readback_sha256'])
    fresh = load(fresh_bytes)
    require(set(fresh) == {'observed_at', 'target', 'host_key_sha256'})
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(fresh['observed_at'])).total_seconds()
    require(0 <= age <= 900 and fresh['target'] == target
            and fresh['host_key_sha256'] == custody['known_hosts_sha256'])
    # Exact target metadata includes disks/network/image/tenant, retained privately.
    require(isinstance(target['control_plane'], dict) and set(target['control_plane']) ==
            {'tenant', 'subscription', 'vm_id', 'vm_uuid', 'location', 'image', 'disks', 'public_ip', 'private_ip', 'network'})
    control = target['control_plane']
    require(all(control[k] for k in control))
    require(control['vm_id'] == target['imds']['resourceId'] and control['vm_uuid'] == target['imds']['vmId']
            and control['subscription'] == target['imds']['subscriptionId'] and control['location'] == target['imds']['location']
            and connection['host'] in (control['public_ip'], control['private_ip']))
    require(isinstance(control['image'], dict) and set(control['image']) == {'publisher', 'offer', 'sku', 'version', 'exactVersion'}
            and all(control['image'][k] == target['imds'][k] for k in ('publisher', 'offer', 'sku'))
            and control['image']['exactVersion'] == target['imds']['version'])
    return proposal, guest


def ssh_argv(proposal):
    target, custody = proposal['target']['connection'], proposal['custody']
    options = ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null',
               'UserKnownHostsFile=' + custody['known_hosts'], 'PasswordAuthentication=no',
               'KbdInteractiveAuthentication=no', 'ForwardAgent=no', 'ClearAllForwardings=yes',
               'RequestTTY=no', 'ConnectTimeout=10', 'ConnectionAttempts=1', 'ControlMaster=no',
               'ControlPath=none', 'PermitLocalCommand=no', 'LogLevel=ERROR', 'IdentitiesOnly=yes',
               'IdentityFile=' + custody['ssh_public_key'], 'HostbasedAuthentication=no', 'GSSAPIAuthentication=no']
    return ['ssh', '-F', '/dev/null', *[item for option in options for item in ('-o', option)],
            '--', target['user'] + '@' + target['host'], 'sudo -n /usr/bin/python3 -I -B -']


def receive(argv, guest, output):
    disposition = {'returncode': None, 'failure': None, 'remote_exit_proven': False}
    deadline, sent = time.monotonic() + 360, 0
    handles, child = {}, None
    try:
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True, env={**ENV, 'SSH_AUTH_SOCK': os.environ.get('SSH_AUTH_SOCK', '')})
        with selectors.DefaultSelector() as selector:
            for stream, name, cap in ((child.stdout, 'guest.json', DOCUMENT_LIMIT),
                                      (child.stderr, 'stderr.private', 65536)):
                fd = os.open(output / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                handles[stream] = os.fdopen(fd, 'wb')
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, [cap, 0])
            os.set_blocking(child.stdin.fileno(), False)
            selector.register(child.stdin, selectors.EVENT_WRITE)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise TimeoutError('Receiver deadline')
                for key, _ in selector.select(0.1):
                    if key.fileobj is child.stdin:
                        sent += os.write(child.stdin.fileno(), guest[sent:sent + 4096])
                        if sent == len(guest):
                            selector.unregister(child.stdin)
                            child.stdin.close()
                        continue
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    cap, count = key.data
                    handles[key.fileobj].write(data[:max(0, cap - count)])
                    key.data[1] += len(data)
                    require(key.data[1] <= cap)
            child.wait(timeout=max(0.1, deadline - time.monotonic()))
            disposition['returncode'] = child.returncode
    except Exception as exc:
        disposition['failure'] = type(exc).__name__
    finally:
        if child is not None:
            try:
                kill_group(child)
            except Exception as exc:
                disposition['failure'] = type(exc).__name__
        for handle in handles.values():
            handle.close()
        if child is not None:
            for stream in (child.stdin, child.stdout, child.stderr):
                if not stream.closed:
                    stream.close()
    return disposition


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--packet', required=True, type=Path)
    parser.add_argument('--approval', required=True, type=Path)
    parser.add_argument('--approval-sha256', required=True)
    parser.add_argument('--execute', action='store_true', required=True)
    args = parser.parse_args()
    proposal, guest = approved(args.packet, read(args.approval), args.approval_sha256)
    write(args.packet / 'attempt-consumed.json', encoded({'approval_sha256': args.approval_sha256}))
    output = args.packet / 'private-capture'
    output.mkdir(mode=0o700)
    custody = proposal['custody']
    write(output / 'recipient.pub', (custody['recipient'].strip() + '\n').encode())
    # Verify encryption availability before initiating guest execution.
    write(output / 'probe', b'R3 custody probe\n')
    run([custody['age'], '-R', str(output / 'recipient.pub'), '-o', str(output / 'probe.age'),
         str(output / 'probe')], output, 'seal-probe', timeout=10)
    disposition = receive(ssh_argv(proposal), guest, output)
    write(output / 'capture.json', encoded(disposition))
    summary = {'status': 'PARTIAL_REVIEW_REQUIRED', 'qualification': False, 'installation_success': False,
               'policy_generated': False, 'sealed': False}
    try:
        checked = validate_target(read(output / 'guest.json', DOCUMENT_LIMIT), proposal)
        if disposition['failure'] is None and disposition['returncode'] == 0:
            summary['status'] = checked['status']
        write(output / 'validation.json', encoded(checked))
    except Exception as exc:
        write(output / 'validation.json', encoded({'error': type(exc).__name__}))
    # Preserve every captured byte, including malformed/partial/error records,
    # before handing off any completeness result. Raw files remain private.
    import io
    import tarfile
    with tarfile.open(output / 'capture.tar', 'x') as archive:
        for path in sorted(output.iterdir()):
            if path.name == 'capture.tar':
                continue
            data = read(path, DOCUMENT_LIMIT)
            info = tarfile.TarInfo(path.name)
            info.size, info.mode = len(data), 0o600
            archive.addfile(info, io.BytesIO(data))
    try:
        run([custody['age'], '-R', str(output / 'recipient.pub'), '-o', str(args.packet / 'capture.tar.age'),
             str(output / 'capture.tar')], output, 'seal', timeout=60)
        summary.update(sealed=True, ciphertext_sha256=file_hash(args.packet / 'capture.tar.age'))
    except Exception:
        summary.update(status='PARTIAL_REVIEW_REQUIRED', sealed=False)
        (args.packet / 'capture.tar.age').unlink(missing_ok=True)
    finally:
        write(args.packet / 'collection-summary.json', encoded(summary))
    return 0 if summary['sealed'] and summary['status'] == 'COLLECTED_REVIEW_REQUIRED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
