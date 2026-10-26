"""GitHub-hosted-only controller for the R3 private DB candidate: ONE rehearsal or ONE attempt.

Connected phase (runner user; root only to create the fixed root): bind the dispatched
source, check the candidate lock, stage the pinned Node binary, rebuild the pinned
model-free Prisma Client bundle and stage the age tool, all at the fixed absolute paths
the lock (and so the owner's approval) binds by hash. Attempt only: acquire the pinned
db image's linux/amd64 closure by digest and derive its offline closure evidence.

The candidate's own attempt_entry.py then verifies every candidate file against the
approved manifest before anything runs, and seals its evidence to the owner's public
recipient. Only that ciphertext and public correspondence are published. Whatever
the outcome, the historical supautils SIG11 stays NOT_REPRODUCED and R3 stays OPEN.
"""
import base64
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_image_acquire import acquire
from r3_noble_common import digest, encoded, file_hash, kill_group, read, run, write
from r3_noble_inputs import fetch, recipient, stage_age

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = '.github/workflows/r3-db-candidate.yml'
JOB = 'db-candidate'
LOCK = 'infra/selfhost/r3-db-candidate.lock.json'
CANDIDATE = 'infra/scripts/r3_db_candidate'
GENERATED = 'infra/selfhost/r3-db-candidate-client'
FIXED_ROOT = Path('/private/tmp/tonyai-r3-db')
MODES = {'rehearsal': '--rehearse', 'attempt': '--execute'}
REHEARSAL_PURPOSE = 'R3_DB_REHEARSAL_NO_ATTEMPT'
ATTEMPT_PURPOSE = 'ONE_ISOLATED_DB_CANDIDATE'
APPROVAL_LIMIT = 4096
ENTRY_TIMEOUT = {'rehearsal': 1800, 'attempt': 2700}
TEARDOWN_GRACE = 180
SUMMARY_LIMIT = 64 * 1024
STAGING_SECONDS = 1200
HEX64 = re.compile('[0-9a-f]{64}')
HEX32 = re.compile('[0-9a-f]{32}')
LOCK_KEYS = {'format', 'scope', 'candidate_dir', 'source_manifest', 'source_manifest_sha256', 'root', 'endpoint_port',
             'image', 'config_digest', 'node', 'prisma', 'client_artifacts', 'client_artifacts_sha256', 'attempt'}
GENERATED_FILES = ('index.js', 'package.json', 'schema.prisma')
ENGINE_FILE = 'libquery_engine-debian-openssl-3.0.x.so.node'
# The entry gets nothing ambient: its own runner guard refuses Docker/PG/Prisma/loader overrides anyway.
ENTRY_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
ENV_NAMES = ('R3_MODE', 'R3_SOURCE_SHA', 'R3_APPROVAL', 'R3_RECIPIENT', 'R3_RECIPIENT_SHA256', 'GITHUB_SHA',
             'GITHUB_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_WORKFLOW_REF', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID',
             'GITHUB_RUN_ATTEMPT', 'GITHUB_REPOSITORY', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH',
             'RUNNER_TEMP')


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
            'repository': env['GITHUB_REPOSITORY'], 'job': JOB, 'workflow_sha256': files[WORKFLOW],
            'lock_sha256': files[LOCK]}


def js_canonical(value):
    """The canonical JSON the candidate hashes (entrypoint.mjs / runtime_executor.js_canonical)."""
    if isinstance(value, list):
        return '[' + ','.join(js_canonical(v) for v in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + js_canonical(value[k]) for k in sorted(value)) + '}'
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def canonical_sha(value):
    return digest(js_canonical(value).encode())


def expected_artifacts(lock):
    """The exact client artifact set, derived from the node and Prisma pins (never trusted as given)."""
    node, prisma = lock['node'], lock['prisma']
    client = lock['root'] + '/client/'
    artifacts = {node['path']: {'sha256': node['sha256'], 'bytes': node['bytes']}}
    for name in GENERATED_FILES:
        artifacts[client + name] = dict(prisma['generated'][name])
    library, engine = prisma['runtime_library'], prisma['engine']
    artifacts[client + 'runtime/library.js'] = {'sha256': library['sha256'], 'bytes': library['bytes']}
    artifacts[client + ENGINE_FILE] = {'sha256': engine['sha256'], 'bytes': engine['bytes']}
    return artifacts


