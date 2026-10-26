#!/usr/bin/env python3
"""db-candidate05/attempt_entry.py — private offline preparation. NOT an execution authorization.

The one command the owner runs on the disposable Linux/amd64 runner, after approving the single attempt:

    python3 -I -B attempt_entry.py --execute <packet.json>

and, BEFORE that and separately approved, the non-consuming rehearsal (rehearsal.py; no attempt id, no
fixture, no probe; the ops bundle it gets has no consume_attempt / run_candidate at all):

    python3 -I -B attempt_entry.py --rehearse <rehearsal-packet.json>

Root of trust = the owner's runtime approval. Its `source_manifest_sha256` must equal the canonical hash
of binding05's `node_source_manifest`, which lists EVERY harness file the attempt loads — the Node files
the entrypoint gate re-checks later AND the Python files run here. `source_root` must be this script's
own directory; each file is verified against that approval-bound manifest and the Python modules are
executed from exactly the bytes that were hashed. Setup SQL, the collision query and the
pg_db_role_setting query come from the hash-verified fixture-sql.mjs (setup re-checked against its pin).
Then live_ops builds the real ops (refuses off Linux/x86_64 or with ambient DOCKER_*/DATABASE_URL/PG*/
PRISMA_*) and runtime_executor.run_attempt runs exactly once. SIGTERM still reaches teardown.
Without --execute it only verifies and prints what it would bind.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import secrets
import signal
import subprocess
import sys

HERE = os.path.dirname(os.path.realpath(__file__))

SETUP_SHA256 = 'a666913165af9121e9f5c960e87fea86cfd284ca4fe4ceeb1884961e5ac18a48'
# N7: the two other statements run as supabase_admin are pinned too (normalized: rstrip + ';\n').
COLLISION_SHA256 = '1a667fb1e1bf996981000fc1a86e2c6c7b3dd86bf9abfca28cc84cbba79ad92a'
ROLE_SETTING_SHA256 = '04f3c27d8d096fb375dfde40f840c829c96937f5eca672e94d4706004236ab05'
PRELOAD_QUERY = ("SELECT name, setting, source, coalesce(sourcefile, '') FROM pg_settings "
                 "WHERE name IN ('local_preload_libraries', 'session_preload_libraries', 'shared_preload_libraries') "
                 "ORDER BY name COLLATE \"C\";\n")
# Only role-list GUCs (no JSON-valued supautils settings, so a '|' can never split a row).
SUPAUTILS_QUERY = ("SELECT name, setting, source, coalesce(sourcefile, '') FROM pg_settings "
                   "WHERE name IN ('supautils.privileged_extensions_superuser', 'supautils.privileged_role', "
                   "'supautils.reserved_memberships', 'supautils.reserved_roles', 'supautils.superuser') "
                   "ORDER BY name COLLATE \"C\";\n")
# Every file the attempt loads; all must be in the approval-bound manifest.
REQUIRED_FILES = ('attempt_entry.py', 'runtime_executor.py', 'live_ops.py', 'runtime_contract.py', 'loaded-library.py',
                  'validate-evidence.py', 'entrypoint.mjs', 'driver.mjs', 'prisma-adapter.mjs', 'fixture-sql.mjs',
                  'manifest.mjs', 'run_candidate.mjs', 'rehearsal.py')
PYTHON_MODULES = (('runtime_executor', 'runtime_executor.py'), ('runtime_contract', 'runtime_contract.py'),
                  ('loaded_library', 'loaded-library.py'), ('validate_evidence', 'validate-evidence.py'),
                  ('live_ops', 'live_ops.py'), ('rehearsal', 'rehearsal.py'))
PACKET_KEYS = frozenset({
    'work_dir', 'state_dir', 'source_root', 'node_path', 'age_path', 'age_sha256', 'recipient_path',
    'recipient_sha256', 'approval_path', 'binding_path', 'binding05_path', 'closure_evidence_path',
    'closure_index_path', 'client_artifacts_path', 'endpoint_port', 'image', 'config_digest'})
REHEARSAL_PACKET_KEYS = frozenset({
    'work_dir', 'source_root', 'node_path', 'age_path', 'age_sha256', 'recipient_path', 'recipient_sha256',
    'approval_path', 'binding05_path', 'client_artifacts_path', 'endpoint_port', 'image', 'config_digest'})
# A rehearsal must never be able to reach these, even by mistake: they are removed from its ops bundle.
NOT_FOR_REHEARSAL = ('consume_attempt', 'run_candidate', 'set_probe_password', 'make_empty_private_dir')
PATH_KEYS = ('work_dir', 'state_dir', 'source_root', 'node_path', 'age_path', 'recipient_path', 'approval_path',
             'binding_path', 'binding05_path', 'closure_evidence_path', 'closure_index_path', 'client_artifacts_path')


class EntryRefusal(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class TerminationRequested(BaseException):
    """Raised from the SIGTERM handler; run_attempt catches BaseException, so teardown still runs."""
    code = 'SIGTERM'


def _need(cond, code):
    if not cond:
        raise EntryRefusal(code)


def _read_json(path):
    with open(path, 'rb') as handle:
        return json.loads(handle.read())


def js_canonical(value):
    if isinstance(value, list):
        return '[' + ','.join(js_canonical(v) for v in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + js_canonical(value[k]) for k in sorted(value)) + '}'
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def check_packet(packet, keys=PACKET_KEYS):
    _need(isinstance(packet, dict) and set(packet) == keys, 'PACKET_SHAPE')
    for key in PATH_KEYS:
        if key not in keys:
            continue
        value = packet[key]
        _need(isinstance(value, str) and value.startswith('/') and '..' not in value.split('/') and '\0' not in value,
              'PACKET_PATH:' + key)
    _need(os.path.realpath(packet['source_root']) == HERE, 'SOURCE_ROOT_NOT_THIS_DIRECTORY')
    return packet


def approved_manifest(approval, binding05):
    """The manifest the owner approved: binding05's node_source_manifest, bound by the approval hash."""
    manifest = binding05.get('node_source_manifest')
    _need(isinstance(manifest, dict) and manifest, 'MANIFEST_SHAPE')
    digest = hashlib.sha256(js_canonical(manifest).encode()).hexdigest()
    _need(isinstance(approval, dict) and approval.get('source_manifest_sha256') == digest, 'MANIFEST_NOT_APPROVED')
    for name in REQUIRED_FILES:
        _need(name in manifest, 'MANIFEST_MISSING:' + name)
    return manifest


