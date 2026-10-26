#!/usr/bin/env python3
"""db-candidate05/runtime_executor.py — private offline preparation. NOT an execution authorization.

The owner-approved runtime executor that drives the SINGLE live DB attempt end to end on a disposable
Linux/amd64 runner. Every live operation (Docker, psql inside the container, spawning the Node candidate,
reading /proc via docker exec, sealing) is an INJECTED callable in the `ops` bundle; everything here is
pure orchestration + validation and is tested with fakes. Nothing runs live on import or in tests, and
there is no CLI that touches Docker/DB/network.

It reuses candidate03's composition plan (runtime_contract.plan_*) but applies an ENUMERATED set of
deviations that the now-captured image startup closure proves necessary (each one is listed in
`build_run_plan()['deviations']` with its evidence and is covered by a test):

  D1 network      candidate03 creates `--internal`; Docker does not publish ports for internal
                  networks, so the host-side candidate could not reach 127.0.0.1:<port>. We create a
                  dedicated NON-internal bridge (egress is then not blocked at network level — an owner
                  decision recorded in the addendum) and VERIFY the 127.0.0.1-only mapping with
                  `docker port` before any SQL.
  D2 config vol   pgsodium is in shared_preload_libraries and its getkey script writes
                  /etc/postgresql-custom/pgsodium_root.key on first start; with candidate03's
                  `--read-only` root the server would not start. A dedicated named volume at
                  /etc/postgresql-custom (Docker seeds an empty named volume from the image content, so
                  supautils.conf etc. are the image's own bytes) makes only that directory writable.
  D3 log instr.   logging.conf sets logging_collector = off (stderr text); validate-evidence.py needs
                  jsonlog. Explicit, reviewed instrumentation on the image's own CMD
                  (`postgres -D /etc/postgresql` + -c logging_collector=on, log_destination=jsonlog,
                  log_directory on a tmpfs, rotation disabled). Plan 01 section 6 allows this only as
                  explicit instrumentation; it does not touch supautils or role handling.
  D4 placeholders `--env-file` and `--publish` placeholders are materialized; any leftover `<…>`
                  refuses.
  D5 auth route   host-originated connections reach Postgres from the bridge subnet, where pg_hba is
                  scram-sha-256 (loopback trust only applies INSIDE the container). So the probe gets a
                  real high-entropy password, set with the image's own `psql \\password` (client-side
                  SCRAM verifier) over the local socket as supabase_admin (`local all supabase_admin
                  trust`; supabase_admin has log_statement=none from the image migrations, so neither the
                  setup nor the verifier is statement-logged). No SCRAM implementation here.
  D6 log interval migrate.sh runs `create role postgres … password '$PGPASSWORD'` at init with
                  log_statement=ddl, so the init-phase log holds the bootstrap password. Only the byte
                  interval AFTER the accepted-ready baseline is ever retained; the file itself lives on a
                  container tmpfs destroyed at teardown.
  D7 preload      supautils is loaded by session_preload_libraries = 'supautils' (postgresql.conf), NOT
                  shared_preload_libraries. The preload fact requires supautils exactly once in the
                  EFFECTIVE session_preload_libraries; the loaded-library observer checks backend lanes
                  A/B/C (the postmaster does not map a session-preloaded library).

Historical status stays NOT_REPRODUCED; R3 stays OPEN; a candidate PASS tops out at the review ceiling.
"""
from __future__ import annotations

import json
import re

HEX32 = re.compile(r'^[a-f0-9]{32}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')
CONTAINER_ID = re.compile(r'^[a-f0-9]{64}$')
MANIFEST_NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
UTC_MICROS = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$')
CONTAINER_ONLY = ('shared_preload_libraries', 'supautils_gucs')
APPROVAL_KEYS = frozenset({'purpose', 'attempt_id', 'owner_decision_sha256', 'source_manifest_sha256',
                           'client_artifacts_sha256', 'criterion', 'historical_status', 'r3_status',
                           'issued_at_utc', 'single_attempt'})
BOOTSTRAP_ROLE = 'supabase_admin'
PROBE_ROLE = 'regress_r3_probe'
TARGET_ROLE = 'regress_r3_target'
DATABASE = 'regress_r3_candidate'
IMAGE_CMD = ('postgres', '-D', '/etc/postgresql')              # verified image config Cmd
CONFIG_VOLUME = 'tonyai-r3-db-candidate-config'
# D8: the image runs its entrypoint as root (config User unset) and, before dropping to postgres, runs
# `find /var/run/postgresql \! -user postgres -exec chown postgres` under `set -Eeo pipefail`; with
# --cap-drop ALL there is no CAP_CHOWN, so the socket directory must already belong to postgres.
# uid/gid from the image's /etc/passwd and /etc/group (postgres:x:100:101, group postgres:x:101).
POSTGRES_UID, POSTGRES_GID = 100, 101
SOCKET_TMPFS = ('/run/postgresql:rw,nosuid,nodev,size=16m,uid=%d,gid=%d,mode=3775' % (POSTGRES_UID, POSTGRES_GID))
BASE_SOCKET_TMPFS = '/var/run/postgresql:rw,nosuid,nodev,size=16m'   # candidate03's value (/var/run -> ../run)
CONFIG_DIR = '/etc/postgresql-custom'
LOG_DIR = '/var/log/postgresql-r3'
LOG_FILE = LOG_DIR + '/r3.json'
STDERR_LOG_FILE = LOG_DIR + '/r3.log'   # collector's plain-stderr file; must not grow during the interval
LOG_CAP_BYTES = 16 * 1024 * 1024
LOG_INSTRUMENTATION = (
    '-c', 'logging_collector=on', '-c', 'log_destination=jsonlog', '-c', 'log_directory=' + LOG_DIR,
    '-c', 'log_filename=r3.log', '-c', 'log_rotation_age=0', '-c', 'log_rotation_size=0',
    '-c', 'log_file_mode=0600',
)
APPLICATION_NAMES = {'A': 'r3_candidate_a', 'B': 'r3_candidate_b', 'C': 'r3_candidate_c'}
LIBRARY_PATH = '/nix/store/7w7xzipk4v025ip0gpw4isfqxliq26mh-supautils/lib/supautils.so'
RECEIPT_PATH = '/nix/store/8iibnmg3hkijs2nyzs5fmfmj8wkia6vs-receipt/receipt.json'
# B1/B2: the init-time temporary server listens on the socket only (listen_addresses=''); the real one
# does not. pg_current_logfile proves which jsonlog file the collector writes. UTC so the start time
# text matches the driver's identity query (which runs after SET LOCAL TIME ZONE 'UTC').
READY_QUERY = ("SET TIME ZONE 'UTC';\n"
               "SELECT current_setting('listen_addresses') <> '', coalesce(pg_current_logfile('jsonlog'), ''), "
               "pg_postmaster_start_time()::text;\n")