def validate_lock(lock, root=ROOT):
    """Every pin agrees with the committed bytes, the toolchain/image locks and itself."""
    if not isinstance(lock, dict) or set(lock) != LOCK_KEYS or lock['format'] != 1:
        raise ValueError('Candidate lock shape differs')
    if lock['candidate_dir'] != CANDIDATE or lock['root'] != str(FIXED_ROOT) or lock['endpoint_port'] != 55432:
        raise ValueError('Candidate lock location differs')
    names = sorted(p.name for p in (root / CANDIDATE).iterdir())
    manifest = lock['source_manifest']
    if names != sorted(manifest) or any(file_hash(root / CANDIDATE / n) != manifest[n] for n in names):
        raise ValueError('Candidate files differ from the lock manifest')
    if lock['source_manifest_sha256'] != canonical_sha(manifest):
        raise ValueError('Candidate manifest hash differs')
    image = json.loads(read(root / 'infra/selfhost/images.qa.lock.json'))['services']['db']
    if lock['image'] != image['image'] or image['platform'] != 'linux/amd64' or not HEX64.fullmatch(lock['config_digest'][7:]) \
            or not lock['config_digest'].startswith('sha256:'):
        raise ValueError('Candidate image pin differs')
    toolchain = json.loads(read(root / 'infra/selfhost/r3-toolchain.lock.json'))['node']
    node = lock['node']
    if (node['archive_lock'] != 'infra/selfhost/r3-toolchain.lock.json'
            or node['member'] != 'node-v' + toolchain['version'] + '-linux-x64/bin/node'
            or node['path'] != lock['root'] + '/' + node['member']):
        raise ValueError('Candidate Node pin differs')
    prisma = lock['prisma']
    if prisma['generated_dir'] != GENERATED or sorted(p.name for p in (root / GENERATED).iterdir()) != sorted(GENERATED_FILES):
        raise ValueError('Generated client files differ')
    for name in GENERATED_FILES:
        data = read(root / GENERATED / name)
        if prisma['generated'][name] != {'sha256': digest(data), 'bytes': len(data)}:
            raise ValueError('Generated client pin differs: ' + name)
    library = prisma['runtime_library']
    if len(library['generated_header'].encode()) + library['member_bytes'] != library['bytes']:
        raise ValueError('Runtime library pin is inconsistent')
    for item in (library, prisma['engine']):
        if not item['url'].startswith('https://') or not HEX64.fullmatch(item['archive_sha256']):
            raise ValueError('Prisma download pin differs')
    if lock['client_artifacts'] != expected_artifacts(lock):
        raise ValueError('Client artifacts differ from the pins')
    if lock['client_artifacts_sha256'] != canonical_sha({p: m['sha256'] for p, m in lock['client_artifacts'].items()}):
        raise ValueError('Client artifacts hash differs')
    attempt = lock['attempt']
    bound = (attempt.get('attempt_id'), attempt.get('owner_decision_sha256'))
    if set(attempt) != {'attempt_id', 'owner_decision_sha256'} or not (
            bound == (None, None) or (isinstance(bound[0], str) and HEX32.fullmatch(bound[0])
                                      and isinstance(bound[1], str) and HEX64.fullmatch(bound[1]))):
        raise ValueError('Attempt binding shape differs')
    return toolchain


def parse_approval(mode, text, lock):
    """Early, cheap agreement with the lock. attempt_entry.py re-validates the full shape itself."""
    if mode not in MODES:
        raise ValueError('Unknown mode')
    if not isinstance(text, str) or not text or len(text.encode()) > APPROVAL_LIMIT:
        raise ValueError('Approval size')
    approval = json.loads(text)
    if not isinstance(approval, dict) or approval.get('source_manifest_sha256') != lock['source_manifest_sha256']:
        raise ValueError('Approval does not bind this candidate manifest')
    if mode == 'rehearsal':
        if approval.get('purpose') != REHEARSAL_PURPOSE or approval.get('consumes_attempt') is not False:
            raise ValueError('Not a rehearsal approval')
        return approval
    attempt = lock['attempt']
    if attempt['attempt_id'] is None:
        raise ValueError('No attempt is bound by a reviewed commit')
    if (approval.get('purpose') != ATTEMPT_PURPOSE or approval.get('single_attempt') is not True
            or approval.get('attempt_id') != attempt['attempt_id']
            or approval.get('owner_decision_sha256') != attempt['owner_decision_sha256']
            or approval.get('client_artifacts_sha256') != lock['client_artifacts_sha256']):
        raise ValueError('Attempt approval differs from the bound attempt')
    return approval


