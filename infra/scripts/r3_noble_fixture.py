"""GitHub-hosted-only controller for a disposable native Noble diagnostic."""
import io
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_noble_common import ENV, FILE_LIMIT, STREAM_LIMIT, digest, encoded, file_hash, kill_group, read, run, write
from r3_noble_guest import GUEST_FILES, GUEST_REQUIRED_FILES
from r3_noble_identity import SNAPSHOT, SNAPSHOT_LIMIT
from r3_noble_inputs import ROOT, WORKFLOW, recipient, seed, stage, stage_age


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], timeout=30)


def source_binding(env):
    sha = env.get('R3_SOURCE_SHA', '')
    ref = env.get('GITHUB_REF', '')
    if (not re.fullmatch('[0-9a-f]{40}', sha) or env.get('GITHUB_SHA') != sha
            or env.get('GITHUB_WORKFLOW_SHA') != sha or env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or env.get('GITHUB_RUN_ATTEMPT') != '1' or env.get('RUNNER_ENVIRONMENT') != 'github-hosted'
            or env.get('RUNNER_OS') != 'Linux' or env.get('RUNNER_ARCH') != 'X64'
            or not ref.startswith('refs/heads/') or not re.fullmatch('[0-9]+', env.get('GITHUB_RUN_ID', ''))
            or env.get('GITHUB_WORKFLOW_REF') != env.get('GITHUB_REPOSITORY', '') + '/' + WORKFLOW + '@' + ref):
        raise ValueError('Runner, source or one-attempt dispatch binding differs')
    if git('rev-parse', 'HEAD').decode().strip() != sha or git('status', '--porcelain=v1', '--untracked-files=all'):
        raise ValueError('HEAD/clean source differs')
    files = {}
    import hashlib
    for row in git('ls-tree', '-rz', '--full-tree', sha).split(b'\0'):
        if not row:
            continue
        metadata, raw = row.split(b'\t', 1)
        mode, kind, blob = metadata.split()
        name = raw.decode()
        path = ROOT / name
        if mode not in (b'100644', b'100755') or kind != b'blob' or path.is_symlink() or not path.is_file():
            raise ValueError('Unexpected tracked source type')
        # Detect assume-unchanged/skip-worktree edits too, not just porcelain.
        data = path.read_bytes()
        actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if actual != blob.decode():
            raise ValueError('Tracked source bytes differ')
        files[name] = digest(data)
    return {'sha': sha, 'ref': ref, 'run_id': env['GITHUB_RUN_ID'], 'attempt': 1,
            'repository': env['GITHUB_REPOSITORY'], 'job': 'native-noble',
            'workflow_sha256': files[WORKFLOW], 'files': files}


