"""Private offline preparation (db-candidate02): log-interval validator and result assembly.

Pure functions over already-captured bytes/records. No files, processes, sockets or CLI. The assembled
status is at most CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED; historical_status is always
NOT_REPRODUCED and nothing here can establish reproduction, qualification, bootstrap readiness or R3 closure.
"""
import datetime
import hashlib
import json
import re

PROBE = 'regress_r3_probe'
DATABASE = 'regress_r3_candidate'
# Mirror of driver.mjs MATRIX/CONTROLS (cross-checked against the driver source by the tests).
MATRIX = (
    ('grant-current', 'GRANT regress_r3_target TO CURRENT_USER;', '42501'),
    ('revoke-current', 'REVOKE regress_r3_target FROM CURRENT_USER;', '42501'),
    ('grant-session', 'GRANT regress_r3_target TO SESSION_USER;', '42501'),
    ('revoke-session', 'REVOKE regress_r3_target FROM SESSION_USER;', '42501'),
    ('grant-public', 'GRANT regress_r3_target TO PUBLIC;', '42704'),
    ('revoke-public', 'REVOKE regress_r3_target FROM PUBLIC;', '42704'),
)
CONTROLS = (
    ('grant-named-control', 'GRANT regress_r3_target TO regress_r3_probe;', '42501'),
    ('revoke-named-control', 'REVOKE regress_r3_target FROM regress_r3_probe;', '42501'),
)
CASE_ORDER = tuple([(case, 1) for case in CONTROLS] + [(case, repetition) for case in MATRIX for repetition in (1, 2, 3)])
LANES = ('A', 'B', 'C')

LOG_FORMAT = 'jsonlog'
LOG_CAP_BYTES = 16 * 1024 * 1024  # plan 01 section 4 (the earlier security plan proposed 8 MiB; see README)
MAX_ENTRY_BYTES = 64 * 1024
CEILING = 'CANDIDATE_CLIENT_CHECKS_COMPLETED_REVIEW_REQUIRED'
PARTIAL = 'PARTIAL_REVIEW_REQUIRED'
REJECTED = 'REJECTED_REVIEW_REQUIRED'
LOG_CONSISTENT = 'LOG_INTERVAL_CONSISTENT'
FINAL_STATUSES = frozenset({CEILING, PARTIAL, REJECTED})
ALLOWED_SEVERITIES = frozenset({'LOG', 'INFO', 'NOTICE', 'DEBUG1', 'DEBUG2', 'DEBUG3', 'DEBUG4', 'DEBUG5'})
CRASH_PATTERNS = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (
    r'signal 11', r'segmentation fault', r'\bSIGSEGV\b', r'terminated by signal', r'terminated by exception',
    r'exited with exit code', r'terminating any other active server processes', r'all server processes terminated',
    r'reinitializ', r'crash', r'not properly shut down', r'automatic recovery', r'redo (starts|done)',
    r'database system was interrupted', r'out of memory', r'\bOOM\b', r'ready to accept connections',
    r'database system is shut down', r'shutdown request', r'server process \(PID \d+\)', r'end-of-recovery',
    r'could not fork', r'invalid record length', r'unexpected EOF'))
TEXT_FIELDS = ('message', 'detail', 'hint', 'context', 'internal_query')
JSON_TIMESTAMP = re.compile(r'(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) UTC')
META_KEYS = frozenset({'format', 'correlation_id', 'interval_start_utc', 'interval_end_utc', 'captured_bytes', 'cap_bytes',
                       'truncated', 'rotations', 'source_inode_start', 'source_inode_end', 'offset_start', 'offset_end', 'container'})
CONTAINER_KEYS = frozenset({'restart_count_before', 'restart_count_after', 'oom_killed', 'started_at_before', 'started_at_after',
                            'running_after', 'exit_code_after'})
DRIVER_KEYS = frozenset({'status', 'historical_status', 'qualification', 'installation_success', 'cases', 'failure',
                         'cleanup_failures', 'required_external_evidence'})
CASE_KEYS = frozenset({'id', 'repetition', 'statement_sha256', 'expected_sqlstate', 'observed_sqlstate', 'unexpected_success',
                       'recovery_failure', 'controls_passed'})
COMPONENT_STATUS = {'manifest': 'MANIFEST_MATCH', 'gucs': 'GUC_FIXTURE_CONSISTENT',
                    'loaded_library': 'LOADED_ARTIFACT_CORRESPONDENCE_OBSERVED', 'log_interval': LOG_CONSISTENT}
OUTSTANDING = ('hook-chain-activation-proof', 'pinned-image-startup-config-closure', 'credential-route-review',
               'hard-deadline-and-process-custody', 'encrypted-custody-seal', 'independent-runtime-log-source-custody-review')


