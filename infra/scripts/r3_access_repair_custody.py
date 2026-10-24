"""Offline recovery receipt validation and local age sealing. Never reads a private key."""
import base64
import io
import json
import os
from pathlib import Path
import re
import tarfile

from r3_access_repair import public_line, require, sha256
from r3_access_repair_contract import durable, load, private_path
from r3_access_repair_export import FILES
from r3_noble_common import encoded, read, run
from r3_noble_inputs import recipient


def custody_inputs(custody):
    require(set(custody) == {'known_hosts', 'known_hosts_sha256', 'recipient', 'recipient_sha256',
            'age', 'age_sha256', 'ssh_public_key', 'ssh_public_key_sha256'}, 'CUSTODY_FIELDS')
    recipient(custody['recipient'], custody['recipient_sha256'])
    for key in ('age', 'known_hosts', 'ssh_public_key'):
        require(isinstance(custody[key], str) and re.fullmatch(r'/[A-Za-z0-9_./-]{1,1023}', custody[key]) and
                Path(custody[key]).is_absolute() and str(Path(custody[key]).resolve()) == custody[key], 'TOOL_PATH')
        cap = 32 * 1024 * 1024 if key == 'age' else 16384
        require(sha256(read(custody[key], cap)) == custody[key + '_sha256'], 'CUSTODY_HASH')
    require(os.access(custody['age'], os.X_OK), 'AGE_EXECUTABLE')
    public_line(read(custody['ssh_public_key'], 16384), custody['ssh_public_key_sha256'])


def probe(custody, output):
    custody_inputs(custody)
    durable(output / 'recipient.json', {'recipient_sha256': custody['recipient_sha256']})
    from r3_noble_common import write
    write(output / 'recipient.pub', custody['recipient'].encode())
    write(output / 'seal-probe.txt', b'R3 access recovery custody probe\n')
    run([custody['age'], '-R', str(output / 'recipient.pub'), '-o', str(output / 'seal-probe.age'),
         str(output / 'seal-probe.txt')], output, 'seal-probe', timeout=10)


def seal(custody, output, destination):
    """Preserve plaintext/partial ciphertext on failure. A seal is not completeness."""
    result = {'sealed': False, 'failure': None, 'ciphertext_sha256': None}
    try:
        custody_inputs(custody)
        private_path(output, True)
        require(not destination.exists(), 'CIPHERTEXT_EXISTS')
        archive = output / 'capture.tar'
        names = sorted(p for p in output.iterdir() if p.is_file())
        require(len(names) <= 48, 'CAPTURE_COUNT')
        fd = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            with tarfile.open(fileobj=stream, mode='w') as tar:
                total = 0
                for path in names:
                    require(not path.is_symlink(), 'CAPTURE_LINK')
                    data = read(path, 24 * 1024 * 1024)
                    total += len(data)
                    require(total <= 32 * 1024 * 1024, 'CAPTURE_TOTAL')
                    item = tarfile.TarInfo(path.name)
                    item.size, item.mode = len(data), 0o600
                    tar.addfile(item, io.BytesIO(data))
            stream.flush()
            os.fsync(stream.fileno())
        # The recipient can be recreated after a probe refusal only from the
        # already bound public bytes; never substitute another recipient.
        pub = output / 'recipient.pub'
        require(read(pub, 16384) == custody['recipient'].encode(), 'RECIPIENT_CHANGED')
        run([custody['age'], '-R', str(pub), '-o', str(destination), str(archive)], output, 'seal', timeout=60)
        result.update(sealed=True, ciphertext_sha256=sha256(read(destination, 34 * 1024 * 1024)))
    except Exception as exc:
        result['failure'] = type(exc).__name__
    finally:
        for path in output.iterdir():
            if path.is_file() and not path.is_symlink():
                path.chmod(0o600)
        if destination.is_file() and not destination.is_symlink():
            destination.chmod(0o600)
    return result


