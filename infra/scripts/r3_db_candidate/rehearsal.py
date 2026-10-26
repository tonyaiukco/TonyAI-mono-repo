#!/usr/bin/env python3
"""db-candidate05/rehearsal.py — private offline preparation. NOT an execution authorization.

A NON-CONSUMING rehearsal of the single live attempt, for a disposable Linux/amd64 Docker runner. It runs
the exact composition the attempt uses (runtime_executor.build_run_plan: same image digest, same argv,
same deviations D1–D8), waits for the real server, makes READ-ONLY observations as the attempt's observer
user, then tears down and proves nothing is left behind. It has no attempt id, consumes nothing, creates
no role, no database, no fixture and no probe, and sets no password other than the container's own
random bootstrap POSTGRES_PASSWORD (in a private 0600 env-file, removed afterwards).

What it turns from "inspected" into "observed" (each is a numbered check in the report):
  R1  owner rehearsal approval bound to the same approved code manifest; R2 preflight (pin, free port,
  no same-named Docker object, fresh work dir); R3 the exact attempt argv; R4 Docker's "exists" wording;
  R5 image/container/port identity; R6 the real server is ready (TCP inside, listen_addresses,
  pg_current_logfile == the tailed jsonlog file); R7 D8 ownership (socket dir, log dir, PGDATA,
  /etc/postgresql-custom, pgsodium key present — stat only, never read); R8 effective preload/supautils
  values == the image's own config, supabase_admin statement logging off, no fixture role settings;
  R9 the jsonlog is readable as postgres over exactly a measured interval and carries one RAISE LOG
  marker in the validator's timestamp format, no crash pattern, stderr file quiet; R10 /proc/<backend>/maps
  of a session-preloaded backend is readable as postgres and maps the pinned supautils.so (real
  loaded-library validator; inode/dev correspondence); R11 psql's no-tty stdin prompt (the \\password
  route) without creating any role; R12 PID 1's name (recorded, not required); R13 the container stayed
  up; R14 after teardown no attempt object exists (Docker's "missing" wording), so the real attempt's
  preflight can pass.

Only non-secret facts are retained; the init-phase log (which holds the bootstrap password) is never
read. Historical status stays NOT_REPRODUCED; R3 stays OPEN; a passing rehearsal is not a candidate
result and says nothing about the six-case matrix.
"""
from __future__ import annotations

import json
import re

from runtime_executor import (ExecutorRefusal, _check, safe_code, build_run_plan, verify_image_identity,
                              verify_port_mapping, interpret_ready, interpret_admin_log, interpret_role_settings,
                              capture_bootstrap, normalize_container_state, library_record_from_exec,
                              LIBRARY_PATH, RECEIPT_PATH, LOG_DIR, CONFIG_DIR, POSTGRES_UID, POSTGRES_GID,
                              CONFIG_VOLUME, READY_QUERY, ADMIN_LOG_QUERY, run_teardown, ISO_APPROVAL, _instant,
                              js_canonical, CONTAINER_ID)

REHEARSAL_PURPOSE = 'R3_DB_REHEARSAL_NO_ATTEMPT'
REHEARSAL_APPROVAL_KEYS = frozenset({'purpose', 'source_manifest_sha256', 'issued_at_utc', 'historical_status',
                                     'r3_status', 'consumes_attempt'})
