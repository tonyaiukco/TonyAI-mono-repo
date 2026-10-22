"""One disposable Noble diagnostic attempt. Never emits a target install receipt."""
import io
import json
import os
from pathlib import Path
import signal
import sys
import tarfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_noble_common import STREAM_LIMIT, digest, encoded, file_hash, read, run, write
from r3_apt_observer import UNITS, observe, process_identity
from r3_package_state import INVENTORY_ARGV, held_inventory, inventory, inventory_diff, require_absent, transaction
from r3_toolchain import install_argv, validate_dependency_plan, validate_lock

INPUT = Path('/mnt/r3-input')
OUTPUT = Path('/var/tmp/tonyai-r3-fixture')
PORT = '/dev/virtio-ports/org.tonyai.r3'
COMMANDS = ('os', 'arch', 'kernel', 'config', 'before', 'pre-execute', 'after', 'final',
            'audit-initial', 'audit-post', 'audit-final', 'simulate', 'install', 'holds',
            'metadata-0', 'metadata-1', 'metadata-2', 'metadata-3', 'metadata-4',
            'payload-0', 'payload-1', 'payload-2', 'payload-3', 'payload-4')
GUEST_FILES = {'manifest.json', 'result.json', 'transaction.log', 'observations.json', 'native-files.json', 'native-state.json'} | {
    name + suffix for name in COMMANDS for suffix in ('.stdout', '.stderr', '.command.json', '.exit.json')}


def fixture_observation(value, baseline=None, child=None):
    """Diagnostic policy: observe original units, refuse writers/jobs or changes.

    Does not stand in for production's persistently masked-unit prerequisite.
    No unit configuration is altered to obtain this observation.
    """
    if set(value['units']) != set(UNITS):
        raise ValueError('Incomplete unit observation')
    if any(f['Id'] != name or f['Job'] != '' for name, f in value['units'].items()):
        raise ValueError('Pending package unit job')
    if baseline is not None and value['units'] != baseline['units']:
        raise ValueError('Fixture package unit changed')
    for item in value['processes']:
        if child is None or item['pgrp'] != child['pid']:
            raise ValueError('Foreign fixture package writer')
    if child is not None:
        try:
            current = process_identity(Path('/proc') / str(child['pid']))
        except FileNotFoundError:
            if value['processes']:
                raise ValueError('Lost package child identity')
        else:
            if current != child or current['pgrp'] != child['pid']:
                raise ValueError('Changed package child identity')


def verify_input():
    if os.geteuid() != 0 or Path('/sys/class/dmi/id/product_uuid').read_text().strip().lower() != 'd7fa1822-80db-4cba-9ef1-6e63549fe928':
        raise ValueError('Not the disposable fixture')
    mounts = Path('/proc/mounts').read_text().splitlines()
    if not any(p[1] == str(INPUT) and p[2] == 'iso9660' and 'ro' in p[3].split(',')
               for p in (line.split() for line in mounts)):
        raise ValueError('Readonly input ISO required')
    manifest = json.loads(read(INPUT / 'manifest.json'))
    actual = {str(p.relative_to(INPUT)): file_hash(p) for p in INPUT.rglob('*') if p.is_file() and p.name != 'manifest.json'}
    if actual != manifest['files'] or any(p.is_symlink() for p in INPUT.rglob('*')):
        raise ValueError('Fixture input changed')
    if manifest['purpose'] != 'FIXTURE_DIAGNOSTIC_ONLY':
        raise ValueError('Wrong input purpose')
    write(OUTPUT / 'manifest.json', encoded(manifest))
    return manifest