def verify_files(manifest, root=None):
    """Hash every approved file under this directory; return {name: bytes} so modules run from those bytes."""
    root = root or HERE
    verified = {}
    for name, digest in sorted(manifest.items()):
        _need('/' not in name and '..' not in name, 'MANIFEST_NAME:' + name)
        with open(os.path.join(root, name), 'rb') as handle:
            data = handle.read()
        _need(hashlib.sha256(data).hexdigest() == digest, 'PINNED_FILE:' + name)
        verified[name] = data
    return verified


def load_verified(name, filename, verified):
    """Execute a module from exactly the verified bytes (no second read from disk)."""
    path = os.path.join(HERE, filename)
    existing = sys.modules.get(name)
    if existing is not None and getattr(existing, '__r3_verified_sha256__', None) == hashlib.sha256(verified[filename]).hexdigest():
        return existing
    spec = importlib.util.spec_from_loader(name, loader=None, origin=path)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = path
    module.__r3_verified_sha256__ = hashlib.sha256(verified[filename]).hexdigest()
    sys.modules[name] = module
    exec(compile(verified[filename], path, 'exec'), module.__dict__)
    return module


# The module is imported from the VERIFIED bytes (a data: URL passed as argv), never re-read from disk.
FIXTURE_JS = ("const m = await import('data:text/javascript;base64,' + process.argv[1]);"
              "process.stdout.write(JSON.stringify({setup: m.SETUP_SCRIPT, collision: m.COLLISION_QUERY,"
              " roleSettings: m.DB_ROLE_SETTING_QUERY}));")