def validate_frame(data, expected):
    if len(data) < 82 or not data.startswith(b'R3NOBLE1\n'):
        raise ValueError('Incomplete native evidence frame')
    size = int.from_bytes(data[9:17], 'big')
    if size > STREAM_LIMIT or len(data) != 17 + size + 65 or data[-1:] != b'\n':
        raise ValueError('Native evidence frame length differs')
    body = data[17:17 + size]
    if data[-65:-1] != digest(body).encode():
        raise ValueError('Native evidence frame hash differs')
    entries, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(body), mode='r:') as tar:
        for member in tar:
            if (member.name not in GUEST_FILES or member.name in entries or not member.isfile()
                    or member.size > (24 * 1024 * 1024 if member.name == 'policy-evidence.json' else SNAPSHOT_LIMIT if member.name == SNAPSHOT else FILE_LIMIT)
                    or member.size < 0 or member.pax_headers):
                raise ValueError('Unexpected native evidence archive member')
            total += member.size
            if total > STREAM_LIMIT:
                raise ValueError('Native evidence archive limit')
            entries[member.name] = tar.extractfile(member).read()
    from r3_install_policy import unique
    result = json.loads(entries['result.json'], object_pairs_hook=unique)
    manifest = json.loads(entries['manifest.json'], object_pairs_hook=unique)
    if manifest != expected or result.get('source') != expected['source']:
        raise ValueError('Native source/input correspondence differs')
    if result.get('files') != {k: digest(v) for k, v in entries.items() if k != 'result.json'}:
        raise ValueError('Native evidence manifest differs')
    if expected.get('purpose') == 'FIXTURE_POLICY_COLLECTION_ONLY':
        return validate_collection(entries, result, expected)
    if 'policy-evidence.json' in entries:
        raise ValueError('Collection evidence in installation mode')
    maintenance = expected.get('purpose') == 'FIXTURE_MAINTENANCE_ONLY'
    from r3_noble_guest import POLICY_FILES
    if not maintenance and set(entries) & POLICY_FILES:
        raise ValueError('Maintenance evidence in original diagnostic')
    if (result.get('purpose') != expected.get('purpose')
            or expected.get('purpose') not in ('FIXTURE_DIAGNOSTIC_ONLY', 'FIXTURE_MAINTENANCE_ONLY')
            or result.get('qa_ready') is not False
            or result.get('target_qualified') is not False
            or result.get('status') not in ('REFUSED', 'DIAGNOSTIC_PASS_REVIEW_REQUIRED')):
        raise ValueError('Unexpected native result')
    if SNAPSHOT in entries:
        context = json.loads(entries[SNAPSHOT])
        if (maintenance or result['status'] != 'REFUSED' or result.get('phase') != 'native-baseline'
                or result.get('install_attempted') is not False
                or result.get('failure_type') != 'ValueError'
                or result.get('failure') != 'Foreign fixture package writer'
                or context.get('format') != 1 or context.get('purpose') != 'REFUSAL_CONTEXT_ONLY'
                or context.get('identity_proves_inactivity') is not False):
            raise ValueError('Identity context is only valid for baseline process refusal')
    if result['status'] == 'DIAGNOSTIC_PASS_REVIEW_REQUIRED':
        from r3_noble_guest import COMMANDS, POLICY_COMMANDS, POLICY_FILES
        from r3_package_state import inventory, inventory_diff, held_inventory, transaction
        from r3_toolchain import validate_dependency_plan
        lock = json.loads(read(ROOT / 'infra/selfhost/r3-toolchain.lock.json'))
        required = GUEST_REQUIRED_FILES | (POLICY_FILES if maintenance else set())
        if (set(entries) != required or not result.get('install_attempted') or result.get('not_reached')
                or result.get('phase') != 'complete'):
            raise ValueError('Incomplete native pass')
        for name in COMMANDS + (POLICY_COMMANDS if maintenance else ()):
            exit_value = json.loads(entries[name + '.exit.json'])
            if (exit_value['returncode'] != 0 or exit_value.get('failure_type') is not None
                    or exit_value['stdout_sha256'] != digest(entries[name + '.stdout'])
                    or exit_value['stderr_sha256'] != digest(entries[name + '.stderr'])):
                raise ValueError('Native command did not pass')
        before, pre, after, final = [inventory(entries[n + '.stdout'].decode()) for n in ('before', 'pre-execute', 'after', 'final')]
        if before != pre or any(entries[n + '.stdout'] for n in ('audit-initial', 'audit-post', 'audit-final')):
            raise ValueError('Native boundary audit/inventory differs')
        validate_dependency_plan(lock, entries['simulate.stdout'].decode())
        if maintenance:
            import r3_install_policy as policy_module
            import r3_maintenance
            policy = policy_module.load(entries['installation-policy.json'], expected['policy_sha256'])
            facts_before = json.loads(entries['policy-facts-before.json'])
            policy_module.preflight(policy, read(ROOT / 'infra/selfhost/r3-toolchain.lock.json'), before,
                entries['config.stdout'], facts_before, entries['unit-config.stdout'], json.loads(entries['cache-before.json']))
            if (json.loads(entries['policy-facts-after.json']) != facts_before
                    or any(inventory(entries[n + '.stdout'].decode()) != before
                           for n in ('isolation-inventory', 'pre-stop-inventory'))):
                raise ValueError('Maintenance policy/inventory drift')
            r3_maintenance.validate_evidence(*(json.loads(entries[name + '.json']) for name in
                ('maintenance-intent', 'maintenance-final', 'maintenance-complete')))
            stop = json.loads(entries['maintenance-pre-stop.json'])
            r3_maintenance.eligible(stop['observation'], inspect=lambda _item: stop['helper'])
            from r3_package_state import INVENTORY_ARGV
            commands = {'unit-config': ['systemctl', 'cat', *r3_maintenance.UNITS],
                        'pre-stop-inventory': INVENTORY_ARGV, 'isolation-inventory': INVENTORY_ARGV,
                        'maintenance-mask': ['systemctl', 'mask', *r3_maintenance.UNITS],
                        'maintenance-stop-timers': ['systemctl', 'stop', *r3_maintenance.TIMERS],
                        'maintenance-stop-services': ['systemctl', 'stop', *r3_maintenance.SERVICES]}
            if any(json.loads(entries[name + '.command.json']).get('argv') != argv for name, argv in commands.items()):
                raise ValueError('Maintenance command argv differs')
            # Independently read every transaction sample using production's
            # isolation validator; a forged guest check cannot waive the guard.
            from r3_apt_observer import validate as validate_isolation
            baseline = json.loads(entries['maintenance-final.json'])
            observations = json.loads(entries['observations.json'])
            if not observations:
                raise ValueError('Missing isolated observations')
            for item in observations:
                # Do not inspect the controller's /proc for a guest child.
                value = item['value']
                validate_isolation({**value, 'processes': []}, baseline)
                child = item['child']
                if value.get('locks_probed') is not (child is None):
                    raise ValueError('Missing/mismatched guest boundary lock evidence')
                if any(child is None or proc['pgrp'] != child['pid'] for proc in value['processes']):
                    raise ValueError('Foreign process in isolated guest evidence')
            actions = policy_module.trigger_transaction(entries['transaction.log'].decode(), lock, policy)
        else:
            actions = transaction(entries['transaction.log'].decode(), lock)
        checks = {'inventory': inventory_diff(before, after, lock),
                  'transaction': actions,
                  'final_inventory': inventory_diff(before, final, lock, held=True)}
        if maintenance:
            checks['cache_effects'] = policy_module.cache_effects(
                json.loads(entries['cache-before.json']), json.loads(entries['cache-after.json']), policy)
        held_inventory(after, final, lock)
        if checks != result.get('checks'):
            raise ValueError('Native strict check readback differs')
    return result