def validate_summary(summary, proposal):
    require(set(summary) == {'status', 'phase', 'failure', 'cleanup_errors', 'access_verified',
            'qualification', 'installation_success', 'evidence_path', 'pre_close_result_sha256',
            'finalization', 'identity_stable', 'append'}, 'SUMMARY_SHAPE')
    require(summary['status'] == 'KEY_APPENDED_REVIEW_REQUIRED' and summary['phase'] == 'completed' and
            summary['failure'] is None and summary['cleanup_errors'] == [] and
            summary['identity_stable'] is True and summary['access_verified'] is False and
            summary['qualification'] is False and summary['installation_success'] is False and
            summary['evidence_path'] == '/var/lib/tonyai-r3-access-recovery-' + proposal['packet_id'] and
            summary['finalization'] == {'status': 'KEY_APPENDED_REVIEW_REQUIRED', 'cleanup_errors': []}, 'SUMMARY_STATE')
    require(isinstance(summary['pre_close_result_sha256'], str) and
            re.fullmatch('[a-f0-9]{64}', summary['pre_close_result_sha256']), 'RESULT_HASH')
    value = summary['append']
    require(set(value) == {'before_sha256', 'before_bytes', 'append_sha256', 'append_bytes', 'public_key_sha256',
            'uid', 'gid', 'mode', 'device', 'inode', 'after_sha256', 'after_bytes', 'status',
            'access_verified', 'qualification', 'installation_success'}, 'APPEND_SHAPE')
    for key in ('before_sha256', 'append_sha256', 'public_key_sha256', 'after_sha256'):
        require(isinstance(value[key], str) and re.fullmatch('[a-f0-9]{64}', value[key]), 'APPEND_HASH')
    for key in ('before_bytes', 'append_bytes', 'uid', 'gid', 'mode', 'device', 'inode', 'after_bytes'):
        require(type(value[key]) is int and value[key] >= 0, 'APPEND_INTEGER')
    line, _ = public_line(proposal['public_key'].encode(), proposal['public_key_sha256'])
    suffix = line if value['append_bytes'] == len(line) else b'\n' + line
    require(value['append_bytes'] == len(suffix) and value['append_sha256'] == sha256(suffix) and
            (value['before_bytes'] > 0 or suffix == line) and value['before_bytes'] <= 256 * 1024 and
            value['append_bytes'] <= 4096 and value['after_bytes'] == value['before_bytes'] + value['append_bytes'] and
            0 < value['uid'] < 2**32 and 0 < value['gid'] < 2**32 and value['mode'] in (0o600, 0o644) and
            value['inode'] > 0 and value['public_key_sha256'] == proposal['public_key_sha256'] and
            value['status'] == 'KEY_APPENDED_REVIEW_REQUIRED' and value['access_verified'] is False and
            value['qualification'] is False and value['installation_success'] is False, 'APPEND_SCOPE')


def validate_export(raw, proposal, summary):
    validate_summary(summary, proposal)
    require(len(raw) <= 512 * 1024, 'EXPORT_SIZE')
    envelope = load(raw)
    require(envelope['purpose'] == 'R3_REPAIR_PRIVATE_EXPORT' and envelope['format'] == 1 and
            envelope['packet_id'] == proposal['packet_id'] and envelope['status'] == 'EXPORTED_REVIEW_REQUIRED' and
            envelope['failure'] is None and envelope['cleanup_errors'] == [] and
            envelope['identity_before'] == envelope['identity_after'] and
            envelope['identity_before']['imds'] == proposal['target_imds'], 'EXPORT_IDENTITY')
    require(set(envelope['files']) == set(FILES), 'EXPORT_FILES')
    decoded = {}
    for name, cap in FILES.items():
        value = envelope['files'][name]
        require(set(value) == {'base64', 'sha256', 'bytes'} and type(value['bytes']) is int, 'EXPORT_BLOB')
        data = base64.b64decode(value['base64'], validate=True)
        require(len(data) <= cap and len(data) == value['bytes'] and sha256(data) == value['sha256'], 'EXPORT_HASH')
        decoded[name] = data
    invocation, prepared, retained = (load(decoded[n]) for n in ('invocation.json', 'prepared.json', 'pre-close-result.json'))
    require(invocation['proposal_sha256'] == sha256(encoded(proposal)) and
            invocation['identity_before'] == retained['identity_before'] == envelope['identity_before'], 'INVOCATION_BINDING')
    require(sha256(decoded['pre-close-result.json']) == summary['pre_close_result_sha256'], 'RETAINED_RESULT_HASH')
    overlay = summary['finalization']
    require(set(overlay) == {'status', 'cleanup_errors'} and summary['status'] == overlay['status'] and
            summary['cleanup_errors'] == overlay['cleanup_errors'], 'FINALIZATION_OVERLAY')
    require(retained['status'] == overlay['status'] == 'KEY_APPENDED_REVIEW_REQUIRED' and
            retained['cleanup_errors'] == overlay['cleanup_errors'] == [] and retained['failure'] is None and
            retained['identity_after'] == retained['identity_before'], 'PARTIAL_RECEIPT')
    for key in ('phase', 'failure', 'access_verified', 'qualification', 'installation_success', 'evidence_path', 'append'):
        require(summary[key] == retained[key], 'SUMMARY_CORRESPONDENCE')
    require(summary['identity_stable'] is True and retained['access_verified'] is False and
            retained['qualification'] is False and retained['installation_success'] is False and
            retained['evidence_path'] == '/var/lib/tonyai-r3-access-recovery-' + proposal['packet_id'], 'RECEIPT_SCOPE')
    before = decoded['authorized_keys.before']
    line, _ = public_line(proposal['public_key'].encode(), proposal['public_key_sha256'])
    suffix = (b'\n' if before and not before.endswith(b'\n') else b'') + line
    expected = {'before_sha256': sha256(before), 'before_bytes': len(before),
                'append_sha256': sha256(suffix), 'append_bytes': len(suffix),
                'public_key_sha256': proposal['public_key_sha256']}
    require(all(prepared[k] == v for k, v in expected.items()) and
            all(retained['append'][k] == v for k, v in prepared.items()), 'PREFIX_BINDING')
    require(retained['append']['after_sha256'] == sha256(before + suffix) and
            retained['append']['after_bytes'] == len(before + suffix), 'AFTER_BINDING')
    return {'status': 'REPAIR_EVIDENCE_VERIFIED_REVIEW_REQUIRED', 'qualification': False,
            'installation_success': False, 'policy_generated': False}