class Refusal(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _check(condition, code):
    if not condition:
        raise Refusal(code)


def _int(value):
    return type(value) is int


def _exact_dict(value, keys, code):
    _check(type(value) is dict and frozenset(value) == keys, code)


def _iso(value, code):
    _check(type(value) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z', value) is not None, code)
    return datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=datetime.timezone.utc)


def _no_duplicates(pairs):
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate key')
    return dict(pairs)


def _no_constants(name):
    raise ValueError('non-finite constant ' + name)


def _validate_expected(expected):
    _exact_dict(expected, frozenset({'pids', 'application_names'}), 'EXPECTED_BINDING')
    for key in ('pids', 'application_names'):
        _exact_dict(expected[key], frozenset(LANES), 'EXPECTED_BINDING')
    _check(all(_int(expected['pids'][lane]) and expected['pids'][lane] > 0 for lane in LANES) and
           len(set(expected['pids'].values())) == 3, 'EXPECTED_BINDING')
    _check(all(type(expected['application_names'][lane]) is str and re.fullmatch(r'[a-z0-9_]{1,63}', expected['application_names'][lane])
               for lane in LANES) and len(set(expected['application_names'].values())) == 3, 'EXPECTED_BINDING')


def _validate_meta(meta):
    _exact_dict(meta, META_KEYS, 'LOG_META_SHAPE')
    _check(meta['format'] == LOG_FORMAT, 'LOG_FORMAT')
    _check(meta['cap_bytes'] == LOG_CAP_BYTES and _int(meta['cap_bytes']), 'LOG_CAP')
    _check(type(meta['correlation_id']) is str and re.fullmatch(r'[a-f0-9]{32}', meta['correlation_id']), 'LOG_CORRELATION')
    for key in ('captured_bytes', 'rotations', 'source_inode_start', 'source_inode_end', 'offset_start', 'offset_end'):
        _check(_int(meta[key]) and meta[key] >= 0, 'LOG_META_TYPE')
    _check(type(meta['truncated']) is bool, 'LOG_META_TYPE')
    start, end = _iso(meta['interval_start_utc'], 'LOG_INTERVAL'), _iso(meta['interval_end_utc'], 'LOG_INTERVAL')
    _check(start < end, 'LOG_INTERVAL')
    _exact_dict(meta['container'], CONTAINER_KEYS, 'LOG_META_SHAPE')
    return start, end


def validate_log_interval(log_bytes, meta, expected):
    """Classify a captured jsonlog interval. Contract violations raise Refusal; evidence findings are returned."""
    _check(type(log_bytes) is bytes, 'LOG_TYPE')
    start, end = _validate_meta(meta)
    _validate_expected(expected)
    rejected, partial = set(), set()
    if meta['truncated'] is not False:
        partial.add('LOG_TRUNCATED')
    if meta['captured_bytes'] != len(log_bytes):
        partial.add('LOG_BYTE_COUNT')
    if len(log_bytes) >= LOG_CAP_BYTES:
        partial.add('LOG_AT_CAP')
    if meta['rotations'] != 0:
        partial.add('LOG_ROTATION')
    if meta['source_inode_start'] != meta['source_inode_end']:
        partial.add('LOG_SOURCE_CHANGED')
    if meta['offset_end'] - meta['offset_start'] != len(log_bytes):
        partial.add('LOG_OFFSET_GAP')
    if not log_bytes:
        partial.add('LOG_EMPTY')
    elif not log_bytes.endswith(b'\n'):
        partial.add('LOG_PARTIAL_LINE')
    container = meta['container']
    if not (container['restart_count_before'] == 0 and container['restart_count_after'] == 0 and
            _int(container['restart_count_before']) and _int(container['restart_count_after'])):
        rejected.add('CONTAINER_RESTART')
    if not (type(container['started_at_before']) is str and container['started_at_before'] and
            container['started_at_before'] == container['started_at_after']):
        rejected.add('CONTAINER_RESTART')
    if container['oom_killed'] is not False:
        rejected.add('CONTAINER_OOM')
    if container['running_after'] is not True or container['exit_code_after'] is not None:
        rejected.add('CONTAINER_NOT_RUNNING')
    try:
        text = log_bytes.decode('utf-8')
    except UnicodeDecodeError:
        partial.add('LOG_DECODE')
        text = ''
    lines = text.split('\n')
    if lines and lines[-1] == '':
        lines.pop()
    elif lines:
        lines.pop()  # incomplete final line is never interpreted (already PARTIAL)
    floor = start.replace(microsecond=start.microsecond - start.microsecond % 1000)
    aligned, previous = 0, None
    for line in lines:
        if len(line.encode('utf-8')) > MAX_ENTRY_BYTES:
            partial.add('LOG_ENTRY_SIZE')
            continue
        try:
            entry = json.loads(line, object_pairs_hook=_no_duplicates, parse_constant=_no_constants)
        except ValueError:
            partial.add('LOG_DECODE')
            continue
        if not (type(entry) is dict and type(entry.get('timestamp')) is str and _int(entry.get('pid')) and
                type(entry.get('error_severity')) is str and type(entry.get('message')) is str):
            partial.add('LOG_ENTRY_SHAPE')
            continue
        match = JSON_TIMESTAMP.fullmatch(entry['timestamp'])
        try:
            stamp = datetime.datetime(*(int(part) for part in match.groups()[:6]), int(match.group(7)) * 1000,
                                      tzinfo=datetime.timezone.utc) if match else None
        except ValueError:
            stamp = None
        if stamp is None:
            partial.add('LOG_TIMESTAMP')
            continue
        if stamp < floor or stamp > end:
            partial.add('LOG_OUTSIDE_INTERVAL')
        if previous is not None and stamp < previous:
            partial.add('LOG_TIME_ORDER')
        previous = stamp
        body = ' '.join(entry[field] for field in TEXT_FIELDS if type(entry.get(field)) is str)
        if any(pattern.search(body) for pattern in CRASH_PATTERNS):
            rejected.add('CRASH_INDICATOR')
        severity = entry['error_severity']
        if severity in ('PANIC', 'FATAL'):
            rejected.add('LOG_' + severity)
        elif severity == 'ERROR':
            if aligned >= len(CASE_ORDER):
                rejected.add('UNEXPECTED_ERROR_ENTRY')
                continue
            (_, statement, sqlstate), _ = CASE_ORDER[aligned]
            if (entry['pid'] == expected['pids']['A'] and entry.get('state_code') == sqlstate and entry.get('user') == PROBE and
                    entry.get('dbname') == DATABASE and entry.get('statement') == statement and
                    entry.get('application_name') == expected['application_names']['A']):
                aligned += 1
            else:
                rejected.add('ERROR_ORDER_MISMATCH')
        elif severity == 'WARNING':
            partial.add('UNEXPECTED_WARNING')
        elif severity not in ALLOWED_SEVERITIES:
            partial.add('LOG_SEVERITY_UNKNOWN')
    if aligned != len(CASE_ORDER):
        partial.add('EXPECTED_ERRORS_MISSING')
    status = REJECTED if rejected else PARTIAL if partial else LOG_CONSISTENT
    return {'status': status, 'findings': sorted(rejected | partial), 'aligned_errors': aligned,
            'lane_pids': dict(expected['pids']), 'correlation_id': meta['correlation_id']}


def _driver_findings(driver_result):
    _exact_dict(driver_result, DRIVER_KEYS, 'DRIVER_RESULT_SHAPE')
    _check(driver_result['historical_status'] == 'NOT_REPRODUCED', 'HISTORICAL_STATUS')
    _check(driver_result['qualification'] is False and driver_result['installation_success'] is False, 'QUALIFICATION_CLAIM')
    _check(driver_result['status'] in (CEILING, PARTIAL), 'DRIVER_STATUS')
    if driver_result['status'] == PARTIAL:
        return set(), {'DRIVER_PARTIAL'}
    cases = driver_result['cases']
    consistent = (type(cases) is list and len(cases) == len(CASE_ORDER) and driver_result['failure'] is None and
                  driver_result['cleanup_failures'] == [])
    if consistent:
        for item, ((case_id, statement, sqlstate), repetition) in zip(cases, CASE_ORDER):
            consistent = consistent and type(item) is dict and frozenset(item) == CASE_KEYS and item['id'] == case_id and \
                item['repetition'] == repetition and _int(item['repetition']) and \
                item['statement_sha256'] == hashlib.sha256(statement.encode()).hexdigest() and \
                item['expected_sqlstate'] == sqlstate and item['observed_sqlstate'] == sqlstate and \
                item['unexpected_success'] is False and item['recovery_failure'] is None and item['controls_passed'] is True
    return (set() if consistent else {'DRIVER_RESULT_INCONSISTENT'}), set()


def assemble_result(driver_result, components):
    """Combine the driver result with independently produced component results; never exceeds CEILING."""
    rejected, partial = _driver_findings(driver_result)
    _exact_dict(components, frozenset(COMPONENT_STATUS), 'COMPONENT_SET')
    for name, wanted in COMPONENT_STATUS.items():
        value = components[name]
        status = value.get('status') if type(value) is dict else None
        if status == wanted:
            continue
        if name == 'log_interval' and status in (PARTIAL, REJECTED):
            (rejected if status == REJECTED else partial).add('LOG_' + status)
        else:
            partial.add('COMPONENT_NOT_CONSISTENT:' + name)
    library = components['loaded_library']
    if type(library) is dict and library.get('hook_chain_activation') != 'UNRESOLVED':
        partial.add('HOOK_CHAIN_CLAIM_UNSUPPORTED')
    pids = [components[name].get('lane_pids') for name in ('loaded_library', 'log_interval') if type(components[name]) is dict]
    if len(pids) == 2 and pids[0] != pids[1]:
        rejected.add('LANE_PID_DISAGREEMENT')
    status = REJECTED if rejected else PARTIAL if partial else CEILING
    result = {
        'status': status, 'historical_status': 'NOT_REPRODUCED', 'qualification': False, 'installation_success': False,
        'r3_status': 'OPEN', 'bootstrap_status': 'NOT_READY', 'hook_chain_activation': 'UNRESOLVED',
        'findings': sorted(rejected | partial), 'outstanding': list(OUTSTANDING),
    }
    _check(result['status'] in FINAL_STATUSES and result['historical_status'] == 'NOT_REPRODUCED', 'RESULT_CEILING')
    return result