def fixture_sql_constants(node_path, fixture_bytes):
    """SETUP_SCRIPT / COLLISION_QUERY / DB_ROLE_SETTING_QUERY evaluated from the verified fixture-sql.mjs
    bytes; each statement that will run as supabase_admin is re-checked against its pin."""
    import base64
    _need(isinstance(fixture_bytes, bytes) and fixture_bytes, 'FIXTURE_SQL_BYTES')
    out = subprocess.run([node_path, '--input-type=module', '-e', FIXTURE_JS, base64.b64encode(fixture_bytes).decode()],
                         capture_output=True, timeout=30, env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    _need(out.returncode == 0, 'FIXTURE_SQL_LOAD')
    values = json.loads(out.stdout)
    setup = values['setup']
    collision = values['collision'].rstrip() + ';\n'
    roles = values['roleSettings'].rstrip() + ';\n'
    _need(hashlib.sha256(setup.encode()).hexdigest() == SETUP_SHA256, 'SETUP_PIN')
    _need(hashlib.sha256(collision.encode()).hexdigest() == COLLISION_SHA256, 'COLLISION_PIN')
    _need(hashlib.sha256(roles.encode()).hexdigest() == ROLE_SETTING_SHA256, 'ROLE_SETTING_PIN')
    return setup, collision, roles


def verify_node(node_path, client_artifacts, hash_file):
    """N7: the Node binary is the first thing executed; it must be the approved artifact (bytes + size)
    and its canonical path, before it ever runs."""
    _need(isinstance(client_artifacts, dict) and node_path in client_artifacts, 'NODE_NOT_IN_ARTIFACTS')
    _need(os.path.realpath(node_path) == node_path, 'NODE_PATH_NOT_CANONICAL')
    digest, size = hash_file(node_path)
    meta = client_artifacts[node_path]
    _need(isinstance(meta, dict) and meta.get('sha256') == digest and meta.get('bytes') == size, 'NODE_BYTES')
    return True


def build_config(packet, approval, manifest, *, execute, setup_script, collision_query, role_setting_query,
                 nonces, correlation_id):
    return {
        'execute': execute is True, 'work_dir': packet['work_dir'], 'state_dir': packet['state_dir'],
        'source_root': HERE, 'node_path': packet['node_path'], 'age_path': packet['age_path'],
        'age_sha256': packet['age_sha256'], 'recipient_path': packet['recipient_path'],
        'recipient_sha256': packet['recipient_sha256'], 'image': packet['image'],
        'config_digest': packet['config_digest'], 'endpoint_port': packet['endpoint_port'],
        'approval': approval, 'binding': _read_json(packet['binding_path']),
        'closure_evidence': _read_json(packet['closure_evidence_path']),
        'closure_offline_index': _read_json(packet['closure_index_path']),
        'source_manifest': dict(manifest), 'client_artifacts': _read_json(packet['client_artifacts_path']),
        'setup_script': setup_script, 'setup_sha256': SETUP_SHA256, 'collision_query': collision_query,
        'role_setting_query': role_setting_query, 'preload_query': PRELOAD_QUERY, 'supautils_query': SUPAUTILS_QUERY,
        'nonces': nonces, 'correlation_id': correlation_id,
    }


def exit_code_for(result):
    return 0 if result.get('status') == 'CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED' else 3


def _on_sigterm(signum, frame):
    # N6: the first signal starts an orderly abort; later ones must not interrupt teardown or the seal.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    raise TerminationRequested()


def rehearse(packet_path):
    packet = check_packet(_read_json(packet_path), REHEARSAL_PACKET_KEYS)
    approval = _read_json(packet['approval_path'])
    manifest = approved_manifest(approval, _read_json(packet['binding05_path']))
    verified = verify_files(manifest)
    signal.signal(signal.SIGTERM, _on_sigterm)
    signal.signal(signal.SIGINT, _on_sigterm)
    mods = {name: load_verified(name, filename, verified) for name, filename in PYTHON_MODULES}
    # F2: the rehearsal approval itself is checked before anything executes (Node, age, Docker).
    mods['rehearsal'].validate_rehearsal_approval(approval, source_manifest=manifest,
                                                  hasher=lambda b: hashlib.sha256(b).hexdigest(),
                                                  now=mods['live_ops'].utc_micros())
    import platform
    mods['live_ops'].require_runner(system=platform.system(), machine=platform.machine(), env=dict(os.environ),
                                    execute=True)
    verify_node(packet['node_path'], _read_json(packet['client_artifacts_path']), mods['live_ops'].hash_file)
    _, _, role_settings = fixture_sql_constants(packet['node_path'], verified['fixture-sql.mjs'])
    config = {
        'execute': True, 'work_dir': packet['work_dir'], 'source_root': HERE, 'node_path': packet['node_path'],
        'age_path': packet['age_path'], 'age_sha256': packet['age_sha256'], 'recipient_path': packet['recipient_path'],
        'recipient_sha256': packet['recipient_sha256'], 'image': packet['image'], 'config_digest': packet['config_digest'],
        'endpoint_port': packet['endpoint_port'], 'approval': approval, 'source_manifest': dict(manifest),
        'role_setting_query': role_settings, 'preload_query': PRELOAD_QUERY, 'supautils_query': SUPAUTILS_QUERY,
    }
    ops = rehearsal_ops(mods['live_ops'].build_live_ops(config, contract=mods['runtime_contract']))
    report = mods['rehearsal'].run_rehearsal(config, ops, {
        'contract': mods['runtime_contract'], 'loaded_library': mods['loaded_library'],
        'crash_patterns': mods['validate_evidence'].CRASH_PATTERNS,
        'allowed_severities': mods['validate_evidence'].ALLOWED_SEVERITIES,
        'text_fields': mods['validate_evidence'].TEXT_FIELDS})
    sys.stdout.write(json.dumps({k: report.get(k) for k in ('status', 'phase', 'failure', 'checks', 'residue', 'cleanup',
                                                            'secret_removal_failures', 'attempt_consumed',
                                                            'historical_status', 'seal')},
                                indent=2, sort_keys=True) + '\n')
    return 0 if report['status'] == 'REHEARSAL_PASSED' else 3


def rehearsal_ops(ops):
    """The live bundle minus everything that could consume the attempt or touch a fixture."""
    trimmed = {k: v for k, v in ops.items() if k not in NOT_FOR_REHEARSAL}
    _need(not any(k in trimmed for k in NOT_FOR_REHEARSAL), 'REHEARSAL_OPS')
    return trimmed


def main(argv):
    if argv[:1] == ['--rehearse']:
        _need(len(argv) == 2, 'USAGE')
        return rehearse(argv[1])
    _need('--rehearse' not in argv, 'USAGE')
    execute = '--execute' in argv
    args = [a for a in argv if a != '--execute']
    _need(len(args) == 1, 'USAGE')
    packet = check_packet(_read_json(args[0]))
    approval = _read_json(packet['approval_path'])
    manifest = approved_manifest(approval, _read_json(packet['binding05_path']))
    verified = verify_files(manifest)
    if not execute:
        sys.stdout.write(json.dumps({'would_bind': sorted(verified), 'execute': False,
                                     'historical_status': 'NOT_REPRODUCED'}, indent=2) + '\n')
        return 0
    signal.signal(signal.SIGTERM, _on_sigterm)
    signal.signal(signal.SIGINT, _on_sigterm)
    mods = {name: load_verified(name, filename, verified) for name, filename in PYTHON_MODULES}
    # F2: the attempt approval (and its binding/closure evidence) is checked before anything executes.
    mods['runtime_executor'].validate_execution_authorization(
        approval, _read_json(packet['binding_path']), _read_json(packet['closure_evidence_path']), execute_flag=True)
    import platform
    # The runner guard comes first: nothing (not even Node) executes on a host that cannot run the attempt.
    mods['live_ops'].require_runner(system=platform.system(), machine=platform.machine(), env=dict(os.environ),
                                    execute=True)
    verify_node(packet['node_path'], _read_json(packet['client_artifacts_path']), mods['live_ops'].hash_file)
    setup, collision, role_settings = fixture_sql_constants(packet['node_path'], verified['fixture-sql.mjs'])
    config = build_config(packet, approval, manifest, execute=True, setup_script=setup, collision_query=collision,
                          role_setting_query=role_settings, nonces=[secrets.token_hex(16) for _ in range(3)],
                          correlation_id=secrets.token_hex(16))
    rc = mods['runtime_contract']
    ops = mods['live_ops'].build_live_ops(config, contract=rc)    # refuses off Linux/amd64 or with overrides
    result = mods['runtime_executor'].run_attempt(config, ops, {
        'contract': rc, 'read_closure': rc.read_startup_closure,
        'loaded_library': mods['loaded_library'].validate_loaded_library,
        'validate_log': mods['validate_evidence'].validate_log_interval,
        'assemble': mods['validate_evidence'].assemble_result})
    sys.stdout.write(json.dumps({k: result.get(k) for k in ('status', 'historical_status', 'r3_status', 'phase',
                                                            'failure', 'closure_status', 'findings', 'cleanup',
                                                            'secret_removal_failures', 'seal')},
                                indent=2, sort_keys=True) + '\n')
    return exit_code_for(result)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except BaseException as exc:  # code only — never a message that could carry a path secret or URL
        if isinstance(exc, SystemExit):
            raise
        code = getattr(exc, 'code', None)
        sys.stderr.write((code if isinstance(code, str) else 'ENTRY_' + type(exc).__name__) + '\n')
        sys.exit(1)