def private_dir(path):
    os.mkdir(path, 0o700)
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Private directory differs')


def prepare_root(raw, fixed=FIXED_ROOT):
    """The fixed root is new, ours and 0700; every parent is a root-owned, non-writable real directory."""
    if os.path.lexists(fixed):
        raise ValueError('Fixed root already exists; never reuse one')
    parents = [p for p in reversed(fixed.parents) if str(p) != '/']
    missing = [str(p) for p in parents if not os.path.lexists(p)]
    if missing:
        run(['sudo', '-n', 'install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', *missing], raw, 'fixed-parents',
            privileged=True)
    for parent in parents:
        info = os.lstat(parent)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError('Fixed root parent is unsafe')
    run(['sudo', '-n', 'install', '-d', '-o', str(os.getuid()), '-g', str(os.getgid()), '-m', '0700', str(fixed)],
        raw, 'fixed-root', privileged=True)
    info = os.lstat(fixed)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Fixed root differs')


def place(path, data, mode):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    write(path, data)
    path.chmod(mode)


def one_member(archive, name, size, mode):
    with tarfile.open(archive, mode) as tar:
        matches = [m for m in tar.getmembers() if m.name == name]
        if len(matches) != 1 or not matches[0].isfile() or matches[0].size != size:
            raise ValueError('Unexpected archive member: ' + name)
        return tar.extractfile(matches[0]).read()


def stage_node(work, lock, toolchain, deadline):
    node = lock['node']
    archive = work / 'node.tar.xz'
    fetch(toolchain['url'], archive, 64 * 1024 * 1024, deadline, toolchain['sha256'])
    data = one_member(archive, node['member'], node['bytes'], 'r:xz')
    if digest(data) != node['sha256']:
        raise ValueError('Node binary differs')
    place(node['path'], data, 0o755)


def stage_client(work, lock, deadline, root=ROOT):
    prisma, client = lock['prisma'], Path(lock['root']) / 'client'
    for name in GENERATED_FILES:
        place(client / name, read(root / GENERATED / name), 0o644)
    library = prisma['runtime_library']
    archive = work / 'prisma-client.tgz'
    fetch(library['url'], archive, 64 * 1024 * 1024, deadline, library['archive_sha256'])
    if os.path.getsize(archive) != library['archive_bytes'] or 'sha512-' + base64.b64encode(
            hashlib.sha512(read(archive, 64 * 1024 * 1024)).digest()).decode() != library['archive_integrity']:
        raise ValueError('Prisma client archive differs from the lockfile integrity')
    member = one_member(archive, library['member'], library['member_bytes'], 'r:gz')
    if digest(member) != library['member_sha256']:
        raise ValueError('Prisma runtime library differs')
    place(client / 'runtime/library.js', library['generated_header'].encode() + member, 0o644)
    engine = prisma['engine']
    compressed = work / 'engine.gz'
    fetch(engine['url'], compressed, 32 * 1024 * 1024, deadline, engine['archive_sha256'])
    if os.path.getsize(compressed) != engine['archive_bytes']:
        raise ValueError('Prisma engine archive differs')
    with gzip.open(compressed, 'rb') as stream:
        data = stream.read(engine['bytes'] + 1)
    if len(data) != engine['bytes'] or digest(data) != engine['sha256']:
        raise ValueError('Prisma engine differs')
    place(client / ENGINE_FILE, data, 0o644)


def verify_artifacts(lock):
    """Re-read every staged artifact by its canonical path before the entry sees any of them."""
    for path, meta in lock['client_artifacts'].items():
        if os.path.realpath(path) != path or os.path.getsize(path) != meta['bytes'] or file_hash(path) != meta['sha256']:
            raise ValueError('Staged artifact differs')
    return lock['client_artifacts']