def native_files():
    # These public-image configuration files never come from Azure or customer data.
    roots = ('/etc/apt/apt.conf', '/etc/apt/apt.conf.d', '/etc/dpkg/dpkg.cfg', '/etc/dpkg/dpkg.cfg.d',
             '/var/lib/dpkg/triggers', '/var/lib/dpkg/info/man-db.triggers',
             '/var/lib/dpkg/info/man-db.postinst', '/var/lib/dpkg/diversions', '/var/lib/dpkg/statoverride')
    values, total = {}, 0
    for root in roots:
        path = Path(root)
        paths = sorted(path.iterdir()) if path.is_dir() else [path]
        for item in paths:
            if not item.exists():
                values[str(item)] = {'absent': True}
                continue
            if item.is_symlink() or not item.is_file():
                raise ValueError('Unexpected fixture configuration entry')
            data = read(item, 1_000_000)
            total += len(data)
            if total > 4_000_000:
                raise ValueError('Fixture configuration limit')
            values[str(item)] = {'sha256': digest(data), 'content': data.decode()}
    write(OUTPUT / 'native-files.json', encoded(values))


def archive(directory):
    entries = sorted(directory.iterdir())
    if any(p.name not in GUEST_FILES or p.is_symlink() or not p.is_file() for p in entries):
        raise ValueError('Unexpected guest evidence')
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as tar:
        for path in entries:
            data = read(path)
            info = tarfile.TarInfo(path.name)
            info.size, info.mode = len(data), 0o600
            tar.addfile(info, io.BytesIO(data))
            if stream.tell() > STREAM_LIMIT - 10240:
                raise ValueError('Guest evidence limit')
    data = stream.getvalue()
    return b'R3NOBLE1\n' + len(data).to_bytes(8, 'big') + data + digest(data).encode() + b'\n'


def native_identity():
    init = Path('/proc/1/exe').resolve()
    if init != Path('/usr/lib/systemd/systemd'):
        raise ValueError('Native systemd PID1 required')
    write(OUTPUT / 'native-state.json', encoded({
        'pid1_executable': str(init), 'pid1_comm': Path('/proc/1/comm').read_text(),
        'executable_hashes': {name: file_hash(name) for name in
                              ('/usr/bin/apt-get', '/usr/bin/dpkg', '/usr/lib/systemd/systemd')},
    }))


def write_all(port, data):
    remaining = memoryview(data)
    while remaining:
        written = port.write(remaining[:65536])
        if written is None or written <= 0:
            raise ValueError('Native evidence channel made no progress')
        remaining = remaining[written:]