# D5: supabase_admin's statements must not be statement-logged before setup/\\password run as it.
# Effective values in a supabase_admin session on database postgres (covers role-wide, role-in-database
# and server settings at once): no statement text, no audit line, no duration-triggered statement log.
ADMIN_LOG_QUERY = ("SELECT current_setting('log_statement'), coalesce(current_setting('pgaudit.log', true), ''), "
                   "current_setting('log_min_duration_statement');\n")
# M2: effective values pinned from the image's own bytes (postgresql.conf e37c57d8…, supautils.conf 06cb09b9…).
REFERENCE_CONF_SHA256 = {
    'postgresql_conf': 'e37c57d83ac74ab1ae8f160cbd1b283e8b1fa5cb69b8c3b89b5eb87ba860706c',
    'supautils_conf': '06cb09b9a87f34ff72576ec857ac5f0e7ba74ff8e35210772ccee7e81028410f',
}
_PG_CONF = '/etc/postgresql/postgresql.conf'
_SU_CONF = '/etc/postgresql-custom/supautils.conf'
EXPECTED_EFFECTIVE = {
    'local_preload_libraries': ([], 'default', ''),
    'session_preload_libraries': (['supautils'], 'configuration file', _PG_CONF),
    'shared_preload_libraries': (['pg_stat_statements', 'pgaudit', 'plpgsql', 'plpgsql_check', 'pg_cron', 'pg_net',
                                  'pgsodium', 'auto_explain', 'pg_tle', 'plan_filter', 'supabase_vault'],
                                 'configuration file', _PG_CONF),
    'supautils.privileged_extensions_superuser': (['supabase_admin'], 'configuration file', _SU_CONF),
    'supautils.privileged_role': (['supabase_privileged_role'], 'configuration file', _SU_CONF),
    'supautils.reserved_memberships': (['pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program',
                                        'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin',
                                        'supabase_read_only_user', 'supabase_realtime_admin', 'supabase_replication_admin',
                                        'supabase_etl_admin', 'dashboard_user', 'pgbouncer', 'authenticator'],
                                       'configuration file', _SU_CONF),
    'supautils.reserved_roles': (['supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin',
                                  'supabase_read_only_user', 'supabase_realtime_admin', 'supabase_replication_admin',
                                  'supabase_etl_admin', 'dashboard_user', 'pgbouncer', 'service_role*', 'authenticator*',
                                  'authenticated*', 'anon*', 'supabase_privileged_role'],
                                 'configuration file', _SU_CONF),
}
REQUIRED_ARTIFACT_SUFFIXES = ('/client/index.js', '/client/package.json', '/client/schema.prisma',
                              '/client/runtime/library.js', '/client/libquery_engine-debian-openssl-3.0.x.so.node')
ISO_APPROVAL = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$')
# Files that must NEVER enter retained evidence or the seal (credentials and secret-bearing inputs).
SECRET_FILES = ('inputs/credential.json', 'inputs/postgres.env', 'inputs/probe-password')
EVIDENCE_ALLOWLIST = (
    'inputs/approval.json', 'inputs/receipt.json', 'inputs/binding.json', 'inputs/manifest.json',
    'inputs/client-artifacts.json', 'live/shared_preload_libraries.json', 'live/supautils_gucs.json',
    'candidate/candidate-events.jsonl', 'candidate/candidate-result.json', 'candidate/candidate-failure.json',
    'loaded-library.json',
    'log-interval-meta.json', 'server-log.bounded', 'closure.json', 'executor-result.json',
)