def closure_evidence(work, lock, root=ROOT):
    """Attempt only: the db image's closure by digest, then the candidate's offline closure adapter."""
    image = json.loads(read(root / 'infra/selfhost/images.qa.lock.json'))['services']['db']
    acquire({'db': image}, work / 'layout')
    spec = importlib.util.spec_from_file_location('r3_db_closure_adapter', root / CANDIDATE / 'closure_adapter.py')
    adapter = importlib.util.module_from_spec(spec)
    sys.modules['r3_db_closure_adapter'] = adapter
    spec.loader.exec_module(adapter)
    if adapter.CONFIG_DIGEST != lock['config_digest']:
        raise ValueError('Closure adapter pin differs')
    index, report, _ = adapter.build_closure_evidence(str(work / 'layout'), str(work / 'closure-evidence'),
                                                      image_ref=lock['image'])
    closure = adapter.rc.read_startup_closure(index, adapter.make_reader())
    return {'summary': adapter.summarize(index, report, closure), 'closure': closure.to_json(), 'report': report}, index


def build_packet(mode, lock, inputs, paths):
    packet = {'work_dir': str(FIXED_ROOT / 'run'), 'source_root': str(ROOT / CANDIDATE), 'node_path': lock['node']['path'],
              'age_path': paths['age'], 'age_sha256': paths['age_sha256'], 'recipient_path': paths['recipient'],
              'recipient_sha256': paths['recipient_sha256'], 'approval_path': str(inputs / 'approval.json'),
              'binding05_path': str(inputs / 'manifest.json'), 'client_artifacts_path': str(inputs / 'client-artifacts.json'),
              'endpoint_port': lock['endpoint_port'], 'image': lock['image'], 'config_digest': lock['config_digest']}
    if mode == 'attempt':
        packet.update({'state_dir': str(FIXED_ROOT / 'state'), 'binding_path': str(inputs / 'binding.json'),
                       'closure_evidence_path': str(inputs / 'closure-evidence.json'),
                       'closure_index_path': str(inputs / 'closure-index.json')})
    return packet


def run_entry(argv, timeout, popen=subprocess.Popen):
    """The entry runs in its own group. On the deadline it gets ONE SIGTERM (it tears its container
    down once), then the group is killed."""
    child = popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                  env=dict(ENTRY_ENV), cwd=str(FIXED_ROOT), start_new_session=True)
    try:
        out, err = child.communicate(timeout=timeout)
        return child.returncode, out, err
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            out, err = child.communicate(timeout=TEARDOWN_GRACE)
        except subprocess.TimeoutExpired:
            kill_group(child)
            out, err = child.communicate()
        return None, out, err


def entry_summary(out):
    """Only the entry's own bounded JSON summary (failure codes, never messages) is public."""
    try:
        value = json.loads(out[:SUMMARY_LIMIT].decode())
    except (UnicodeDecodeError, ValueError):
        return None
    return value if isinstance(value, dict) and len(out) <= SUMMARY_LIMIT else None


def entry_code(err):
    line = err[-512:].decode('ascii', 'replace').strip().splitlines()[-1:] if err else []
    return line[0] if line and re.fullmatch(r'[A-Z][A-Z0-9_]*(:[A-Za-z0-9_.-]+)?', line[0]) else None