def main():
    os.umask(0o077)
    OUTPUT.mkdir(mode=0o700)  # Existing directory consumes/refuses this attempt.
    result = {'format': 1, 'purpose': 'FIXTURE_DIAGNOSTIC_ONLY', 'qa_ready': False,
              'target_qualified': False, 'status': 'REFUSED', 'phase': 'identity',
              'install_attempted': False, 'checks': {}, 'source': None}
    observations, baseline = [], None
    def alarm(_sig, _frame):
        raise TimeoutError('Guest deadline')
    signal.signal(signal.SIGALRM, alarm)
    signal.alarm(900)
    def command(argv, label, **kwargs):
        remaining = command_deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Guest command budget exhausted')
        kwargs['timeout'] = min(kwargs.get('timeout', 120), remaining)
        return run(argv, OUTPUT, label, **kwargs)
    def snap(label):
        data = command(INVENTORY_ARGV, label)
        return inventory(data.decode())
    def audit(label):
        if command(['dpkg', '--audit'], label):
            raise ValueError('Dirty dpkg audit')
    def sample(child=None):
        value = observe(check_locks=child is None)
        observations.append({'elapsed': time.monotonic() - started, 'child': child, 'value': value})
        if len(observations) > 1000:
            raise ValueError('Observation count limit')
        fixture_observation(value, baseline, child)
        return value
    started = time.monotonic()
    command_deadline = started + 900
    try:
        manifest = verify_input()
        result['source'] = manifest['source']
        if command(['dpkg', '--print-architecture'], 'arch').strip() != b'amd64':
            raise ValueError('Wrong fixture architecture')
        os_text = command(['cat', '/etc/os-release'], 'os').decode()
        if 'ID=ubuntu\n' not in os_text or 'VERSION_ID="24.04"\n' not in os_text:
            raise ValueError('Wrong fixture OS')
        command(['uname', '-a'], 'kernel')
        native_identity()
        lock = json.loads(read(INPUT / 'r3-toolchain.lock.json'))
        validate_lock(lock)
        result['phase'] = 'native-baseline'
        before = snap('before')
        audit('audit-initial')
        native_files()
        command(['apt-config', 'dump'], 'config')
        paths = []
        for index, pin in enumerate(lock['packages']):
            path = str(INPUT / 'artifacts' / pin['url'].rsplit('/', 1)[1])
            if file_hash(path) != pin['sha256']:
                raise ValueError('Archive changed')
            metadata = command(['dpkg-deb', '--show', '--showformat=${Package}\n${Version}\n${Architecture}\n', path], 'metadata-' + str(index)).decode().splitlines()
            if metadata != [pin['name'], pin['version'], 'amd64']:
                raise ValueError('Archive metadata changed')
            command(['dpkg-deb', '--contents', path], 'payload-' + str(index))
            paths.append(path)
        require_absent(before, lock)
        baseline = sample()
        result['phase'] = 'simulation'
        output = command(install_argv(paths, simulate=True), 'simulate', sample=sample).decode()
        validate_dependency_plan(lock, output)
        if snap('pre-execute') != before:
            raise ValueError('Inventory changed before install')
        sample()
        result['phase'] = 'installation'
        result['install_attempted'] = True
        command(install_argv(paths, transaction_log=OUTPUT / 'transaction.log'), 'install', timeout=360, sample=sample)
        # Capture actual state even when the transaction guard then refuses triggers.
        after = snap('after')
        audit('audit-post')
        result['checks']['inventory'] = inventory_diff(before, after, lock)
        result['checks']['transaction'] = transaction(read(OUTPUT / 'transaction.log').decode(), lock)
        sample()
        result['phase'] = 'holds'
        command(['apt-mark', 'hold', *[p['name'] for p in lock['packages']]], 'holds', sample=sample)
        final = snap('final')
        audit('audit-final')
        held_inventory(after, final, lock)
        result['checks']['final_inventory'] = inventory_diff(before, final, lock, held=True)
        sample()
        result['status'] = 'DIAGNOSTIC_PASS_REVIEW_REQUIRED'
        result['phase'] = 'complete'
    except BaseException as exc:
        result['failure_type'] = type(exc).__name__
        result['failure'] = str(exc)[:500]
    finally:
        signal.alarm(180)
        command_deadline = time.monotonic() + 120  # Reserve 60 seconds for export.
        # Failure snapshots are labelled actual observations, never fabricated passes.
        for label in ('after', 'final'):
            if not (OUTPUT / (label + '.command.json')).exists():
                try:
                    snap(label)
                except Exception as exc:
                    result['checks'][label + '_failure'] = type(exc).__name__
        for label in ('audit-post', 'audit-final'):
            if not (OUTPUT / (label + '.command.json')).exists():
                try:
                    audit(label)
                except Exception as exc:
                    result['checks'][label + '_failure'] = type(exc).__name__
        write(OUTPUT / 'observations.json', encoded(observations))
        result['files'] = {p.name: file_hash(p) for p in OUTPUT.iterdir() if p.is_file()}
        result['not_reached'] = [name for name in COMMANDS if not (OUTPUT / (name + '.command.json')).exists()]
        write(OUTPUT / 'result.json', encoded(result))
        with open(PORT, 'wb', buffering=0) as port:
            write_all(port, archive(OUTPUT))
        signal.alarm(0)
    return 0 if result['status'] == 'DIAGNOSTIC_PASS_REVIEW_REQUIRED' else 1


if __name__ == '__main__':
    raise SystemExit(main())