def validate_collection(entries, result, expected):
    from r3_noble_guest import COLLECTION_FILES, COMMANDS, POLICY_COMMANDS, collection_binding
    from r3_policy_validate import validate
    keys = {'format', 'purpose', 'qa_ready', 'target_qualified', 'install_attempted', 'status',
            'phase', 'source', 'checks', 'not_reached', 'files'}
    failed = 'failure_type' in result
    if (set(result) != keys | ({'failure_type'} if failed else set())
            or type(result.get('format')) is not int or result['format'] != 1
            or set(entries) != COLLECTION_FILES or result.get('purpose') != expected['purpose']
            or result.get('qa_ready') is not False or result.get('target_qualified') is not False
            or result.get('install_attempted') is not False or result.get('phase') != 'collection'
            or result.get('not_reached') != list(COMMANDS + POLICY_COMMANDS)):
        raise ValueError('Invalid collection-only frame')
    checked = validate(entries['policy-evidence.json'], collection_binding(expected))
    expected_status = 'PARTIAL_REVIEW_REQUIRED' if failed else checked['status']
    if (result.get('checks') != checked or result.get('status') != expected_status
            or failed and result['failure_type'] not in ('OSError', 'ValueError', 'TimeoutError', 'RuntimeError', 'UnicodeError')):
        raise ValueError('Collection readback differs')
    return result