def candidate(mode, env, source, work, raw, publish, summary):
    deadline = time.monotonic() + STAGING_SECONDS
    lock = json.loads(read(ROOT / LOCK))
    summary['phase'] = 'lock'
    toolchain = validate_lock(lock)
    approval = parse_approval(mode, env.get('R3_APPROVAL', ''), lock)
    recipient_bytes = recipient(env.get('R3_RECIPIENT', ''), env.get('R3_RECIPIENT_SHA256', ''))
    summary.update({'source_manifest_sha256': lock['source_manifest_sha256'],
                    'client_artifacts_sha256': lock['client_artifacts_sha256'],
                    'approval_sha256': canonical_sha(approval)})
    summary['phase'] = 'fixed-root'
    prepare_root(raw)
    inputs = FIXED_ROOT / 'inputs'
    private_dir(inputs)
    summary['phase'] = 'node'
    stage_node(work, lock, toolchain, deadline)
    summary['phase'] = 'prisma'
    stage_client(work, lock, deadline)
    artifacts = verify_artifacts(lock)
    summary['phase'] = 'age'
    fixture = json.loads(read(ROOT / 'infra/selfhost/r3-noble-fixture.lock.json'))
    stage_age(inputs, fixture, recipient_bytes, raw, deadline)
    write(inputs / 'approval.json', encoded(approval))
    write(inputs / 'manifest.json', encoded({'node_source_manifest': lock['source_manifest']}))
    write(inputs / 'client-artifacts.json', encoded(artifacts))
    if mode == 'attempt':
        summary['phase'] = 'closure'
        evidence, index = closure_evidence(work, lock)
        write(inputs / 'closure-evidence.json', encoded(evidence))
        write(inputs / 'closure-index.json', encoded(index))
        write(inputs / 'binding.json', encoded({
            'attempt_id': lock['attempt']['attempt_id'], 'owner_decision_sha256': lock['attempt']['owner_decision_sha256'],
            'client_artifacts_sha256': lock['client_artifacts_sha256'], 'image': lock['image'],
            'config_digest': lock['config_digest']}))
        private_dir(FIXED_ROOT / 'state')
    paths = {'age': str(inputs / 'age'), 'age_sha256': file_hash(inputs / 'age'),
             'recipient': str(inputs / 'recipient.pub'), 'recipient_sha256': digest(recipient_bytes)}
    write(inputs / 'packet.json', encoded(build_packet(mode, lock, inputs, paths)))
    if source_binding(env) != source:
        raise ValueError('Source changed before the candidate entry')
    summary['phase'] = 'entry'
    rc, out, err = run_entry(['/usr/bin/python3', '-I', '-B', str(ROOT / CANDIDATE / 'attempt_entry.py'),
                              MODES[mode], str(inputs / 'packet.json')], ENTRY_TIMEOUT[mode])
    write(raw / 'entry.stdout', out[:SUMMARY_LIMIT])
    write(raw / 'entry.stderr', err[-SUMMARY_LIMIT:])
    summary.update({'entry_exit_code': rc, 'entry': entry_summary(out), 'entry_failure': entry_code(err)})
    ciphertext = FIXED_ROOT / 'run/publish/db-candidate-evidence.tar.age'
    if ciphertext.is_file() and not ciphertext.is_symlink():
        shutil.copyfile(ciphertext, publish / 'db-candidate-evidence.tar.age')
        summary['ciphertext_sha256'] = file_hash(publish / 'db-candidate-evidence.tar.age')
    summary['phase'] = 'complete'
    return rc == 0


def main():
    env = {name: os.environ.get(name, '') for name in ENV_NAMES}
    mode = env['R3_MODE']
    summary = {'mode': mode if mode in MODES else None, 'phase': 'source', 'historical_status': 'NOT_REPRODUCED',
               'r3_status': 'OPEN', 'status': 'REFUSED'}
    temp = Path(env['RUNNER_TEMP'] or '/nonexistent')
    work, raw, publish = temp / 'r3-db-candidate', temp / 'r3-db-candidate-raw', temp / 'r3-db-candidate-publish'
    for directory in (work, raw, publish):
        private_dir(directory)
    source, passed = None, False
    try:
        if mode not in MODES:
            raise ValueError('Unknown mode')
        source = source_binding(env)
        passed = candidate(mode, env, source, work, raw, publish, summary)
        summary['status'] = 'ENTRY_PASSED_REVIEW_REQUIRED' if passed else 'ENTRY_DID_NOT_PASS'
    except Exception as exc:  # fixed refusal text only; never a path, URL or input value
        summary['failure'] = type(exc).__name__ + ': ' + (str(exc) if isinstance(exc, ValueError) else 'driver error')
    finally:
        write(publish / 'binding.json', encoded({'source': source, 'mode': summary['mode'],
                                                 'recipient_sha256': env['R3_RECIPIENT_SHA256'] if HEX64.fullmatch(env['R3_RECIPIENT_SHA256']) else None,
                                                 'historical_status': 'NOT_REPRODUCED', 'r3_status': 'OPEN'}))
        write(publish / 'summary.json', encoded(summary))
    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