HEX32 = re.compile(r'^[a-f0-9]{32}$')
JSON_TIMESTAMP = re.compile(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC$')   # validate-evidence format
# state = 'active': the backend is executing pg_sleep, i.e. past session start (supautils loaded).
HOLDER_QUERY = ("SELECT pid FROM pg_stat_activity WHERE application_name = 'r3_rehearsal_holder' "
                "AND backend_type = 'client backend' AND state = 'active';\n")
PASSED, FAILED = 'REHEARSAL_PASSED', 'REHEARSAL_FAILED'
REPORT_ALLOWLIST = ('rehearsal-report.json',)


def validate_rehearsal_approval(approval, *, source_manifest, hasher, now):
    _check(isinstance(approval, dict) and set(approval) == REHEARSAL_APPROVAL_KEYS, 'REHEARSAL_APPROVAL_SHAPE')
    _check(approval['purpose'] == REHEARSAL_PURPOSE, 'REHEARSAL_APPROVAL_PURPOSE')
    _check(approval['consumes_attempt'] is False, 'REHEARSAL_APPROVAL_CONSUMES')
    _check(approval['historical_status'] == 'NOT_REPRODUCED' and approval['r3_status'] == 'OPEN', 'REHEARSAL_APPROVAL_STATUS')
    _check(isinstance(approval['issued_at_utc'], str) and bool(ISO_APPROVAL.match(approval['issued_at_utc'])), 'REHEARSAL_APPROVAL_ISSUED')
    _check(_instant(approval['issued_at_utc'], 'REHEARSAL_APPROVAL_ISSUED') <= _instant(now, 'CLOCK'), 'REHEARSAL_APPROVAL_FUTURE')
    _check(isinstance(source_manifest, dict) and source_manifest
           and hasher(js_canonical(source_manifest).encode()) == approval['source_manifest_sha256'], 'REHEARSAL_APPROVAL_MANIFEST')
    return True


def interpret_owner(text, *, kind, modes, code):
    """modes: exact allowed `%a` values, or None = any mode in which the owner (postgres) can write."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    _check(len(lines) == 1, code)
    parts = lines[0].split('|')
    _check(len(parts) == 4, code)
    uid, gid, mode, ftype = parts
    _check(uid == str(POSTGRES_UID) and gid == str(POSTGRES_GID), code)
    _check(ftype == kind and re.fullmatch(r'[0-7]{1,4}', mode) is not None, code)
    if modes is None:
        _check(int(mode, 8) & 0o200 != 0, code)
    else:
        _check(mode in modes, code)
    return {'uid': int(uid), 'gid': int(gid), 'mode': mode, 'type': ftype}


def interpret_holder_pid(text):
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) != 1 or not lines[0].isdigit() or int(lines[0]) <= 1:
        return None
    return int(lines[0])


def _log_instant(text):
    import datetime
    return datetime.datetime.strptime(text, '%Y-%m-%d %H:%M:%S.%f UTC').replace(tzinfo=datetime.timezone.utc)


def check_marker_interval(log_bytes, marker, crash_patterns, *, start_utc, end_utc, forbidden,
                          allowed_severities, text_fields):
    # allowed_severities / text_fields are the attempt validator's own ALLOWED_SEVERITIES / TEXT_FIELDS
    # (passed in by the caller, never re-declared here, so the two classifiers cannot drift).
    """The interval measured around one RAISE LOG must be valid jsonlog with the marker exactly once, each
    entry shaped like the attempt validator expects (int pid, string severity, its timestamp format, in
    order, inside the host time bracket), no crash pattern, and none of the `forbidden` secrets (the
    bootstrap password this run generated: proves the init-phase lines are outside the interval).
    Only counts are returned."""
    _check(isinstance(log_bytes, bytes) and log_bytes.endswith(b'\n'), 'R9_LOG_INCOMPLETE')
    for secret in forbidden:
        _check(secret.encode() not in log_bytes, 'R9_SECRET_IN_INTERVAL')
    floor = _instant(start_utc, 'R9_BRACKET').replace(microsecond=0)
    ceiling = _instant(end_utc, 'R9_BRACKET')
    entries, markers, previous = 0, 0, None
    for line in log_bytes.decode('utf-8').split('\n')[:-1]:
        entry = json.loads(line)
        _check(isinstance(entry, dict) and isinstance(entry.get('timestamp'), str)
               and bool(JSON_TIMESTAMP.match(entry['timestamp'])), 'R9_LOG_TIMESTAMP_FORMAT')
        _check(type(entry.get('pid')) is int and isinstance(entry.get('error_severity'), str), 'R9_LOG_ENTRY_SHAPE')
        # Same rule as the attempt's validator: any WARNING/ERROR/FATAL/PANIC would make the attempt's log
        # PARTIAL or REJECTED, so the rehearsal must not pass over one.
        _check(entry['error_severity'] in allowed_severities, 'R9_LOG_SEVERITY:' + entry['error_severity'][:12])
        stamp = _log_instant(entry['timestamp'])
        _check(floor <= stamp <= ceiling, 'R9_LOG_OUTSIDE_BRACKET')
        _check(previous is None or stamp >= previous, 'R9_LOG_TIME_ORDER')
        previous = stamp
        body = ' '.join(entry[f] for f in text_fields if isinstance(entry.get(f), str))
        _check(not any(p.search(body) for p in crash_patterns), 'R9_LOG_CRASH_PATTERN')
        entries += 1
        if entry.get('message') == marker:
            _check(entry.get('error_severity') == 'LOG', 'R9_MARKER_SEVERITY')
            markers += 1
    _check(markers == 1, 'R9_MARKER_COUNT')
    return {'entries': entries, 'marker_found': True}


def run_rehearsal(config, ops, mods):
    """mods: {'contract': runtime_contract, 'loaded_library': loaded-library module, 'crash_patterns': validate-evidence
    CRASH_PATTERNS}. Returns the report (also written and sealed). Never consumes an attempt."""
    contract, ll = mods['contract'], mods['loaded_library']
    work = config['work_dir']
    report = {'kind': REHEARSAL_PURPOSE, 'status': FAILED, 'phase': 'approval', 'failure': None, 'checks': {},
              'observed': {}, 'attempt_consumed': False, 'historical_status': 'NOT_REPRODUCED', 'r3_status': 'OPEN'}
    created, secrets_written = [], []
    work_ready = False                   # F2: never write into a work dir this run did not verify fresh
    bootstrap_secret = None

    def passed(check, value=True):
        report['checks'][check] = value

    try:
        # ---- R1/R2: authorization and preflight, nothing started yet ---------------------------------
        validate_rehearsal_approval(config['approval'], source_manifest=config['source_manifest'],
                                    hasher=ops['sha256'], now=ops['utc_now']())
        passed('R1_approval')
        report['phase'] = 'preflight'
        ops['host_lock']()                                # F1: never alongside the attempt or another rehearsal
        _check(config['image'] == contract.IMAGE and config['config_digest'] == contract.CONFIG_DIGEST, 'IMAGE_PIN')
        port = config['endpoint_port']
        plan = build_run_plan(contract, port=port, env_file=work + '/inputs/postgres.env')     # R3: the attempt's argv
        report['observed']['deviations'] = plan['deviations']
        _check(ops['port_free'](port) is True, 'PORT_IN_USE')
        objects = (('container', contract.CONTAINER_NAME), ('network', contract.NETWORK_NAME),
                   ('volume', contract.VOLUME_NAME), ('volume', CONFIG_VOLUME))
        for kind, name in objects:
            _check(ops['docker_object_exists'](kind, name) is False, 'DOCKER_OBJECT_EXISTS:' + name)
        ops['assert_fresh_work_dir'](work)
        work_ready = True
        passed('R2_preflight')
        # ---- R3/R4: the exact composition ------------------------------------------------------------
        report['phase'] = 'compose'
        bootstrap_secret = ops['gen_secret']()
        ops['write_secret'](work + '/inputs/postgres.env', 'POSTGRES_PASSWORD=' + bootstrap_secret + '\n')
        secrets_written.append(work + '/inputs/postgres.env')
        ops['ensure_image']()
        for key, label in (('create_network', 'network'), ('create_volume', 'volume'),
                           ('create_config_volume', 'config-volume')):
            created.append(label)
            ops['run'](plan[key], 'create-' + label)
        created.append('container')
        container_id = ops['run'](plan['run_container'], 'run-container').decode().strip()
        _check(bool(CONTAINER_ID.match(container_id)), 'CONTAINER_ID')
        passed('R3_exact_attempt_argv')
        for kind, name in objects:
            _check(ops['docker_object_exists'](kind, name) is True, 'R4_OBJECT_NOT_VISIBLE:' + name)
        passed('R4_docker_exists_wording')
        # ---- R5/R6: identity and the real server ----------------------------------------------------
        report['phase'] = 'identity'
        ident = contract.plan_image_identity_commands()
        verify_image_identity(json.loads(ops['run'](ident['inspect_image'], 'inspect-image').decode()),
                              json.loads(ops['run'](ident['inspect_container_image'], 'inspect-container').decode()),
                              expect_config_digest=config['config_digest'], expect_image_ref=config['image'])
        verify_port_mapping(ops['run'](plan['port_check'], 'port').decode(), port)
        passed('R5_identity')
        report['phase'] = 'ready'
        ops['wait_ready']()
        ready = interpret_ready(ops['psql_bootstrap'](READY_QUERY, 'ready').decode())
        state_before = normalize_container_state(ops['container_state']())
        passed('R6_real_server_ready')
        # ---- R7: D8 ownership (stat only) -------------------------------------------------------------
        report['phase'] = 'ownership'
        owners = {
            '/run/postgresql': interpret_owner(ops['stat_owner']('/run/postgresql'), kind='directory', modes=('3775',),
                                               code='R7_SOCKET_DIR'),
            LOG_DIR: interpret_owner(ops['stat_owner'](LOG_DIR), kind='directory', modes=('700',), code='R7_LOG_DIR'),
            '/var/lib/postgresql/data': interpret_owner(ops['stat_owner']('/var/lib/postgresql/data'), kind='directory',
                                                        modes=('700', '750'), code='R7_PGDATA'),
            # The attempt needs only that postgres owns and can write these (pgsodium writes its key there);
            # their exact modes come from the image (0755) and are recorded, not guessed.
            CONFIG_DIR: interpret_owner(ops['stat_owner'](CONFIG_DIR), kind='directory', modes=None,
                                        code='R7_CONFIG_DIR'),
            CONFIG_DIR + '/pgsodium_root.key': interpret_owner(ops['stat_owner'](CONFIG_DIR + '/pgsodium_root.key'),
                                                               kind='regular file', modes=None,
                                                               code='R7_PGSODIUM_KEY'),
        }
        report['observed']['ownership'] = owners
        passed('R7_d8_ownership')
        # ---- R8: effective configuration (read-only) --------------------------------------------------
        report['phase'] = 'config'
        interpret_admin_log(ops['psql_bootstrap'](ADMIN_LOG_QUERY, 'admin-log').decode())
        interpret_role_settings(ops['psql_bootstrap'](config['role_setting_query'], 'role-settings').decode(), 'REHEARSAL')
        capture_bootstrap(config, ops, 'rehearsal')
        passed('R8_effective_config')
        # ---- R9: log path as the observer user ----------------------------------------------------------
        report['phase'] = 'log'
        start = ops['log_position']()
        marker = 'r3-rehearsal-' + ops['gen_marker']()
        _check(re.fullmatch(r'r3-rehearsal-[a-f0-9]{32}', marker) is not None, 'R9_MARKER_FORMAT')
        ops['psql_bootstrap']("DO $$ BEGIN RAISE LOG '%s'; END $$;\n" % marker, 'marker')
        ops['sleep'](1)                                   # let the collector flush the one line
        end = ops['log_position']()
        _check(end['inode'] == start['inode'] and end['offset'] > start['offset'], 'R9_LOG_DID_NOT_GROW')
        interval = ops['read_log_interval'](start['offset'], end['offset'] - start['offset'])
        report['observed']['log'] = check_marker_interval(
            interval, marker, mods['crash_patterns'], start_utc=start['utc_before'], end_utc=end['utc_after'],
            forbidden=[bootstrap_secret], allowed_severities=tuple(mods['allowed_severities']),
            text_fields=tuple(mods['text_fields']))
        report['observed']['log']['bytes'] = len(interval)
        _check(end.get('stderr_size') == start.get('stderr_size'), 'R9_STDERR_LOG_GREW')
        passed('R9_jsonlog_readable_as_observer')
        # ---- R10: /proc maps of a session-preloaded backend ----------------------------------------------
        report['phase'] = 'maps'
        ops['start_holder']()
        pid = None
        for _ in range(20):
            pid = interpret_holder_pid(ops['psql_bootstrap'](HOLDER_QUERY, 'holder-pid').decode())
            if pid:
                break
            ops['sleep'](0.5)
        _check(pid is not None, 'R10_NO_HOLDER_BACKEND')
        maps = ops['read_maps'](pid)
        library = library_record_from_exec(*ops['observe_library'](LIBRARY_PATH), path=LIBRARY_PATH,
                                           expected_size_cap=16 * 1024 * 1024)
        receipt = library_record_from_exec(*ops['observe_library'](RECEIPT_PATH), path=RECEIPT_PATH,
                                           expected_size_cap=1024 * 1024)
        identity = ll.validate_library_record(library)
        ll.validate_receipt_record({k: receipt[k] for k in ('path', 'realpath', 'opened_nofollow', 'file_type', 'st_size',
                                                             'sha256', 'bytes_hashed', 'truncated')})
        segments = ll.validate_lane_maps(maps, identity)
        try:                                              # F5: recorded, never required
            postmaster_supautils = LIBRARY_PATH in ops['read_maps'](1)
        except Exception as exc:
            postmaster_supautils = 'unreadable:' + safe_code(exc)
        report['observed']['maps'] = {'backend_pid': pid, 'mapped_segments': segments,
                                      'postmaster_maps_supautils': postmaster_supautils}
        passed('R10_backend_maps_readable_and_supautils_loaded')
        # ---- R11/R12/R13 ----------------------------------------------------------------------------------
        report['phase'] = 'prompt'
        token = ops['gen_marker']()
        _check(token in ops['prompt_probe'](token).split(), 'R11_PROMPT_NOT_FROM_STDIN')
        passed('R11_psql_prompt_reads_stdin')
        try:                                              # recorded, never required
            report['observed']['pid1_comm'] = ops['proc1_comm']()[:32]
        except Exception as exc:
            report['observed']['pid1_comm'] = 'unreadable:' + safe_code(exc)
        passed('R12_pid1_recorded')
        state_after = normalize_container_state(ops['container_state']())
        _check(state_after['running'] is True and state_after['restart_count'] == state_before['restart_count']
               and state_after['started_at'] == state_before['started_at'] and state_after['oom_killed'] is False,
               'R13_CONTAINER_CHANGED')
        report['observed']['postmaster_start'] = ready['postmaster_start']
        passed('R13_container_stable')
        report['phase'] = 'teardown'
    except BaseException as exc:
        report['failure'] = {'phase': report['phase'], 'code': safe_code(exc)}
    finally:
        report['cleanup'] = run_teardown(created, contract, ops)
        removal = []
        for path in secrets_written:
            try:
                ops['remove_secret'](path)
            except BaseException:
                removal.append(path.rsplit('/', 1)[-1])
        report['secret_removal_failures'] = removal
        # ---- R14: nothing of the attempt's is left behind -------------------------------------------------
        # Only meaningful once this run created something; before that (refused approval, busy lock, a
        # same-named object owned by someone else) the names are not ours to report as residue.
        if created:
            residue = []
            for kind, name in (('container', contract.CONTAINER_NAME), ('network', contract.NETWORK_NAME),
                               ('volume', contract.VOLUME_NAME), ('volume', CONFIG_VOLUME)):
                try:
                    if ops['docker_object_exists'](kind, name) is not False:
                        residue.append(name)
                except BaseException:
                    residue.append(name)
            report['residue'] = residue
            if not residue:
                passed('R14_no_residue')
        else:
            report['residue'] = None
    all_checks = ('R1_approval', 'R2_preflight', 'R3_exact_attempt_argv', 'R4_docker_exists_wording', 'R5_identity',
                  'R6_real_server_ready', 'R7_d8_ownership', 'R8_effective_config', 'R9_jsonlog_readable_as_observer',
                  'R10_backend_maps_readable_and_supautils_loaded', 'R11_psql_prompt_reads_stdin', 'R12_pid1_recorded',
                  'R13_container_stable', 'R14_no_residue')
    ok = (report['failure'] is None and all(report['checks'].get(c) is True for c in all_checks)
          and not report['cleanup']['failures'] and not report['secret_removal_failures'])
    report['status'] = PASSED if ok else FAILED
    report['attempt_consumed'], report['historical_status'], report['r3_status'] = False, 'NOT_REPRODUCED', 'OPEN'
    if not work_ready:
        report['seal'] = {'sealed': False, 'skipped': 'WORK_DIR_NOT_VERIFIED'}   # nothing written anywhere
        return report
    try:
        ops['write'](work + '/rehearsal-report.json', json.dumps(report, sort_keys=True).encode())
        report['seal'] = ops['seal'](work, list(REPORT_ALLOWLIST))
    except BaseException as exc:
        report['seal'] = {'sealed': False, 'failure': safe_code(exc)}
        report['status'] = FAILED
    return report
