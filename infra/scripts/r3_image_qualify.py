"""GitHub-hosted-only controller for ONE registry-denied, empty-store image transport run.

Connected phase (runner user): bind the dispatched source, stage the pinned
toolchain packages and the age tool, acquire the twelve locked roots by digest
and package them with r3_image_transport. Denied phase (root, loopback-only
network namespace): r3_image_import.py imports only the nine active roots into a
new pinned-Engine store and reads every identity back. No service is started and
nothing is pulled or built. Evidence is sealed to the owner's public recipient.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_artifacts import stage as stage_toolchain
from r3_image_acquire import acquire
from r3_image_import import HOSTS, NETNS, NSSWITCH, RESOLV_CONF
from r3_image_transport import ACTIVE, prepare
from r3_noble_common import ENV, digest, encoded, file_hash, read, run, write
from r3_noble_inputs import recipient, stage_age

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = '.github/workflows/r3-image-transport.yml'
JOB = 'image-transport'
SCRATCH = Path('/mnt')
NETNS_ETC = Path('/etc/netns')
FREE_BYTES = 40 * 1024**3
EVIDENCE_LIMIT = 256 * 1024 * 1024
PASS = 'TRANSPORT_IDENTITY_PASS_REVIEW_REQUIRED'
ENV_NAMES = ('R3_SOURCE_SHA', 'R3_RECIPIENT', 'R3_RECIPIENT_SHA256', 'GITHUB_SHA', 'GITHUB_REF',
             'GITHUB_WORKFLOW_SHA', 'GITHUB_WORKFLOW_REF', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID',
             'GITHUB_RUN_ATTEMPT', 'GITHUB_REPOSITORY', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH',
             'RUNNER_TEMP', 'ImageOS', 'ImageVersion')


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], timeout=30)


def source_binding(env):
    sha, ref = env.get('R3_SOURCE_SHA', ''), env.get('GITHUB_REF', '')
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
    for row in git('ls-tree', '-rz', '--full-tree', sha).split(b'\0'):
        if not row:
            continue
        metadata, raw = row.split(b'\t', 1)
        mode, kind, blob = metadata.split()
        name = raw.decode()
        path = ROOT / name
        if mode not in (b'100644', b'100755') or kind != b'blob' or path.is_symlink() or not path.is_file():
            raise ValueError('Unexpected tracked source type')
        data = path.read_bytes()  # Catches assume-unchanged/skip-worktree edits too.
        if hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest() != blob.decode():
            raise ValueError('Tracked source bytes differ')
        files[name] = digest(data)
    return {'sha': sha, 'ref': ref, 'run_id': env['GITHUB_RUN_ID'], 'attempt': 1,
            'repository': env['GITHUB_REPOSITORY'], 'job': JOB, 'workflow_sha256': files[WORKFLOW], 'files': files}


def preflight(raw):
    for tool in ('ip', 'dpkg-deb', 'gpg', 'sudo', 'systemctl', 'python3'):
        if shutil.which(tool, path=ENV['PATH']) is None:
            raise ValueError('Required runner tool missing: ' + tool)
    usage = os.statvfs(SCRATCH)
    if usage.f_bavail * usage.f_frsize < FREE_BYTES:
        raise ValueError('Insufficient disposable scratch space')
    if run(['ip', 'netns', 'list'], raw, 'netns-before').strip() or (NETNS_ETC / NETNS).exists():
        raise ValueError('A network namespace already exists; never reuse one')
    return {'scratch_free_bytes': usage.f_bavail * usage.f_frsize}


def isolate(work, raw):
    """Stop the hosted Engine, then build the loopback-only denied namespace."""
    units = ['docker.socket', 'docker.service', 'containerd.service']
    loaded = run(['systemctl', 'show', '--property', 'LoadState', '--value', *units], raw, 'hosted-engine-units')
    present = [unit for unit, state in zip(units, loaded.decode().split()) if state == 'loaded']
    if present:
        run(['sudo', '-n', 'systemctl', 'stop', *present], raw, 'hosted-engine-stop', privileged=True)
    states = run(['systemctl', 'show', '--property', 'ActiveState', '--value', *units], raw, 'hosted-engine-state')
    if any(state not in ('inactive', 'failed') for state in states.decode().split()) or len(states.split()) != len(units):
        raise ValueError('Hosted Engine still active')
    # Fallback tunnel devices (sit0, tunl0, ...) must not appear in the new namespace.
    run(['sudo', '-n', 'sysctl', '-w', 'net.core.fb_tunnels_only_for_init_net=2'], raw, 'netns-tunnels', privileged=True)
    run(['sudo', '-n', 'ip', 'netns', 'add', NETNS], raw, 'netns-add', privileged=True)
    run(['sudo', '-n', 'ip', '-n', NETNS, 'link', 'set', 'lo', 'up'], raw, 'netns-loopback', privileged=True)
    staged = work / 'netns-files'
    staged.mkdir(mode=0o700)
    for name, data in (('resolv.conf', RESOLV_CONF), ('hosts', HOSTS), ('nsswitch.conf', NSSWITCH)):
        write(staged / name, data)
        run(['sudo', '-n', 'install', '-D', '-o', 'root', '-g', 'root', '-m', '0644', str(staged / name),
             '/etc/netns/' + NETNS + '/' + name], raw, 'netns-' + name, privileged=True)


def documents(layout, receipt, target):
    """Retain manifests and configs (never layers) for review of a refusal or pass."""
    target.mkdir(mode=0o700)
    names = set()
    for item in receipt['images'].values():
        names.update({item['root'], item.get('platform_manifest', item['root']), item['config']})
    for value in sorted(names):
        write(target / value[7:], read(layout / 'blobs/sha256' / value[7:]))


def contain(raw):
    """Before sealing: no process may remain in the denied namespace (a sudo PTY can
    keep the driver out of the killed group) and root-written evidence must be readable."""
    pids = run(['sudo', '-n', 'ip', 'netns', 'pids', NETNS], raw, 'netns-pids-after', privileged=True).split()
    if pids:
        run(['sudo', '-n', 'kill', '-KILL', *[p.decode() for p in pids]], raw, 'netns-kill', privileged=True)
        time.sleep(2)
    remaining = run(['sudo', '-n', 'ip', 'netns', 'pids', NETNS], raw, 'netns-pids-final', privileged=True).split()
    if (raw / 'isolated').exists():
        run(['sudo', '-n', 'chown', '-R', '--no-dereference', f'{os.getuid()}:{os.getgid()}', str(raw / 'isolated')],
            raw, 'isolated-chown', privileged=True)
    return {'killed': len(pids), 'remaining': len(remaining)}


def evidence_files(raw):
    def refuse(error):
        raise ValueError('Unreadable raw evidence directory') from error
    files = []
    for top, directories, names in os.walk(raw, onerror=refuse):
        if any((Path(top) / name).is_symlink() for name in directories):
            raise ValueError('Unexpected raw evidence type')
        files.extend(Path(top) / name for name in names)
    return sorted(files)


def seal(work, raw, publish, binding):
    files = evidence_files(raw)
    if any(p.is_symlink() or not p.is_file() for p in files):
        raise ValueError('Unexpected raw evidence type')
    manifest = {str(p.relative_to(raw)): file_hash(p) for p in files}
    write(raw / 'retention-manifest.json', encoded({'binding': binding, 'files': manifest}))
    archive, total = work / 'private-evidence.tar', 0
    with tarfile.open(archive, 'x') as tar:
        for path in evidence_files(raw):
            total += path.stat().st_size
            if total > EVIDENCE_LIMIT:
                raise ValueError('Private evidence total limit')
            tar.add(path, arcname=str(path.relative_to(raw)), recursive=False)
    ciphertext = publish / 'transport-evidence.tar.age'
    run([str(work / 'age'), '-R', str(work / 'recipient.pub'), '-o', str(ciphertext), str(archive)],
        work, 'encryption', timeout=300)
    return {'ciphertext_sha256': file_hash(ciphertext), 'ciphertext_bytes': ciphertext.stat().st_size,
            'plaintext_sha256': file_hash(archive), 'retention_manifest_sha256': file_hash(raw / 'retention-manifest.json')}


def transport(work, raw, source, summary, env):
    lock = json.loads(read(ROOT / 'infra/selfhost/images.qa.lock.json'))['services']
    summary['phase'] = 'preflight'
    write(raw / 'preflight.json', encoded(preflight(raw)))
    summary['phase'] = 'toolchain'
    manifest = stage_toolchain(work / 'bundle')
    write(raw / 'toolchain-manifest.json', encoded(manifest))
    summary['phase'] = 'acquire'
    receipt = acquire(lock, work / 'layout')
    write(raw / 'acquisition.json', encoded(receipt))
    documents(work / 'layout', receipt, raw / 'documents')
    summary['phase'] = 'archive'
    analysis = prepare(work / 'layout', work / 'transport')
    write(raw / 'transport-analysis.json', read(work / 'transport/transport-analysis.json'))
    summary['archive_sha256'] = analysis['archive_sha256']
    summary['phase'] = 'isolate'
    isolate(work, raw)
    summary['phase'] = 'import'
    request = {'work': str(work / 'isolated'), 'run_dir': '/run/tonyai-r3-transport-' + source['run_id'],
               'archive': str(work / 'transport/images.oci.tar'),
               'analysis': str(work / 'transport/transport-analysis.json'),
               'analysis_sha256': file_hash(work / 'transport/transport-analysis.json'),
               'packages': str(work / 'bundle/artifacts'), 'endpoints': receipt['endpoints'],
               'owner': [os.getuid(), os.getgid()]}
    write(work / 'import-request.json', encoded(request))
    write(raw / 'import-request.json', encoded(request))
    if source_binding(env) != source:
        raise ValueError('Source changed before the denied import')
    try:
        run(['sudo', '-n', 'ip', 'netns', 'exec', NETNS, '/usr/bin/env', '-i', 'PATH=' + ENV['PATH'],
             'LANG=C', 'LC_ALL=C', '/usr/bin/python3', '-I', '-B', str(ROOT / 'infra/scripts/r3_image_import.py'),
             str(work / 'import-request.json'), str(raw / 'isolated')], raw, 'isolated-import',
            timeout=2700, privileged=True)
    finally:
        try:
            summary['containment'] = contain(raw)
        except Exception as exc:
            summary['containment'] = {'error': type(exc).__name__}
        result_path = raw / 'isolated/result.json'
        result = json.loads(read(result_path)) if result_path.is_file() else {'status': 'MISSING'}
        summary['import_status'] = result.get('status')
        summary['import_phase'] = result.get('phase')
    if summary['containment'].get('remaining') != 0:
        raise ValueError('Denied namespace not contained')
    if result.get('status') != 'TRANSPORT_IDENTITY_PASS' or set(result.get('images', {})) != ACTIVE:
        raise ValueError('Isolated import refused')
    summary['load_archive_sha256'] = result['load_archive_sha256']
    summary['images'] = {name: item['id'] for name, item in sorted(result['images'].items())}
    summary['status'], summary['phase'] = PASS, 'complete'


def main():
    os.umask(0o077)
    # The only runner inputs are public dispatch/run bindings; nothing else survives.
    env = {k: os.environ.get(k, '') for k in ENV_NAMES}
    os.environ.clear()
    os.environ.update(ENV)
    source = source_binding(env)
    key = recipient(env['R3_RECIPIENT'], env['R3_RECIPIENT_SHA256'])
    temp = Path(env['RUNNER_TEMP'])
    if not temp.is_absolute() or not temp.is_dir() or temp.is_symlink():
        raise ValueError('Runner temporary directory required')
    # Records this attempt on this runner only. The job's run_attempt guard and
    # source_binding refuse reruns; a new dispatch needs a new owner approval.
    write(temp / ('r3-image-transport-consumed-' + source['run_id']), encoded(source))
    work = SCRATCH / ('tonyai-r3-transport-' + source['run_id'])
    subprocess.run(['sudo', '-n', 'install', '-d', '-o', str(os.getuid()), '-g', str(os.getgid()), '-m', '0700', str(work)],
                   check=True, env=ENV, timeout=30)
    if any(work.iterdir()):
        raise ValueError('Scratch directory must be new')
    raw, publish = work / 'raw', temp / 'r3-image-transport-publish'
    raw.mkdir(mode=0o700)
    publish.mkdir(mode=0o700)
    binding = {'format': 1, 'purpose': 'registry-denied-image-transport', 'source_sha': source['sha'],
               'source_ref': source['ref'], 'run_id': source['run_id'], 'attempt': 1, 'job': JOB,
               'workflow_sha256': source['workflow_sha256'], 'recipient_sha256': env['R3_RECIPIENT_SHA256'],
               'image_lock_sha256': file_hash(ROOT / 'infra/selfhost/images.qa.lock.json'),
               'toolchain_lock_sha256': file_hash(ROOT / 'infra/selfhost/r3-toolchain.lock.json'),
               'age_lock_sha256': file_hash(ROOT / 'infra/selfhost/r3-noble-fixture.lock.json'),
               'active_services': sorted(ACTIVE)}
    write(raw / 'source.json', encoded(source))
    write(raw / 'runner.json', encoded({k: env[k] for k in ('RUNNER_OS', 'RUNNER_ARCH', 'ImageOS', 'ImageVersion')}))
    summary = {'format': 1, 'status': 'REFUSED', 'phase': 'encryption-tool', 'sealed': False, 'qa_ready': False,
               'transport_gate_closed': False, 'review_required': True, 'binding': binding}
    try:
        stage_age(work, json.loads(read(ROOT / 'infra/selfhost/r3-noble-fixture.lock.json')), key, raw,
                  time.monotonic() + 120)
        transport(work, raw, source, summary, env)
    except BaseException as exc:
        summary['status'] = 'REFUSED'
        write(raw / 'controller-failure.json', encoded({'phase': summary['phase'], 'type': type(exc).__name__,
                                                        'message': str(exc)[:1000]}))
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
            (publish / 'transport-evidence.tar.age').unlink(missing_ok=True)
        write(publish / 'binding.json', encoded(binding))
        write(publish / 'summary.json', encoded(summary))
    print('Transport run finished. Review the sealed evidence; no QA readiness or bootstrap approval is claimed.')
    return 0 if summary['status'] == PASS and summary['sealed'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:
        raise SystemExit('Transport controller refused before sealing; no evidence was published.')
