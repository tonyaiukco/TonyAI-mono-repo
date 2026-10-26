#!/usr/bin/env python3
"""db-candidate03/runtime_contract.py — private offline preparation. NOT an execution authorization.

Plans (does NOT run) a DB-only disposable PostgreSQL composition from the pinned supabase/postgres
image, reads the image startup closure offline from retained OCI/layer evidence if present (and reports
precisely what is missing), and plans the credential route, the per-lane loaded-library observer, the
bounded log capture, and the custody seal. Every function here is pure or dependency-injected: the only
side effects come from injected readers/runners the owner-approved execution would supply. Importing or
running this module with no injected runner does nothing to Docker, a database, the network, or the
filesystem outside an injected reader. It deliberately does NOT import or call r3_qualification.run,
ci_database_image.prepare, selfhost_db_config.main, selfhost_start, escrow or owner_psql.

Historical status stays NOT_REPRODUCED; the native runtime stays NOT_EXECUTED; R3 stays OPEN.

Run `python3 -I -B runtime_contract.py --self-check` to print the planned composition and the startup
closure status against an (optional) injected evidence root; it performs no Docker/network/DB action.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------------------------------
# Pinned policy anchors (infra/selfhost/database-image-policy.json, byte-confirmed offline 2026-10-25).
# These are declarations; observed bytes must still close the chain. Nothing here is a wildcard.
# ---------------------------------------------------------------------------------------------------
IMAGE = 'supabase/postgres@sha256:e85bc10ac5b141223b289e1e8dc8d448cf3df92501917149db0366b9c5aaf053'
IMAGE_TAG = 'supabase/postgres:17.11.0.004'
CONFIG_DIGEST = 'sha256:c4be96218454e68421a29c712e1a83c7a9fe186208c725d8bb2ebb474e2042f2'
INDEX_DIGEST = 'sha256:b15d862126dd2dac02da524696ccfde2dcce2ceaee0a58973b2727befe492706'
LAYER_DIGEST = 'sha256:b594b09cdd92842c954d3a942e0e086d18d107ae743b29eca55d4abb71f820ed'
PLATFORM = 'linux/amd64'
POSTGRESQL = '17.11'
SERVER_VERSION_NUM = '170011'
SUPAUTILS_VERSION = '3.4.4'
SUPAUTILS_BINARY_SHA256 = 'd9cf21be28ce84a1c8d17500164d5d35d59cf67d991677adf396f1500ca23261'
SUPAUTILS_LIBRARY_PATH = '/nix/store/7w7xzipk4v025ip0gpw4isfqxliq26mh-supautils/lib/supautils.so'
IMAGE_RECEIPT_PATH = '/nix/store/8iibnmg3hkijs2nyzs5fmfmj8wkia6vs-receipt/receipt.json'
IMAGE_RECEIPT_SHA256 = 'd66e56d568036bb988fce42f6a77d99dcbebc8c17c2a82db22f1880443ae8509'
SOURCE_COMMIT = 'd8666db883fd1bc3bc06654c8db1f8dc39812b82'
SUPAUTILS_SOURCE_HASH = 'sha256-Wsou5U7/Tuwj2E6aPEmlHg7uz7kGyBOGrb7UkjfEo9U='
SUPAUTILS_COMPAT_PATCH_SHA256 = 'bd29ca2fd2114bd45ae13966b3b5eeeaa49cb7fb3166cb327fdbb9716dafc57f'

# Fixed resource envelope (proposed; owner approves). Mirrors the security plan's 2CPU/2GiB/PID limits.
RESOURCE_ENVELOPE = {
    'cpus': '2',
    'memory': '2g',
    'memory_swap': '2g',          # == memory, so no swap
    'pids_limit': 128,
    'shm_size': '256m',           # intrinsic extensions may need shared memory; bounded, not host default
    'startup_timeout_s': 240,
    'candidate_timeout_s': 120,
    'total_budget_s': 480,
    'ephemeral_volume_gib': 4,
    'log_cap_bytes': 16 * 1024 * 1024,   # plan 01 section 4 (security plan proposed 8 MiB; see README)
    'evidence_cap_bytes': 64 * 1024 * 1024,
}

CONTAINER_NAME = 'tonyai-r3-db-candidate'
NETWORK_NAME = 'tonyai-r3-db-candidate-net'
VOLUME_NAME = 'tonyai-r3-db-candidate-data'
LOOPBACK_HOST = '127.0.0.1'

# Docker socket is referenced read-only through the standard host path, exactly as existing scripts do.
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']

# The fixture names, from fixture-sql.mjs / the proposal. Setup credentials are distinct and never here.
PROBE_ROLE = 'regress_r3_probe'
TARGET_ROLE = 'regress_r3_target'
DATABASE = 'regress_r3_candidate'

HEX64 = re.compile(r'^[a-f0-9]{64}$')


class ContractRefusal(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _check(condition, code):
    if not condition:
        raise ContractRefusal(code)


def _sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


# ===================================================================================================
# 1. OFFLINE STARTUP-CLOSURE READER
#    Reads retained OCI/layer evidence (if any) and reports precisely which startup-closure facts are
#    present and which are missing. It NEVER fabricates a config. With no evidence it returns
#    OPEN_UNRESOLVED and lists every required fact as missing.
# ===================================================================================================
# The closure facts the candidate's correctness depends on. Each must be proven from image bytes, not
# from the deployment overlay (compose/.env) and not assumed.
REQUIRED_CLOSURE_FACTS = (
    'image_entrypoint',               # image config Entrypoint/Cmd
    'docker_entrypoint_script',       # /usr/local/bin/docker-entrypoint.sh or equivalent behaviour
    'postgresql_conf',                # /etc/postgresql/postgresql.conf (or the image's main conf)
    'postgresql_conf_include_chain',  # include / include_dir directives and their ordered targets
    'supautils_conf',                 # /etc/postgresql-custom/supautils.conf contents
    'shared_preload_libraries',       # effective ordered preload list incl. supautils position
    'supautils_gucs',                 # supautils.reserved_roles / privileged_role / reserved_memberships / superuser
    'pg_hba_conf',                    # host-based auth rules (SCRAM/trust) governing the probe login
    'logging_settings',               # log_destination / logging_collector / jsonlog so capture is valid
    'initdb_scripts',                 # docker-entrypoint-initdb.d order (roles.sql/jwt.sql effects)
    'bootstrap_superuser_identity',   # supabase_admin / postgres bootstrap role used for setup SQL
)


@dataclass
class ClosureResult:
    status: str                              # 'CLOSED_FROM_RETAINED_EVIDENCE' | 'OPEN_UNRESOLVED'
    present: dict = field(default_factory=dict)   # fact -> {source_path, sha256}
    missing: list = field(default_factory=list)   # facts not proven offline
    oci_closure: dict = field(default_factory=dict)  # content-addressed verification outcome, if any
    notes: list = field(default_factory=list)

    def to_json(self):
        return {
            'status': self.status,
            'present': self.present,
            'missing': self.missing,
            'oci_closure': self.oci_closure,
            'notes': self.notes,
        }


def read_startup_closure(evidence_index, read_bytes):
    """evidence_index: {fact_name: {'path': str, 'sha256': str}} for whatever the owner retained; may be
    empty or partial. read_bytes(path) -> bytes. This reader verifies each offered fact's bytes against
    its recorded sha256 and classifies it as present; everything in REQUIRED_CLOSURE_FACTS that is not
    offered-and-verified is reported missing. It does not interpret the bytes into a desired config.

    oci_closure: if the owner retained an OCI layout, pass it separately to verify_oci_closure() and
    merge the result; this function only records what was passed in evidence_index['_oci_closure'].
    """
    _check(isinstance(evidence_index, dict) and callable(read_bytes), 'CLOSURE_INPUT')
    present, missing, notes = {}, [], []
    oci = {}
    for key, value in evidence_index.items():
        if key == '_oci_closure':
            _check(isinstance(value, dict), 'CLOSURE_OCI_SHAPE')
            oci = value
            continue
        _check(key in REQUIRED_CLOSURE_FACTS, 'CLOSURE_UNKNOWN_FACT:' + str(key))
        _check(isinstance(value, dict) and set(value) == {'path', 'sha256'}, 'CLOSURE_FACT_SHAPE:' + key)
        _check(isinstance(value['path'], str) and bool(HEX64.match(value['sha256'] or '')), 'CLOSURE_FACT_META:' + key)
        data = read_bytes(value['path'])
        _check(isinstance(data, (bytes, bytearray)), 'CLOSURE_READ:' + key)
        _check(_sha256_bytes(bytes(data)) == value['sha256'], 'CLOSURE_HASH_MISMATCH:' + key)
        present[key] = {'source_path': value['path'], 'sha256': value['sha256']}
    for fact in REQUIRED_CLOSURE_FACTS:
        if fact not in present:
            missing.append(fact)
    # The closure is CLOSED only if every required fact is present AND the OCI closure verified to the
    # pinned config digest. Anything short of that is OPEN_UNRESOLVED — we never guess.
    oci_ok = oci.get('status') == 'OCI_CLOSURE_VERIFIED' and oci.get('config_digest') == CONFIG_DIGEST
    if not missing and oci_ok:
        status = 'CLOSED_FROM_RETAINED_EVIDENCE'
    else:
        status = 'OPEN_UNRESOLVED'
        if not oci_ok:
            notes.append('OCI content-addressed closure to the pinned config digest is not verified offline.')
    return ClosureResult(status=status, present=present, missing=missing, oci_closure=oci, notes=notes)


def verify_oci_closure(layout_index, read_bytes):
    """Minimal offline content-addressed check of a retained OCI layout, independent of Docker. This
    mirrors the CONCEPT of infra r3_image_transport.verify (which needs the full 12-service lock) but is
    scoped to the single db image. layout_index: {'oci_layout': path, 'index': path, 'manifest': path,
    'config': path, 'layers': [paths]}. Returns an OCI closure dict for read_startup_closure.

    It checks: oci-layout == {"imageLayoutVersion":"1.0.0"}; the index has exactly one linux/amd64
    descriptor whose digest matches the manifest bytes; the manifest's config descriptor digest matches
    the config bytes and equals the pinned CONFIG_DIGEST; and each layer's digest matches its bytes.
    Missing inputs are reported, not assumed."""
    _check(isinstance(layout_index, dict) and callable(read_bytes), 'OCI_INPUT')
    required = {'oci_layout', 'index', 'manifest', 'config', 'layers'}
    if not required.issubset(layout_index):
        return {'status': 'OCI_EVIDENCE_INCOMPLETE', 'missing_inputs': sorted(required - set(layout_index))}
    try:
        layout = json.loads(read_bytes(layout_index['oci_layout']))
        _check(layout == {'imageLayoutVersion': '1.0.0'}, 'OCI_LAYOUT_VERSION')
        index_bytes = read_bytes(layout_index['index'])
        index = json.loads(index_bytes)
        children = [m for m in index.get('manifests', [])
                    if (m.get('platform') or {}).get('os') == 'linux'
                    and (m.get('platform') or {}).get('architecture') == 'amd64']
        _check(len(children) == 1, 'OCI_INDEX_PLATFORM')
        manifest_bytes = read_bytes(layout_index['manifest'])
        _check('sha256:' + _sha256_bytes(manifest_bytes) == children[0].get('digest'), 'OCI_MANIFEST_DIGEST')
        manifest = json.loads(manifest_bytes)
        config_desc = manifest.get('config') or {}
        config_bytes = read_bytes(layout_index['config'])
        config_sha = 'sha256:' + _sha256_bytes(config_bytes)
        _check(config_sha == config_desc.get('digest'), 'OCI_CONFIG_DESC')
        _check(config_sha == CONFIG_DIGEST, 'OCI_CONFIG_PIN')
        layer_descs = manifest.get('layers', [])
        _check(len(layer_descs) == len(layout_index['layers']), 'OCI_LAYER_COUNT')
        for desc, path in zip(layer_descs, layout_index['layers']):
            _check('sha256:' + _sha256_bytes(read_bytes(path)) == desc.get('digest'), 'OCI_LAYER_DIGEST')
        config = json.loads(config_bytes)
        return {
            'status': 'OCI_CLOSURE_VERIFIED',
            'config_digest': config_sha,
            'image_entrypoint': (config.get('config') or {}).get('Entrypoint'),
            'image_cmd': (config.get('config') or {}).get('Cmd'),
            'diff_ids': ((config.get('rootfs') or {}).get('diff_ids') or []),
        }
    except ContractRefusal as exc:
        return {'status': 'OCI_CLOSURE_REFUSED', 'code': exc.code}


# ===================================================================================================
# 2. DB-ONLY DISPOSABLE COMPOSITION PLAN (argv only; nothing is executed here)
# ===================================================================================================
def _label_args():
    return [
        '--label', 'tonyai.r3=db-candidate',
        '--label', 'tonyai.r3.purpose=ONE_ISOLATED_DB_CANDIDATE',
    ]


def plan_create_network():
    """Internal (no-egress) bridge network for the container. --internal blocks outbound routing."""
    return DOCKER + ['network', 'create', '--driver', 'bridge', '--internal'] + _label_args() + [NETWORK_NAME]


def plan_create_volume():
    return DOCKER + ['volume', 'create'] + _label_args() + [VOLUME_NAME]


def plan_run_container(password_via_stdin_marker='POSTGRES_PASSWORD_FROM_PRIVATE_FILE'):
    """The single `docker run` argv for the DB-only disposable container. The POSTGRES_PASSWORD value is
    NOT in the argv: it is delivered through an --env-file on a private 0600 path (named here only by
    marker), so it never appears in the process table, logs, or this plan. restart=no, read-only root
    filesystem with explicit tmpfs for the paths Postgres must write, all Linux capabilities dropped
    except the ones the entrypoint needs to drop privileges, no host network, no docker socket mount,
    loopback-only published port, bounded CPU/memory/PIDs. The published host port is chosen at run time
    and recorded in the receipt; here it is a placeholder."""
    return DOCKER + [
        'run', '--pull', 'never', '--detach',
        '--name', CONTAINER_NAME,
        '--network', NETWORK_NAME,
        '--restart', 'no',
        '--cpus', RESOURCE_ENVELOPE['cpus'],
        '--memory', RESOURCE_ENVELOPE['memory'],
        '--memory-swap', RESOURCE_ENVELOPE['memory_swap'],
        '--pids-limit', str(RESOURCE_ENVELOPE['pids_limit']),
        '--shm-size', RESOURCE_ENVELOPE['shm_size'],
        '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
        '--tmpfs', '/run:rw,nosuid,nodev,size=16m',
        '--tmpfs', '/var/run/postgresql:rw,nosuid,nodev,size=16m',
        '--cap-drop', 'ALL',
        '--cap-add', 'SETUID', '--cap-add', 'SETGID',  # entrypoint drops root to the postgres user
        '--security-opt', 'no-new-privileges',
        '--env-file', '<PRIVATE_0600_ENV_FILE:' + password_via_stdin_marker + '>',
        '--volume', VOLUME_NAME + ':/var/lib/postgresql/data',
        '--publish', LOOPBACK_HOST + ':<EPHEMERAL_PORT>:5432',
    ] + _label_args() + [IMAGE]


def plan_teardown():
    """Exact owned-object teardown. No prune, no wildcard, no shared-stack down."""
    return [
        DOCKER + ['stop', '--timeout', '30', CONTAINER_NAME],
        DOCKER + ['rm', '--volumes', CONTAINER_NAME],
        DOCKER + ['network', 'rm', NETWORK_NAME],
        DOCKER + ['volume', 'rm', VOLUME_NAME],
    ]


def plan_image_identity_commands():
    """Commands whose output the execution adapter must check to prove the running image == pinned image
    and config, reusing the ci_database_image.verify_image predicate shape. Not executed here."""
    return {
        'inspect_image': DOCKER + ['image', 'inspect', '--format',
                                   '{"id":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}},'
                                   '"repoDigests":{{json .RepoDigests}}}', IMAGE],
        'inspect_container_image': DOCKER + ['inspect', '--format', '{{json .Image}}', CONTAINER_NAME],
        'expected_id': CONFIG_DIGEST,
        'expected_os': 'linux',
        'expected_architecture': 'amd64',
        'expected_repo_digest': IMAGE,
    }


# ===================================================================================================
# 3. CREDENTIAL ROUTE
#    The probe password is generated with high entropy inside the private runner AFTER approval, set via
#    the image's own psql \password (client-side SCRAM encryption), delivered on a private stdin pipe,
#    and never interpolated into argv, SQL logs, or evidence. The setup identity is the image bootstrap
#    superuser (resolved from the closure, NOT assumed) and is distinct from the three probe clients.
# ===================================================================================================
def plan_credential_route(closure_status):
    """Returns the credential-route plan. If the startup closure is OPEN_UNRESOLVED, the route is BLOCKED
    because the bootstrap superuser identity and pg_hba SCRAM rule are unknown — we refuse to improvise
    trust auth. psql path/bytes/version must be pinned from the image before use."""
    blocked = closure_status != 'CLOSED_FROM_RETAINED_EVIDENCE'
    return {
        'status': 'BLOCKED_PENDING_CLOSURE' if blocked else 'PLANNED',
        'generator': 'os.urandom(32) hex, inside the private runner, after approval',
        'delivery_to_setup': "image psql \\password over a private stdin pipe; no argv, no SQL log",
        'delivery_to_candidate': 'probe DATABASE URL via a private 0600 --env-file / inherited fd only',
        'setup_identity': 'image bootstrap superuser resolved from the closure (NOT assumed)',
        'psql_binding_required': 'pin /usr/lib/postgresql/17/bin/psql path+bytes+version before use',
        'pg_hba_dependency': 'the probe SCRAM/md5/trust rule must come from the verified pg_hba.conf',
        'refusal_if_unbound': 'keep the executable entrypoint blocked rather than enabling trust auth',
        'secret_handling': 'never captured in SQL/error logs; excluded from retained evidence entirely',
    }


# ===================================================================================================
# 4. PER-LANE LOADED-LIBRARY OBSERVER
#    Bounded, read-only native observer inside the container PID/mount namespace. Feeds loaded-library.py
#    validators (validate_loaded_library). Paths originate only from the verified namespace + reported
#    DB PIDs — never user-supplied. No ptrace, no memory reads, no arbitrary /proc/environ dumps.
# ===================================================================================================
def plan_loaded_library_observer(lane_pids):
    """lane_pids: {'A': pid, 'B': pid, 'C': pid} reported by the driver's identity query. Returns the
    bounded read-only commands to collect, per lane, /proc/<pid>/maps and the nofollow stat+hash of the
    mapped supautils.so, plus the postmaster executable and the image receipt. Nothing is executed."""
    _check(isinstance(lane_pids, dict) and set(lane_pids) == {'A', 'B', 'C'}, 'OBSERVER_LANES')
    for lane, pid in lane_pids.items():
        _check(isinstance(pid, int) and pid > 0, 'OBSERVER_PID:' + lane)
    plan = {'library_path': SUPAUTILS_LIBRARY_PATH, 'receipt_path': IMAGE_RECEIPT_PATH,
            'expected_library_sha256': SUPAUTILS_BINARY_SHA256, 'expected_receipt_sha256': IMAGE_RECEIPT_SHA256,
            'lanes': {}}
    for lane, pid in lane_pids.items():
        plan['lanes'][lane] = {
            'read_maps': DOCKER + ['exec', '--user', '0', CONTAINER_NAME,
                                   '/usr/bin/env', '-i', 'cat', '/proc/%d/maps' % pid],
            'stat_library': DOCKER + ['exec', '--user', '0', CONTAINER_NAME,
                                      '/usr/bin/env', '-i', 'stat', '-L', '--format',
                                      '%d %i %s', SUPAUTILS_LIBRARY_PATH],
        }
    plan['note'] = ('maps+hash establishes loaded-artifact correspondence only; the function-pointer hook '
                    'chain stays UNRESOLVED (loaded-library.py enforces this).')
    return plan


def validate_loaded_library_evidence(evidence, expected_lanes):
    """Thin wrapper that defers to loaded-library.py's validator. Imported lazily so this module has no
    load-time dependency and the test suite can inject a fake."""
    from importlib import import_module
    mod = import_module('loaded_library') if _module_exists('loaded_library') else _load_sibling('loaded-library.py', 'loaded_library')
    return mod.validate_loaded_library(evidence, expected_lanes)


# ===================================================================================================
# 5. LOG CAPTURE PLAN  (feeds validate-evidence.py validate_log_interval)
# ===================================================================================================
def plan_log_capture():
    return {
        'format': 'jsonlog',
        'cap_bytes': RESOURCE_ENVELOPE['log_cap_bytes'],
        'start_before': 'accepted-ready baseline (before setup/stimuli)',
        'boundaries': 'UTC server-time start + monotonic local bracket',
        'container_state': 'record container id, StartedAt, restart count, OOM, exit code before/after',
        'destination': 'PostgreSQL jsonlog (logging_collector); docker stdout alone is insufficient',
        'password_logging': 'disabled during credential setup; raw password input never archived',
        'teardown_marker': 'planned-stop messages kept in a separate post-test segment',
        'partial_rule': 'missing interval / rotation gap / truncation / decoder anomaly => PARTIAL, not clean',
        'requires_closure_fact': 'logging_settings',  # only valid once the closure proves jsonlog is on
    }


# ===================================================================================================
# 6. CUSTODY SEAL PLAN  (reuses the age recipient + r3_noble_fixture.seal / r3_access_repair_custody seal)
# ===================================================================================================
# The exact flat evidence allowlist for the sealed set. No URLs, passwords, env or config dumps.
EVIDENCE_ALLOWLIST = (
    'manifest.json',                # source + runtime identity manifest
    'binding03.json',               # the one-attempt packet binding
    'fixture-before.json', 'fixture-after.json', 'fixture-after-A-commit.json',
    'candidate-events.jsonl',       # bounded <=256 events, <=16 KiB each
    'candidate-result.json',
    'provenance.json',              # image/config/layer + supautils source/receipt provenance
    'loaded-library.json',
    'log-interval-meta.json', 'server-log.bounded',
    'cleanup.json', 'retention-manifest.json',
)
# Reuse the already-approved age recipient (same key the observation/custody seals used), by its
# normalized sha256. The private key never reaches the runner/agent.
AGE_RECIPIENT_NORMALIZED_SHA256 = '7f784a5f4990192dc4c8715d88bb0bdcdec8d66265bb33600c4a27111545f9cd'
# age binary pin — the Linux amd64 release used on the hosted runner (infra noble-fixture lock).
AGE_URL = 'https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz'
AGE_ARCHIVE_SHA256 = 'cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10'
AGE_VERSION = 'v1.3.2'


def plan_custody_seal():
    return {
        'design': 'r3_access_repair_custody.seal (<=48 files, <=32 MiB) OR r3_noble_fixture.seal '
                  '(128 MiB cap); adapt the file allowlist, do NOT fabricate SSH bindings',
        'evidence_allowlist': list(EVIDENCE_ALLOWLIST),
        'recipient_normalized_sha256': AGE_RECIPIENT_NORMALIZED_SHA256,
        'age_url': AGE_URL, 'age_archive_sha256': AGE_ARCHIVE_SHA256, 'age_version': AGE_VERSION,
        'public_artifact': 'ciphertext + binding + summary only, after ciphertext byte-hash verified',
        'excluded': ['probe/setup credentials', 'datasource URLs', 'env dumps', 'full docker inspect',
                     'temp DB volume contents', 'raw arbitrary errors'],
        'on_failure': 'seal failure cannot claim completion; preserve partial output; no auto rerun',
    }


# ===================================================================================================
# TOP-LEVEL PLAN ASSEMBLY  (pure; returns data, runs nothing)
# ===================================================================================================
def assemble_plan(closure_result):
    """closure_result: a ClosureResult. Returns the full one-attempt composition/evidence plan. The
    credential route and log capture are BLOCKED while the closure is OPEN_UNRESOLVED."""
    _check(isinstance(closure_result, ClosureResult), 'PLAN_INPUT')
    status = closure_result.status
    return {
        'purpose': 'ONE_ISOLATED_DB_CANDIDATE',
        'image': IMAGE, 'config_digest': CONFIG_DIGEST, 'platform': PLATFORM,
        'resource_envelope': dict(RESOURCE_ENVELOPE),
        'startup_closure': closure_result.to_json(),
        'commands': {
            'create_network': plan_create_network(),
            'create_volume': plan_create_volume(),
            'run_container': plan_run_container(),
            'image_identity': plan_image_identity_commands(),
            'teardown': plan_teardown(),
        },
        'credential_route': plan_credential_route(status),
        'log_capture': plan_log_capture(),
        'custody_seal': plan_custody_seal(),
        'executable': status == 'CLOSED_FROM_RETAINED_EVIDENCE',
        'blocking_reason': None if status == 'CLOSED_FROM_RETAINED_EVIDENCE'
        else 'startup-closure OPEN_UNRESOLVED: missing ' + ', '.join(closure_result.missing),
        'historical_status': 'NOT_REPRODUCED', 'r3_status': 'OPEN', 'runtime_status': 'NOT_EXECUTED',
    }


# --- tiny sibling-import helpers so loaded-library.py (hyphenated) can be used by name in tests ------
def _module_exists(name):
    import importlib.util
    return importlib.util.find_spec(name) is not None


def _load_sibling(filename, module_name):
    import importlib.util
    import os
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


if __name__ == '__main__':
    import sys
    if '--self-check' in sys.argv:
        # No evidence passed on the CLI, so the closure is OPEN_UNRESOLVED and the plan is non-executable.
        result = read_startup_closure({}, lambda _p: b'')
        plan = assemble_plan(result)
        json.dump(plan, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write('\n')
    else:
        sys.stderr.write('runtime_contract.py is offline preparation. Use --self-check to print the plan.\n')
        sys.exit(2)