class ExecutorRefusal(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _check(cond, code):
    if not cond:
        raise ExecutorRefusal(code)


def safe_code(exc):
    """A failure code that can never carry a message (which might hold a URL/password)."""
    code = getattr(exc, 'code', None)
    if isinstance(code, str) and re.fullmatch(r'[A-Za-z0-9_:.\-]{1,96}', code):
        return code
    return 'UNEXPECTED_' + type(exc).__name__


# ===================================================================================================
# Gate 1 — execution authorization.
# ===================================================================================================
def validate_execution_authorization(approval, binding, closure_evidence, *, execute_flag):
    _check(execute_flag is True, 'NO_EXECUTE_FLAG')
    _check(isinstance(approval, dict) and set(approval) == APPROVAL_KEYS, 'APPROVAL_SHAPE')
    _check(approval['purpose'] == 'ONE_ISOLATED_DB_CANDIDATE', 'APPROVAL_PURPOSE')
    _check(approval['criterion'] == 'REPLACEMENT_REGRESSION_NOT_HISTORICAL', 'APPROVAL_CRITERION')
    _check(approval['historical_status'] == 'NOT_REPRODUCED', 'APPROVAL_HISTORICAL')
    _check(approval['r3_status'] == 'OPEN', 'APPROVAL_R3')
    _check(approval['single_attempt'] is True, 'APPROVAL_SINGLE_ATTEMPT')
    attempt = approval['attempt_id']
    _check(isinstance(attempt, str) and bool(HEX32.match(attempt)), 'APPROVAL_ATTEMPT')
    _check(isinstance(binding, dict) and binding.get('attempt_id') == attempt, 'BINDING_ATTEMPT')
    _check(isinstance(approval['owner_decision_sha256'], str) and bool(HEX64.match(approval['owner_decision_sha256']))
           and approval['owner_decision_sha256'] == binding.get('owner_decision_sha256'), 'OWNER_DECISION')
    _check(isinstance(closure_evidence, dict), 'CLOSURE_EVIDENCE_SHAPE')
    summary = closure_evidence.get('summary') or {}
    _check(summary.get('oci_closure_status') == 'OCI_CLOSURE_VERIFIED', 'CLOSURE_OCI')
    _check(summary.get('config_digest') == binding.get('config_digest') and binding.get('config_digest'), 'CLOSURE_CONFIG')
    _check(sorted(summary.get('facts_missing') or []) == sorted(CONTAINER_ONLY), 'CLOSURE_MISSING_SET')
    _check(summary.get('historical_status') == 'NOT_REPRODUCED' and summary.get('r3_status') == 'OPEN', 'CLOSURE_STATUS')
    return attempt


def js_canonical(value):
    """The exact canonical JSON entrypoint.mjs hashes (sorted keys, no whitespace, JSON.stringify scalars)."""
    if isinstance(value, list):
        return '[' + ','.join(js_canonical(v) for v in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + js_canonical(value[k]) for k in sorted(value)) + '}'
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def preflight_bindings(approval, binding, source_manifest, *, image, config_digest, hasher):
    """Every hash binding entrypoint.mjs will check, checked HERE first — before the attempt is consumed
    or any container exists — so a mismatched packet cannot burn the single attempt."""
    for key in ('attempt_id', 'owner_decision_sha256', 'client_artifacts_sha256', 'image', 'config_digest'):
        _check(key in binding, 'BINDING_KEY:' + key)
    _check(binding['image'] == image and binding['config_digest'] == config_digest, 'BINDING_IMAGE')
    # Same rules as manifest.mjs requireManifest (flat ASCII names, no '..', 1..64 entries), so nothing
    # entrypoint.mjs would refuse later can pass here and burn the attempt.
    _check(isinstance(source_manifest, dict) and 1 <= len(source_manifest) <= 64
           and all(isinstance(k, str) and MANIFEST_NAME.match(k) and '..' not in k for k in source_manifest)
           and all(isinstance(v, str) and HEX64.match(v) for v in source_manifest.values()), 'SOURCE_MANIFEST_SHAPE')
    _check(hasher(js_canonical(source_manifest).encode()) == approval['source_manifest_sha256'], 'APPROVAL_SOURCE_MANIFEST')
    _check(bool(HEX64.match(binding['client_artifacts_sha256'] or ''))
           and approval['client_artifacts_sha256'] == binding['client_artifacts_sha256'], 'APPROVAL_CLIENT_ARTIFACTS')
    return True


# ===================================================================================================
# Composition with the enumerated deviations D1–D4 (argv only; ops run them).
# ===================================================================================================
def build_run_plan(contract, *, port, env_file):
    _check(isinstance(port, int) and 1024 <= port <= 65535, 'PORT_RANGE')
    _check(isinstance(env_file, str) and env_file.startswith('/') and '<' not in env_file, 'ENV_FILE_PATH')
    base_net = contract.plan_create_network()
    _check('--internal' in base_net, 'BASE_NETWORK_SHAPE')
    network = [a for a in base_net if a != '--internal']                                   # D1
    run = []
    for arg in contract.plan_run_container():
        if arg == BASE_SOCKET_TMPFS:
            arg = SOCKET_TMPFS                                                              # D8
        elif arg.startswith('<PRIVATE_0600_ENV_FILE:'):
            arg = env_file                                                                  # D4
        elif arg == '127.0.0.1:<EPHEMERAL_PORT>:5432':
            arg = '127.0.0.1:%d:5432' % port                                               # D4
        run.append(arg)
    image = run.pop()
    _check(image == contract.IMAGE, 'BASE_RUN_IMAGE')
    run += ['--volume', CONFIG_VOLUME + ':' + CONFIG_DIR,                                   # D2
            '--tmpfs', LOG_DIR + ':rw,nosuid,nodev,noexec,size=32m,uid=%d,gid=%d,mode=0700'
            % (POSTGRES_UID, POSTGRES_GID)]                                                  # D3 (+D8 owner)
    run += ['--label', 'tonyai.r3.attempt=db-candidate05', image, *IMAGE_CMD, *LOG_INSTRUMENTATION]  # D3
    _check(not any('<' in a or '>' in a for a in run + network), 'PLACEHOLDER_LEFT')
    _check(SOCKET_TMPFS in run and BASE_SOCKET_TMPFS not in run, 'SOCKET_TMPFS_NOT_OWNED')
    # The client's own `docker --host unix:///var/run/docker.sock` talks to the daemon; what must never
    # happen is the socket MOUNTED into the container, host networking, or --privileged.
    mounts = [run[i + 1] for i, a in enumerate(run[:-1]) if a in ('-v', '--volume', '--mount')]
    mounts += [a.split('=', 1)[1] for a in run if a.startswith(('--volume=', '--mount='))]
    mounts += [a[2:] for a in run if a.startswith('-v') and a not in ('-v',) and not a.startswith('--')]
    cap_adds = [run[i + 1] for i, a in enumerate(run[:-1]) if a == '--cap-add'] + \
               [a.split('=', 1)[1] for a in run if a.startswith('--cap-add=')]
    _check(not any(a == '--privileged' or a.startswith('--privileged=') for a in run)
           and run.count('--network') == 1 and run[run.index('--network') + 1] not in ('host', 'none')
           # exact tokens or '=' forms only: '--pids-limit' is a required limit, not '--pid'
           and not any(a.startswith(('--network=', '--net=', '--pid=', '--ipc=', '--uts=', '--userns=',
                                     '--cgroupns=', '--device')) for a in run)
           and not any(a in ('--net', '--pid', '--ipc', '--uts', '--userns', '--cgroupns') for a in run)
           and sorted(cap_adds) == ['SETGID', 'SETUID']
           and [run[i + 1] for i, a in enumerate(run[:-1]) if a == '--security-opt'] == ['no-new-privileges']
           and not any(a.startswith('--security-opt=') for a in run)
           and not any('docker.sock' in m for m in mounts), 'RUN_NOT_HARDENED')
    _check(run[run.index('--publish') + 1].startswith('127.0.0.1:'), 'PUBLISH_NOT_LOOPBACK')
    config_volume = list(contract.DOCKER) + ['volume', 'create', '--label', 'tonyai.r3=db-candidate', CONFIG_VOLUME]
    return {
        'create_network': network, 'create_volume': contract.plan_create_volume(),
        'create_config_volume': config_volume, 'run_container': run,
        'port_check': list(contract.DOCKER) + ['port', contract.CONTAINER_NAME, '5432/tcp'],
        'teardown': teardown_plan(contract),
        'deviations': ['D1-non-internal-network', 'D2-config-volume', 'D3-jsonlog-instrumentation',
                       'D4-placeholders-materialized', 'D8-postgres-owned-tmpfs'],
    }


def teardown_plan(contract):
    d = list(contract.DOCKER)
    return [d + ['stop', '--timeout', '30', contract.CONTAINER_NAME],
            d + ['rm', '--volumes', contract.CONTAINER_NAME],
            d + ['network', 'rm', contract.NETWORK_NAME],
            d + ['volume', 'rm', contract.VOLUME_NAME],
            d + ['volume', 'rm', CONFIG_VOLUME]]


def verify_port_mapping(text, port):
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    _check(lines == ['127.0.0.1:%d' % port], 'PORT_MAPPING')
    return True


def verify_image_identity(inspect_json, container_image, *, expect_config_digest, expect_image_ref):
    _check(isinstance(inspect_json, dict), 'IMAGE_INSPECT_SHAPE')
    _check(inspect_json.get('id') == expect_config_digest, 'IMAGE_ID')
    _check(inspect_json.get('os') == 'linux' and inspect_json.get('architecture') == 'amd64', 'IMAGE_PLATFORM')
    repo = inspect_json.get('repoDigests') or []
    _check(isinstance(repo, list) and expect_image_ref in repo, 'IMAGE_REPO_DIGEST')
    _check(container_image == expect_config_digest, 'CONTAINER_IMAGE')
    return True


# ===================================================================================================
# Bootstrap SQL (supabase_admin over the local socket) and the two live closure facts (D5, D7).
# ===================================================================================================
def interpret_collision(text):
    line = [ln for ln in text.splitlines() if ln.strip() != '']
    _check(len(line) == 1, 'COLLISION_CARDINALITY')
    parts = line[0].split('|')
    _check(len(parts) == 2 and all(p.strip().isdigit() for p in parts), 'COLLISION_SHAPE')
    _check(parts[0].strip() == '0' and parts[1].strip() == '0', 'COLLISION_PRESENT')
    return True


def check_setup_script(setup_script, setup_sha256, *, hasher):
    _check(isinstance(setup_script, str) and setup_script.strip() != '', 'SETUP_EMPTY')
    _check(isinstance(setup_sha256, str) and bool(HEX64.match(setup_sha256)), 'SETUP_SHA_FORMAT')
    _check(hasher(setup_script.encode()) == setup_sha256, 'SETUP_SHA')
    _check('PASSWORD' not in setup_script.upper(), 'SETUP_CARRIES_PASSWORD')
    return True


def _split_list(value):
    return [p.strip() for p in value.split(',') if p.strip() != '']


def parse_preload_rows(text):
    """pg_settings rows for the three preload GUCs, -qAt with '|' separators:
    name|setting|source|sourcefile. D7: supautils must appear exactly once in the EFFECTIVE
    session_preload_libraries. Returns {name: {setting, list, source, sourcefile}}."""
    _check(isinstance(text, str), 'PRELOAD_TYPE')
    rows = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split('|')
        _check(len(fields) == 4, 'PRELOAD_FIELDS')
        name, setting, source, sourcefile = fields
        _check(name in ('local_preload_libraries', 'session_preload_libraries', 'shared_preload_libraries'), 'PRELOAD_NAME')
        _check(name not in rows, 'PRELOAD_DUPLICATE')
        rows[name] = {'setting': setting, 'list': _split_list(setting), 'source': source, 'sourcefile': sourcefile}
    _check(set(rows) == {'local_preload_libraries', 'session_preload_libraries', 'shared_preload_libraries'}, 'PRELOAD_SET')
    _check(rows['session_preload_libraries']['list'].count('supautils') == 1, 'SUPAUTILS_NOT_SESSION_PRELOADED_ONCE')
    return rows


def parse_supautils_gucs(text):
    _check(isinstance(text, str), 'GUC_TYPE')
    rows = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split('|')
        _check(len(fields) == 4, 'GUC_FIELDS')
        name, setting, source, sourcefile = fields
        _check(name.startswith('supautils.'), 'GUC_NOT_SUPAUTILS')
        _check(name not in rows, 'GUC_DUPLICATE')
        rows[name] = {'setting': setting, 'source': source, 'sourcefile': sourcefile}
    for key in ('supautils.reserved_roles', 'supautils.reserved_memberships', 'supautils.privileged_role'):
        _check(key in rows, 'GUC_MISSING:' + key)
    return rows


def role_matches(pattern, role):
    """supautils reserved-role entries are names, optionally with a trailing '*' prefix wildcard."""
    pattern = pattern.strip()
    if pattern.endswith('*'):
        return role.startswith(pattern[:-1])
    return role == pattern


def assert_fixture_not_reserved(gucs):
    for key in ('supautils.reserved_roles', 'supautils.reserved_memberships', 'supautils.privileged_role',
                'supautils.superuser', 'supautils.privileged_extensions_superuser'):
        value = gucs.get(key, {}).get('setting', '')
        for entry in _split_list(value):
            for role in (PROBE_ROLE, TARGET_ROLE):
                _check(not role_matches(entry, role), 'FIXTURE_RESERVED_COLLISION:' + role)
    return True


# ===================================================================================================
# Loaded-library observation via docker exec (D7: backend lanes only).
# ===================================================================================================
def library_record_from_exec(stat_before, sha_out, stat_after, *, path, expected_size_cap):
    """stat_* are `stat -c '%F|%d|%i|%s'` (NO -L, so a symlink reports 'symbolic link' and refuses);
    sha_out is `sha256sum <path>`. Builds the record loaded-library.py validates."""
    def parse_stat(text):
        parts = text.strip().split('|')
        _check(len(parts) == 4, 'LIB_STAT_SHAPE')
        ftype, dev, ino, size = parts
        _check(dev.isdigit() and ino.isdigit() and size.isdigit(), 'LIB_STAT_NUMBERS')
        return ftype, int(dev), int(ino), int(size)
    ftype, dev, ino, size = parse_stat(stat_before)
    a_ftype, a_dev, a_ino, a_size = parse_stat(stat_after)
    _check(ftype == 'regular file', 'LIB_NOT_REGULAR')
    fields = sha_out.strip().split()
    _check(len(fields) == 2 and bool(HEX64.match(fields[0])) and fields[1] == path, 'LIB_SHA_SHAPE')
    _check(size <= expected_size_cap, 'LIB_SIZE_CAP')
    return {'path': path, 'realpath': path, 'opened_nofollow': True, 'file_type': 'regular',
            'st_dev': dev, 'st_ino': ino, 'st_size': size, 'sha256': fields[0], 'bytes_hashed': size,
            'truncated': False, 'fstat_after_hash': {'st_dev': a_dev, 'st_ino': a_ino, 'st_size': a_size}}


def service_one_attestation(lane, request, ops):
    _check(lane in ('A', 'B', 'C') and request.get('lane') == lane, 'ATTEST_LANE')
    pid, nonce = request.get('pid'), request.get('nonce')
    _check(isinstance(pid, int) and pid > 0 and isinstance(nonce, str) and bool(HEX32.match(nonce)), 'ATTEST_REQUEST')
    maps = ops['read_maps'](pid)
    _check(isinstance(maps, str) and maps, 'ATTEST_MAPS')
    return {'lane': lane, 'phase': {'A': 'baseline-A', 'B': 'baseline-B', 'C': 'fresh-C'}[lane],
            'pid': pid, 'nonce': nonce, 'maps': maps}


# ===================================================================================================
# Receipt + descriptor for the Node harness (inputs/ vs an EMPTY candidate/ output dir).
# ===================================================================================================
RECEIPT_KEYS = ('purpose', 'attempt_id', 'image', 'config_digest', 'platform', 'container_id', 'endpoint_host',
                'endpoint_port', 'database', 'probe_role', 'loaded_library_ref', 'startup_closure_status',
                'prepared_at_utc')


def build_receipt(*, attempt, image, config_digest, container_id, port, closure_status, prepared_at_utc):
    _check(bool(CONTAINER_ID.match(container_id or '')), 'RECEIPT_CONTAINER')
    _check(closure_status == 'CLOSED_FROM_RETAINED_EVIDENCE', 'RECEIPT_CLOSURE_NOT_CLOSED')
    return {'purpose': 'ONE_ISOLATED_DB_CANDIDATE', 'attempt_id': attempt, 'image': image,
            'config_digest': config_digest, 'platform': 'linux/amd64', 'container_id': container_id,
            'endpoint_host': '127.0.0.1', 'endpoint_port': port, 'database': DATABASE, 'probe_role': PROBE_ROLE,
            'loaded_library_ref': 'loaded-library.json', 'startup_closure_status': closure_status,
            'prepared_at_utc': prepared_at_utc}


def build_descriptor(work, source_root, nonces, *, candidate_deadline_ms=120000, attest_timeout_ms=8000):
    _check(isinstance(nonces, list) and len(nonces) == 3 and len(set(nonces)) == 3
           and all(isinstance(n, str) and HEX32.match(n) for n in nonces), 'NONCES')
    return {'outputDir': work + '/candidate', 'sourceRoot': source_root,
            'approvalPath': work + '/inputs/approval.json', 'receiptPath': work + '/inputs/receipt.json',
            'bindingPath': work + '/inputs/binding.json', 'sourceManifestPath': work + '/inputs/manifest.json',
            'clientArtifactsPath': work + '/inputs/client-artifacts.json',
            'credentialPath': work + '/inputs/credential.json', 'nonces': nonces,
            'deadlineMs': candidate_deadline_ms, 'attestTimeoutMs': attest_timeout_ms}


# ===================================================================================================
# D6 — retain only the log interval after the accepted-ready baseline.
# ===================================================================================================
def build_log_meta(*, correlation_id, start_utc, end_utc, offset_start, offset_end, inode_start, inode_end,
                   container_before, container_after):
    _check(isinstance(offset_start, int) and isinstance(offset_end, int) and 0 <= offset_start <= offset_end, 'LOG_OFFSETS')
    # validate-evidence.py requires microsecond UTC ('2026-10-26T10:00:00.000000Z'); refuse early here.
    for stamp in (start_utc, end_utc):
        _check(isinstance(stamp, str) and bool(UTC_MICROS.match(stamp)), 'LOG_UTC_FORMAT')
    _check(start_utc < end_utc, 'LOG_UTC_ORDER')
    captured = offset_end - offset_start
    return {'format': 'jsonlog', 'correlation_id': correlation_id, 'interval_start_utc': start_utc,
            'interval_end_utc': end_utc, 'captured_bytes': min(captured, LOG_CAP_BYTES), 'cap_bytes': LOG_CAP_BYTES,
            'truncated': captured > LOG_CAP_BYTES, 'rotations': 0 if inode_start == inode_end else 1,
            'source_inode_start': inode_start, 'source_inode_end': inode_end,
            'offset_start': offset_start, 'offset_end': offset_end,
            'container': {'restart_count_before': container_before['restart_count'],
                          'restart_count_after': container_after['restart_count'],
                          'oom_killed': container_after['oom_killed'],
                          'started_at_before': container_before['started_at'],
                          'started_at_after': container_after['started_at'],
                          'running_after': container_after['running'],
                          'exit_code_after': container_after['exit_code']}}


# ===================================================================================================
# M1 — everything that can be checked with no side effect is checked BEFORE the attempt is consumed.
# ===================================================================================================
SETUP_SHA256 = 'a666913165af9121e9f5c960e87fea86cfd284ca4fe4ceeb1884961e5ac18a48'   # fixture-sql SETUP_SCRIPT
CLIENT_VERSION_MARKER = '"clientVersion": "6.19.3"'
ENGINE_VERSION_MARKER = '"engineVersion": "c2990dca591cba766e3b7ef5d9e8a84796e47ab7"'
ROOT_ENV_MARKER = '"rootEnvPath": null'


def preflight_client_artifacts(client_artifacts, binding, node_path, ops):
    """Mirror of entrypoint.validateClientArtifacts, run before consumption (streaming hashes)."""
    _check(isinstance(client_artifacts, dict) and client_artifacts, 'ARTIFACTS_SHAPE')
    _check(all(isinstance(p, str) and p.startswith('/') and re.fullmatch(r'[\x21-\x7e]+', p) for p in client_artifacts),
           'ARTIFACTS_PATH')
    _check(node_path in client_artifacts, 'ARTIFACTS_NODE_PATH')
    others = [p for p in client_artifacts if p != node_path]
    for suffix in REQUIRED_ARTIFACT_SUFFIXES:
        _check(len([p for p in others if p.endswith(suffix)]) == 1, 'ARTIFACTS_MISSING:' + suffix.rsplit('/', 1)[-1])
    per_file = {}
    for path, meta in client_artifacts.items():
        _check(isinstance(meta, dict) and set(meta) == {'sha256', 'bytes'} and bool(HEX64.match(meta['sha256'] or ''))
               and isinstance(meta['bytes'], int) and meta['bytes'] > 0, 'ARTIFACTS_META')
        digest, size = ops['hash_file'](path)
        _check(size == meta['bytes'] and digest == meta['sha256'], 'ARTIFACTS_BYTES:' + path.rsplit('/', 1)[-1])
        per_file[path] = digest
    _check(ops['sha256'](js_canonical(per_file).encode()) == binding['client_artifacts_sha256'], 'ARTIFACTS_BINDING')
    index_paths = [p for p in client_artifacts if p.endswith('index.js')]   # entrypoint takes the first such key
    _check(len(index_paths) == 1, 'ARTIFACTS_INDEX_AMBIGUOUS')
    index_text = ops['read_bytes'](index_paths[0]).decode('utf-8', 'replace')
    for marker, code in ((CLIENT_VERSION_MARKER, 'ARTIFACTS_CLIENT_VERSION'), (ENGINE_VERSION_MARKER, 'ARTIFACTS_ENGINE'),
                         (ROOT_ENV_MARKER, 'ARTIFACTS_ENV_PATHS'), ('"relativeEnvPaths"', 'ARTIFACTS_ENV_PATHS')):
        _check(marker in index_text, code)
    return True


def _instant(text, code):
    import datetime
    try:
        value = datetime.datetime.fromisoformat(text.replace('Z', '+00:00'))
    except ValueError:
        raise ExecutorRefusal(code)
    _check(value.tzinfo is not None, code)
    return value


def preflight_local(config, contract, ops, mods):
    approval = config['approval']
    _check(isinstance(approval.get('issued_at_utc'), str) and bool(ISO_APPROVAL.match(approval['issued_at_utc'])), 'APPROVAL_ISSUED')
    issued, now = _instant(approval['issued_at_utc'], 'APPROVAL_ISSUED'), _instant(ops['utc_now'](), 'CLOCK')
    _check(issued <= now, 'APPROVAL_FROM_THE_FUTURE')            # Node would refuse the receipt as stale
    _check(ops['port_free'](config['endpoint_port']) is True, 'PORT_IN_USE')
    _check(config['image'] == contract.IMAGE and config['config_digest'] == contract.CONFIG_DIGEST, 'IMAGE_PIN')
    _check(config.get('setup_sha256') == SETUP_SHA256, 'SETUP_PIN')
    check_setup_script(config['setup_script'], config['setup_sha256'], hasher=ops['sha256'])
    nonces, correlation = config.get('nonces'), config.get('correlation_id')
    _check(isinstance(nonces, list) and len(nonces) == 3 and len(set(nonces)) == 3
           and all(isinstance(n, str) and HEX32.match(n) for n in nonces), 'NONCES')
    _check(isinstance(correlation, str) and bool(HEX32.match(correlation)), 'CORRELATION_ID')
    index = config['closure_offline_index']
    _check(isinstance(index, dict) and not (set(index) & set(CONTAINER_ONLY)), 'CLOSURE_INDEX_OVERLAP')
    for fact, digest in REFERENCE_CONF_SHA256.items():
        _check((index.get(fact) or {}).get('sha256') == digest, 'REFERENCE_CONF:' + fact)
    offline = mods['read_closure'](index, ops['read_bytes'])
    _check(offline.status == 'OPEN_UNRESOLVED' and sorted(offline.missing) == sorted(CONTAINER_ONLY), 'OFFLINE_CLOSURE_SET')
    oci = offline.oci_closure or {}
    _check(oci.get('status') == 'OCI_CLOSURE_VERIFIED' and oci.get('config_digest') == contract.CONFIG_DIGEST, 'OFFLINE_CLOSURE_OCI')
    _check(ops['realpath'](config['node_path']) == config['node_path'], 'NODE_PATH_NOT_CANONICAL')
    preflight_client_artifacts(config['client_artifacts'], config['binding'], config['node_path'], ops)
    ops['assert_fresh_work_dir'](config['work_dir'])
    return True


def normalize_container_state(state):
    """Docker reports ExitCode 0 for a RUNNING container; validate-evidence requires None while running."""
    _check(isinstance(state, dict) and set(state) == {'restart_count', 'oom_killed', 'started_at', 'running', 'exit_code'},
           'CONTAINER_STATE_SHAPE')
    _check(isinstance(state['running'], bool) and isinstance(state['oom_killed'], bool)
           and isinstance(state['restart_count'], int) and isinstance(state['started_at'], str), 'CONTAINER_STATE_TYPES')
    out = dict(state)
    if out['running']:
        out['exit_code'] = None
    return out


# ===================================================================================================
# B1/B2, D5, M2, M4 — live checks whose outcome is earned, never assumed.
# ===================================================================================================
def interpret_ready(text):
    lines = [ln for ln in text.splitlines() if ln.strip()]
    _check(len(lines) == 1, 'READY_CARDINALITY')
    fields = lines[0].split('|')
    _check(len(fields) == 3, 'READY_SHAPE')
    real_server, logfile, started = fields
    _check(real_server == 't', 'READY_TEMP_SERVER')           # init-time server has listen_addresses=''
    _check(logfile == LOG_FILE, 'READY_JSONLOG_FILE')           # the collector writes the file we will tail
    _check(0 < len(started) <= 80, 'READY_POSTMASTER_START')
    return {'postmaster_start': started}


def interpret_admin_log(text):
    lines = [ln for ln in text.splitlines() if ln.strip()]
    _check(len(lines) == 1 and len(lines[0].split('|')) == 3, 'ADMIN_LOG_SHAPE')
    log_statement, pgaudit_log, min_duration = lines[0].split('|')
    _check(log_statement == 'none', 'ADMIN_LOG_STATEMENT_NOT_NONE')
    _check(pgaudit_log in ('', 'none'), 'ADMIN_PGAUDIT_LOGS')
    _check(min_duration == '-1', 'ADMIN_DURATION_LOGS_STATEMENTS')
    return True


def interpret_role_settings(text, phase):
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    _check(lines == ['0'], 'ROLE_SETTINGS_' + phase)
    return True


def check_expected_effective(preload, gucs):
    combined = {}
    for name, row in list(preload.items()) + list(gucs.items()):
        combined[name] = {'setting': row['setting'], 'source': row['source'], 'sourcefile': row['sourcefile']}
    for name, (values, source, sourcefile) in EXPECTED_EFFECTIVE.items():
        row = combined.get(name)
        _check(row is not None, 'EFFECTIVE_MISSING:' + name)
        _check(_split_list(row['setting']) == values and row['source'] == source and row['sourcefile'] == sourcefile,
               'EFFECTIVE_DRIFT:' + name)
    alias = combined.get('supautils.superuser')
    if alias is not None:   # alias of privileged_extensions_superuser (shared storage); the JS lane gate
        # refuses any difference, so refuse it here, before the attempt goes further
        _check(alias['setting'] == combined['supautils.privileged_extensions_superuser']['setting'],
               'EFFECTIVE_DRIFT:supautils.superuser')
    return combined


def parse_events(data):
    events = []
    for number, line in enumerate(data.decode('utf-8').splitlines(), 1):
        if not line.strip():
            continue
        event = json.loads(line)
        _check(isinstance(event, dict) and event.get('sequence') == number, 'EVENT_SEQUENCE')
        events.append(event)
    _check(events, 'EVENTS_EMPTY')
    return events


def check_lane_events(events, lanes, bootstrap, postmaster_start, nonces, driver_result):
    """M4 + identity binding: one attestation per lane, bound to the attested pid, the descriptor nonce and
    the same postmaster seen at readiness; lane GUC rows agree with the bootstrap rows."""
    expected_nonce = {'A': nonces[0], 'B': nonces[1], 'C': nonces[2]}
    by_lane = {r['lane']: r for r in lanes}
    seen = {}
    for event in events:
        kind = event.get('kind', '')
        if not kind.startswith('attestation-'):
            continue
        lane = kind[len('attestation-'):]
        _check(lane in ('A', 'B', 'C') and lane not in seen, 'ATTEST_EVENT_LANE')
        data = event.get('data') or {}
        identity = data.get('identity') or {}
        _check(data.get('lane') == lane and identity.get('pid') == by_lane[lane]['pid'], 'ATTEST_EVENT_PID')
        _check(identity.get('nonce') == expected_nonce[lane] == by_lane[lane]['nonce'], 'ATTEST_EVENT_NONCE')
        _check(identity.get('postmaster_start') == postmaster_start, 'POSTMASTER_CHANGED')
        _check(identity.get('current_user') == PROBE_ROLE and identity.get('session_user') == PROBE_ROLE
               and identity.get('database_name') == DATABASE, 'ATTEST_EVENT_IDENTITY')
        rows = data.get('gucs')
        _check(isinstance(rows, list), 'LANE_GUCS_SHAPE')
        # local_preload_libraries is PGC_USERSET and visible to any role: a lane without it did not read.
        _check(any(isinstance(r, dict) and r.get('name') == 'local_preload_libraries' for r in rows), 'LANE_GUCS_NOT_READ')
        for row in rows:
            _check(isinstance(row, dict) and row.get('sourcefile') is None, 'LANE_GUC_SOURCEFILE')
            reference = bootstrap.get(row.get('name'))
            if reference is not None:
                _check(_split_list(row.get('setting') or '') == _split_list(reference['setting'])
                       and row.get('source') == reference['source'], 'LANE_GUC_OVERRIDE:' + str(row.get('name')))
            else:
                _check(row.get('source') in ('default', 'configuration file'), 'LANE_GUC_SOURCE:' + str(row.get('name')))
        seen[lane] = True
    _check(sorted(seen) == ['A', 'B', 'C'], 'ATTEST_EVENT_SET')
    final = [e for e in events if e.get('kind') == 'result']
    _check(len(final) == 1 and (final[0].get('data') or {}).get('status') == driver_result.get('status'), 'RESULT_EVENT')
    return True


def capture_bootstrap(config, ops, phase):
    preload = parse_preload_rows(ops['psql_bootstrap'](config['preload_query'], 'preload-' + phase).decode())
    gucs = parse_supautils_gucs(ops['psql_bootstrap'](config['supautils_query'], 'supautils-' + phase).decode())
    assert_fixture_not_reserved(gucs)
    combined = check_expected_effective(preload, gucs)
    return preload, gucs, combined


# ===================================================================================================
# The single attempt. Pure orchestration over injected ops; never retries; always tears down.
# ===================================================================================================
def run_attempt(config, ops, mods):
    """mods: {'contract': runtime_contract, 'read_closure': runtime_contract.read_startup_closure,
    'loaded_library': loaded-library.validate_loaded_library, 'validate_log': validate-evidence.validate_log_interval,
    'assemble': validate-evidence.assemble_result}."""
    result = {'status': 'PARTIAL_REVIEW_REQUIRED', 'historical_status': 'NOT_REPRODUCED', 'r3_status': 'OPEN',
              'qualification': False, 'installation_success': False, 'closure_status': 'OPEN_UNRESOLVED',
              'phase': 'authorize', 'failure': None, 'findings': [], 'deviations': []}
    created, secrets_written = [], []
    work = config['work_dir']
    contract = mods['contract']
    work_ready = False                  # F2: only a work dir THIS run verified fresh is ever written to
    try:
        # ---- Phase 0: no side effects (M1) ------------------------------------------------------------
        attempt = validate_execution_authorization(config['approval'], config['binding'], config['closure_evidence'],
                                                   execute_flag=config.get('execute') is True)
        result['attempt_id'] = attempt
        preflight_bindings(config['approval'], config['binding'], config['source_manifest'],
                           image=config['image'], config_digest=config['config_digest'], hasher=ops['sha256'])
        result['phase'] = 'preflight'
        ops['host_lock']()              # F1: never alongside a rehearsal or another attempt on this host
        port = config['endpoint_port']
        plan = build_run_plan(contract, port=port, env_file=work + '/inputs/postgres.env')
        result['deviations'] = plan['deviations']
        preflight_local(config, contract, ops, mods)
        work_ready = True
        for kind, name in (('container', contract.CONTAINER_NAME), ('network', contract.NETWORK_NAME),
                           ('volume', contract.VOLUME_NAME), ('volume', CONFIG_VOLUME)):
            _check(ops['docker_object_exists'](kind, name) is False, 'DOCKER_OBJECT_EXISTS:' + name)   # M2
        ops['consume_attempt'](attempt)          # durable one-shot record BEFORE the first mutation
        # ---- Phase 1: compose --------------------------------------------------------------------------
        result['phase'] = 'compose'
        ops['write_secret'](work + '/inputs/postgres.env', 'POSTGRES_PASSWORD=' + ops['gen_secret']() + '\n')
        secrets_written.append(work + '/inputs/postgres.env')
        ops['ensure_image']()                    # explicit by-digest acquisition, never a tag/implicit pull
        for key, label in (('create_network', 'network'), ('create_volume', 'volume'),
                           ('create_config_volume', 'config-volume')):
            created.append(label)                # marked first: a half-created object is still torn down
            ops['run'](plan[key], 'create-' + label)
        created.append('container')
        container_id = ops['run'](plan['run_container'], 'run-container').decode().strip()
        _check(bool(CONTAINER_ID.match(container_id)), 'CONTAINER_ID')
        result['phase'] = 'identity'
        ident = contract.plan_image_identity_commands()
        verify_image_identity(json.loads(ops['run'](ident['inspect_image'], 'inspect-image').decode()),
                              json.loads(ops['run'](ident['inspect_container_image'], 'inspect-container').decode()),
                              expect_config_digest=config['config_digest'], expect_image_ref=config['image'])
        verify_port_mapping(ops['run'](plan['port_check'], 'port').decode(), port)
        # ---- Phase 2: the REAL server is ready (B1) and logs to the file we tail (B2) --------------------
        result['phase'] = 'ready'
        ops['wait_ready']()                      # real server on TCP inside the container + quiet log
        ready = interpret_ready(ops['psql_bootstrap'](READY_QUERY, 'ready').decode())
        container_before = normalize_container_state(ops['container_state']())
        log_start = ops['log_position']()        # D6: the retained interval starts here, after init
        # ---- Phase 3: fixture --------------------------------------------------------------------------
        result['phase'] = 'setup'
        interpret_admin_log(ops['psql_bootstrap'](ADMIN_LOG_QUERY, 'admin-log').decode())             # D5 live
        interpret_role_settings(ops['psql_bootstrap'](config['role_setting_query'], 'role-settings-before').decode(), 'BEFORE')
        preload, gucs, bootstrap = capture_bootstrap(config, ops, 'before')                         # M2/M4
        interpret_collision(ops['psql_bootstrap'](config['collision_query'], 'collision').decode())
        ops['psql_bootstrap'](config['setup_script'], 'setup')
        password = ops['gen_secret']()
        ops['set_probe_password'](password)      # image psql \password over private stdin (D5)
        # ---- Phase 4: closure --------------------------------------------------------------------------
        result['phase'] = 'closure'
        live_index = {}
        for fact, payload in (('shared_preload_libraries', preload), ('supautils_gucs', gucs)):
            data = json.dumps(payload, sort_keys=True).encode()
            path = work + '/live/' + fact + '.json'
            ops['write'](path, data)
            live_index[fact] = {'path': path, 'sha256': ops['sha256'](data)}
        merged = dict(config['closure_offline_index'])
        merged.update(live_index)
        closure = mods['read_closure'](merged, ops['read_bytes'])
        result['closure_status'] = closure.status
        ops['write'](work + '/closure.json', json.dumps(closure.to_json(), sort_keys=True).encode())
        _check(closure.status == 'CLOSED_FROM_RETAINED_EVIDENCE', 'CLOSURE_NOT_CLOSED')
        _check(contract.assemble_plan(closure)['executable'] is True, 'PLAN_NOT_EXECUTABLE')
        # ---- Phase 5: candidate ------------------------------------------------------------------------
        result['phase'] = 'candidate'
        receipt = build_receipt(attempt=attempt, image=config['image'], config_digest=config['config_digest'],
                                container_id=container_id, port=port, closure_status=closure.status,
                                prepared_at_utc=ops['utc_now']())
        ops['write'](work + '/inputs/receipt.json', json.dumps(receipt, sort_keys=True).encode())
        for name, value in (('approval', config['approval']), ('binding', config['binding']),
                            ('manifest', config['source_manifest']), ('client-artifacts', config['client_artifacts'])):
            ops['write'](work + '/inputs/' + name + '.json', json.dumps(value, sort_keys=True).encode())
        ops['write_secret'](work + '/inputs/credential.json', json.dumps(
            {'user': PROBE_ROLE, 'password': password, 'host': '127.0.0.1', 'port': port, 'database': DATABASE}))
        secrets_written.append(work + '/inputs/credential.json')
        descriptor = build_descriptor(work, config['source_root'], config['nonces'])
        ops['write'](work + '/inputs/run-descriptor.json', json.dumps(descriptor, sort_keys=True).encode())
        ops['make_empty_private_dir'](work + '/candidate')
        lanes = ops['run_candidate'](work + '/inputs/run-descriptor.json', service_one_attestation)
        _check(isinstance(lanes, list) and sorted(r['lane'] for r in lanes) == ['A', 'B', 'C']
               and len({r['pid'] for r in lanes}) == 3, 'LANE_SET')
        driver_result = json.loads(ops['read_bytes'](work + '/candidate/candidate-result.json').decode())
        _check(driver_result.get('historical_status') == 'NOT_REPRODUCED', 'DRIVER_HISTORICAL')
        # ---- Phase 6: evidence -------------------------------------------------------------------------
        result['phase'] = 'evidence'
        events = parse_events(ops['read_bytes'](work + '/candidate/candidate-events.jsonl'))
        check_lane_events(events, lanes, bootstrap, ready['postmaster_start'], config['nonces'], driver_result)
        _, _, bootstrap_after = capture_bootstrap(config, ops, 'after')
        _check(bootstrap_after == bootstrap, 'GUC_DRIFT')
        interpret_role_settings(ops['psql_bootstrap'](config['role_setting_query'], 'role-settings-after').decode(), 'AFTER')
        log_end = ops['log_position']()
        container_after = normalize_container_state(ops['container_state']())
        library = library_record_from_exec(*ops['observe_library'](LIBRARY_PATH), path=LIBRARY_PATH,
                                           expected_size_cap=16 * 1024 * 1024)
        receipt_rec = library_record_from_exec(*ops['observe_library'](RECEIPT_PATH), path=RECEIPT_PATH,
                                               expected_size_cap=1024 * 1024)
        receipt_rec = {k: receipt_rec[k] for k in ('path', 'realpath', 'opened_nofollow', 'file_type', 'st_size',
                                                    'sha256', 'bytes_hashed', 'truncated')}
        expected_lanes = {r['lane']: {'pid': r['pid'], 'nonce': r['nonce']} for r in lanes}
        lib_evidence = {'library': library, 'receipt': receipt_rec, 'lanes': lanes}
        lib_component = mods['loaded_library'](lib_evidence, expected_lanes)
        ops['write'](work + '/loaded-library.json', json.dumps({'evidence': lib_evidence, 'expected_lanes': expected_lanes,
                                                                'result': lib_component}, sort_keys=True).encode())
        meta = build_log_meta(correlation_id=config['correlation_id'], start_utc=log_start['utc_before'],
                              end_utc=log_end['utc_after'],
                              offset_start=log_start['offset'], offset_end=log_end['offset'],
                              inode_start=log_start['inode'], inode_end=log_end['inode'],
                              container_before=container_before, container_after=container_after)
        log_bytes = ops['read_log_interval'](log_start['offset'], meta['captured_bytes'])
        ops['write'](work + '/server-log.bounded', log_bytes)
        ops['write'](work + '/log-interval-meta.json', json.dumps(meta, sort_keys=True).encode())
        log_component = mods['validate_log'](log_bytes, meta, {
            'pids': {k: v['pid'] for k, v in expected_lanes.items()}, 'application_names': dict(APPLICATION_NAMES)})
        assembled = mods['assemble'](driver_result, {'manifest': {'status': 'MANIFEST_MATCH'},
                                                     'gucs': {'status': 'GUC_FIXTURE_CONSISTENT'},   # earned above
                                                     'loaded_library': lib_component, 'log_interval': log_component})
        result.update({'status': assembled['status'], 'findings': list(assembled.get('findings', [])),
                       'phase': 'complete'})
        if log_end.get('stderr_size') != log_start.get('stderr_size'):
            result['findings'].append('STDERR_LOG_GREW')          # unstructured output we cannot classify
            if result['status'] == 'CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED':
                result['status'] = 'PARTIAL_REVIEW_REQUIRED'
    except BaseException as exc:  # incl. SIGTERM/KeyboardInterrupt: always reach teardown; code only
        result['failure'] = {'phase': result['phase'], 'code': safe_code(exc)}
        result['status'] = 'PARTIAL_REVIEW_REQUIRED'
    finally:
        result['cleanup'] = run_teardown(created, contract, ops)
        if result['cleanup']['failures']:
            result['status'] = 'PARTIAL_REVIEW_REQUIRED'
        removal_failures = []
        for path in secrets_written:
            try:
                ops['remove_secret'](path)
            except BaseException:
                removal_failures.append(path.rsplit('/', 1)[-1])
        result['secret_removal_failures'] = removal_failures
        if removal_failures:
            result['status'] = 'PARTIAL_REVIEW_REQUIRED'
    _clamp(result)
    if not work_ready:
        result['seal'] = {'sealed': False, 'skipped': 'WORK_DIR_NOT_VERIFIED'}   # nothing written anywhere
        return _clamp(result)
    try:
        ops['write'](work + '/executor-result.json', json.dumps(result, sort_keys=True).encode())
        result['seal'] = ops['seal'](work, list(EVIDENCE_ALLOWLIST))
    except BaseException as exc:
        result['seal'] = {'sealed': False, 'failure': safe_code(exc)}
        result['status'] = 'PARTIAL_REVIEW_REQUIRED'
    return _clamp(result)


def _clamp(result):
    """Hard ceiling: nothing in this file can produce another disposition."""
    result['historical_status'], result['r3_status'] = 'NOT_REPRODUCED', 'OPEN'
    result['qualification'] = result['installation_success'] = False
    if result['status'] not in ('CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED', 'PARTIAL_REVIEW_REQUIRED',
                                'REJECTED_REVIEW_REQUIRED'):
        result['status'] = 'PARTIAL_REVIEW_REQUIRED'
    return result


def run_teardown(created, contract, ops):
    """Tear down exactly the objects this attempt created, in reverse dependency order. No prune."""
    if not created:
        return {'failures': [], 'skipped': True}
    failures = []
    for cmd in teardown_plan(contract):
        target = cmd[-1]
        if target == contract.CONTAINER_NAME and 'container' not in created:
            continue
        if target == contract.NETWORK_NAME and 'network' not in created:
            continue
        if target == contract.VOLUME_NAME and 'volume' not in created:
            continue
        if target == CONFIG_VOLUME and 'config-volume' not in created:
            continue
        try:
            ops['run'](cmd, 'teardown')
        except BaseException:              # incl. a second SIGTERM: record it, keep tearing down
            failures.append(target)
    return {'failures': failures, 'skipped': False}


if __name__ == '__main__':
    import sys
    sys.stderr.write('runtime_executor.py is offline preparation; it has no CLI that touches Docker/DB/network. '
                     'The owner-approved runner imports run_attempt() with real ops.\n')
    sys.exit(2)