def qemu_argv(work, lock):
    return ['qemu-system-x86_64', '-machine', 'q35,accel=tcg', '-cpu', 'max', '-smp', '2', '-m', '4096',
            '-uuid', lock['fixture_uuid'], '-display', 'none', '-monitor', 'none', '-no-reboot', '-nic', 'none',
            '-drive', 'file=' + str(work / 'overlay.qcow2') + ',format=qcow2,if=virtio',
            '-drive', 'file=' + str(work / 'input.iso') + ',format=raw,media=cdrom,readonly=on',
            '-drive', 'file=' + str(work / 'seed.iso') + ',format=raw,media=cdrom,readonly=on',
            '-chardev', 'socket,id=console,path=' + str(work / 'console.sock'), '-serial', 'chardev:console',
            '-device', 'virtio-serial-pci',
            '-chardev', 'socket,id=evidence,path=' + str(work / 'evidence.sock'),
            '-device', 'virtserialport,chardev=evidence,name=org.tonyai.r3']


def vm(work, raw, lock, timeout=1200):
    """No host mounts or NIC. Bound each stream; tear down VM on every outcome."""
    argv, child = qemu_argv(work, lock), None
    write(raw / 'qemu.argv.json', encoded(argv))
    started, frame, listeners, outputs = time.monotonic(), bytearray(), [], []
    with selectors.DefaultSelector() as selector:
        try:
            for name, limit in (('console', FILE_LIMIT), ('evidence', STREAM_LIMIT + 82)):
                listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                listener.bind(str(work / (name + '.sock')))
                listener.listen(1)
                listener.setblocking(False)
                listeners.append(listener)
                selector.register(listener, selectors.EVENT_READ, ('listen', name, limit))
            child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     env=ENV, start_new_session=True)
            for name, pipe in (('qemu-stdout', child.stdout), ('qemu-stderr', child.stderr)):
                os.set_blocking(pipe.fileno(), False)
                out = (raw / (name + '.log')).open('xb')
                outputs.append(out)
                selector.register(pipe, selectors.EVENT_READ, ['data', name, 1_000_000, out, 0])
            while True:
                if time.monotonic() - started >= timeout:
                    raise TimeoutError('Native VM deadline')
                if child.poll() is not None:
                    raise ValueError('Native VM exited before complete evidence')
                for key, _ in selector.select(0.1):
                    kind, name, limit = key.data[:3]
                    if kind == 'listen':
                        stream, _ = key.fileobj.accept()
                        selector.unregister(key.fileobj)
                        stream.setblocking(False)
                        out = (raw / (name + '.bin')).open('xb')
                        outputs.append(out)
                        selector.register(stream, selectors.EVENT_READ, ['data', name, limit, out, 0])
                        continue
                    chunk = key.fileobj.recv(65536) if isinstance(key.fileobj, socket.socket) else os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    if key.data[4] + len(chunk) > limit:
                        raise ValueError('Native VM stream limit')
                    key.data[3].write(chunk)
                    key.data[4] += len(chunk)
                    if name == 'evidence':
                        frame.extend(chunk)
                        if len(frame) >= 17:
                            size = int.from_bytes(frame[9:17], 'big')
                            if size > STREAM_LIMIT or frame[:9] != b'R3NOBLE1\n':
                                raise ValueError('Invalid native evidence header')
                            if len(frame) >= 17 + size + 65:
                                return bytes(frame)
        finally:
            if child is not None:
                kill_group(child)
            for key in list(selector.get_map().values()):
                key.fileobj.close()
            for listener in listeners:
                listener.close()
            for out in outputs:
                out.close()
            write(raw / 'qemu.exit.json', encoded({'elapsed_seconds': time.monotonic() - started,
                                                 'returncode': None if child is None else child.returncode}))


def seal(work, raw, publish, binding):
    files = sorted(raw.iterdir())
    if any(p.is_symlink() or not p.is_file() for p in files):
        raise ValueError('Unexpected raw evidence type')
    manifest = {p.name: file_hash(p) for p in files}
    write(raw / 'retention-manifest.json', encoded({'binding': binding, 'files': manifest}))
    archive = work / 'private-evidence.tar'
    total = 0
    with tarfile.open(archive, 'x') as tar:
        for path in sorted(raw.iterdir()):
            total += path.stat().st_size
            if total > 128 * 1024**2:
                raise ValueError('Private evidence total limit')
            tar.add(path, arcname=path.name, recursive=False)
    # Encryption diagnostics themselves remain local; never print raw errors.
    ciphertext = publish / 'fixture-evidence.tar.age'
    run([str(work / 'age'), '-R', str(work / 'recipient.pub'), '-o', str(ciphertext), str(archive)],
        work, 'encryption', timeout=120)
    return {'ciphertext_sha256': file_hash(ciphertext), 'ciphertext_bytes': ciphertext.stat().st_size,
            'plaintext_sha256': file_hash(archive), 'retention_manifest_sha256': file_hash(raw / 'retention-manifest.json')}


def main():
    os.umask(0o077)
    # The only inputs taken from the runner environment are public dispatch/run bindings.
    names = ('R3_PURPOSE', 'R3_SOURCE_SHA', 'R3_RECIPIENT', 'R3_RECIPIENT_SHA256', 'R3_INSTALL_POLICY', 'R3_INSTALL_POLICY_SHA256', 'GITHUB_SHA', 'GITHUB_REF',
             'GITHUB_WORKFLOW_SHA', 'GITHUB_WORKFLOW_REF', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID',
             'GITHUB_RUN_ATTEMPT', 'GITHUB_REPOSITORY', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH',
             'RUNNER_TEMP', 'ImageOS', 'ImageVersion')
    env = {k: os.environ.get(k, '') for k in names}
    os.environ.clear()
    os.environ.update(ENV)
    source = source_binding(env)
    key = recipient(env['R3_RECIPIENT'], env['R3_RECIPIENT_SHA256'])
    policy_bytes = None
    if env['R3_INSTALL_POLICY'] or env['R3_INSTALL_POLICY_SHA256']:
        from r3_install_policy import load as load_policy
        policy_bytes = env['R3_INSTALL_POLICY'].encode()
        load_policy(policy_bytes, env['R3_INSTALL_POLICY_SHA256'])
    purpose = env['R3_PURPOSE'] or 'diagnostic'
    if purpose not in ('diagnostic', 'policy-collection') or (purpose == 'policy-collection' and policy_bytes is not None):
        raise ValueError('Invalid collection purpose/policy combination')
    collection_only = purpose == 'policy-collection'
    root = Path(env['RUNNER_TEMP'])
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        raise ValueError('Runner temporary directory required')
    # A failed/cancelled attempt is consumed. Neither reruns nor automatic retries allowed.
    write(root / ('r3-noble-consumed-' + source['run_id']), encoded(source))
    work = Path(tempfile.mkdtemp(prefix='r3n-', dir='/tmp'))  # Short private Unix socket paths.
    raw, publish = work / 'raw', root / 'r3-noble-publish'
    raw.mkdir(mode=0o700)
    publish.mkdir(mode=0o700)
    lock = json.loads(read(ROOT / 'infra/selfhost/r3-noble-fixture.lock.json'))
    binding = {'format': 1, 'purpose': purpose, 'source_sha': source['sha'], 'source_ref': source['ref'],
               'run_id': source['run_id'], 'attempt': 1, 'job': source['job'],
               'workflow_sha256': source['workflow_sha256'], 'recipient_sha256': env['R3_RECIPIENT_SHA256'],
               'fixture_lock_sha256': file_hash(ROOT / 'infra/selfhost/r3-noble-fixture.lock.json')}
    if policy_bytes is not None:
        binding['installation_policy_sha256'] = digest(policy_bytes)
    write(raw / 'source.json', encoded(source))
    write(raw / 'runner.json', encoded({k: env[k] for k in ('RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion')}))
    summary = {'format': 1, 'status': 'REFUSED', 'phase': 'encryption-tool', 'sealed': False,
               'qa_ready': False, 'target_qualified': False, 'review_required': True, 'binding': binding}
    def interrupted(_sig, _frame):
        raise TimeoutError('Runner interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        stage_age(work, lock, key, raw, time.monotonic() + 120)
        summary['phase'] = 'runner-tools'
        run(['dpkg-query', '-W'], raw, 'runner-before')
        run(['sudo', '-n', 'apt-get', 'update'], raw, 'runner-update', timeout=180, privileged=True)
        run(['sudo', '-n', 'apt-get', '--yes', '--no-install-recommends', 'install',
             *[name + '=' + version for name, version in lock['runner_packages'].items()]], raw, 'runner-install', timeout=300, privileged=True)
        versions = run(['dpkg-query', '-W', '-f=${Package}\t${Version}\n', *lock['runner_packages']], raw, 'runner-tools').decode()
        if dict(line.split('\t') for line in versions.splitlines()) != lock['runner_packages']:
            raise ValueError('Runner tool versions differ')
        run(['dpkg-query', '-W'], raw, 'runner-after')
        summary['phase'] = 'public-inputs'
        inputs = stage(work, raw, lock, source, time.monotonic() + 600, policy_bytes, collection_only)
        expected = json.loads(read(inputs / 'manifest.json'))
        seed(work / 'seed', source)
        run(['genisoimage', '-quiet', '-r', '-J', '-V', 'R3INPUT', '-o', str(work / 'input.iso'), str(inputs)], raw, 'input-iso')
        run(['genisoimage', '-quiet', '-r', '-J', '-V', 'cidata', '-o', str(work / 'seed.iso'), str(work / 'seed')], raw, 'seed-iso')
        info = json.loads(run(['qemu-img', 'info', '--output=json', str(work / lock['image'])], raw, 'image-info'))
        if info.get('format') != 'qcow2' or 'backing-filename' in info or info.get('virtual-size', 0) > 16 * 1024**3:
            raise ValueError('Unexpected image format/backing/size')
        run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', str(work / lock['image']),
             str(work / 'overlay.qcow2'), '16G'], raw, 'overlay')
        boot_files = [work / lock['image'], work / 'input.iso', work / 'seed.iso',
                      work / 'seed/user-data', work / 'seed/meta-data']
        boot_hashes = {str(p.relative_to(work)): file_hash(p) for p in boot_files}
        if boot_hashes[lock['image']] != lock['image_sha256']:
            raise ValueError('Backing image changed')
        write(raw / 'boot-inputs.json', encoded(boot_hashes))
        for name in ('user-data', 'meta-data'):
            write(raw / ('seed-' + name), read(work / 'seed' / name))
        if source_binding(env) != source:
            raise ValueError('Source changed before native execution')
        if any(file_hash(p) != boot_hashes[str(p.relative_to(work))] for p in boot_files):
            raise ValueError('Boot input reread differs')
        summary['phase'] = 'native-fixture'
        frame = vm(work, raw, lock)
        native = validate_frame(frame, expected)
        write(raw / 'native-result.json', encoded(native))
        summary['native_status'] = native['status']
        summary['status'] = native['status']
        summary['phase'] = 'complete'
    except BaseException as exc:
        write(raw / 'controller-failure.json', encoded({'type': type(exc).__name__, 'message': str(exc)[:1000]}))
    finally:
        try:
            if source_binding(env) != source:
                raise ValueError('Source changed after execution')
            summary['source_recheck'] = True
        except Exception:
            summary.update(status='REFUSED', source_recheck=False)
        write(raw / 'controller-result.json', encoded(summary))
        try:
            summary['retention'] = seal(work, raw, publish, binding)
            summary['sealed'] = True
        except Exception:
            summary.update(status='REFUSED', sealed=False)
            # A partial ciphertext is not an approved retention artifact.
            (publish / 'fixture-evidence.tar.age').unlink(missing_ok=True)
        write(publish / 'binding.json', encoded(binding))
        write(publish / 'summary.json', encoded(summary))
    print('Native fixture finished. Inspect the encrypted evidence and public binding; no target qualification claimed.')
    return 0 if summary['status'] in ('DIAGNOSTIC_PASS_REVIEW_REQUIRED', 'COLLECTED_REVIEW_REQUIRED') and summary['sealed'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('Native fixture preflight refused; no automatic retry.')
        raise SystemExit(1)
