"""Private offline preparation (db-candidate02): pure validator for supplied loaded-library evidence.

Input is already-collected text/records (a /proc/<pid>/maps body per live lane plus nofollow stat/hash
records). This module never opens /proc, files, sockets or processes and has no CLI. A consistent result
shows loaded-artifact correspondence only; hook-chain activation stays UNRESOLVED (plan 01 section 5).
"""
import re

EXPECTED_LIBRARY_PATH = '/nix/store/7w7xzipk4v025ip0gpw4isfqxliq26mh-supautils/lib/supautils.so'
EXPECTED_LIBRARY_SHA256 = 'd9cf21be28ce84a1c8d17500164d5d35d59cf67d991677adf396f1500ca23261'
EXPECTED_RECEIPT_PATH = '/nix/store/8iibnmg3hkijs2nyzs5fmfmj8wkia6vs-receipt/receipt.json'
EXPECTED_RECEIPT_SHA256 = 'd66e56d568036bb988fce42f6a77d99dcbebc8c17c2a82db22f1880443ae8509'
MAX_LIBRARY_BYTES = 16 * 1024 * 1024
MAX_RECEIPT_BYTES = 1024 * 1024
MAX_MAPS_BYTES = 1024 * 1024
MAX_MAPS_LINES = 16384
LANES = ('A', 'B', 'C')
PHASES = {'A': 'baseline-A', 'B': 'baseline-B', 'C': 'fresh-C'}
STATUS = 'LOADED_ARTIFACT_CORRESPONDENCE_OBSERVED'
DELETED_SUFFIX = ' (deleted)'

# Linux show_map_vma: start-end perms pgoff major:minor inode, one or more blanks, optional name.
MAPS_LINE = re.compile(
    r'([0-9a-f]{8,16})-([0-9a-f]{8,16}) ([r-])([w-])([x-])([ps]) ([0-9a-f]{8,16}) '
    r'([0-9a-f]{2,8}):([0-9a-f]{2,8}) ([0-9]{1,20}) +(\S.*)?')
HEX64 = re.compile(r'[a-f0-9]{64}')
NONCE = re.compile(r'[a-f0-9]{32}')
LIBRARY_KEYS = frozenset({'path', 'realpath', 'opened_nofollow', 'file_type', 'st_dev', 'st_ino', 'st_size',
                          'sha256', 'bytes_hashed', 'truncated', 'fstat_after_hash'})
RECEIPT_KEYS = frozenset({'path', 'realpath', 'opened_nofollow', 'file_type', 'st_size', 'sha256', 'bytes_hashed', 'truncated'})
LANE_KEYS = frozenset({'lane', 'phase', 'pid', 'nonce', 'maps'})


class Refusal(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _check(condition, code):
    if not condition:
        raise Refusal(code)


def _int(value):
    return type(value) is int  # bool is an int subclass and must not pass


def _exact_dict(value, keys, code):
    _check(type(value) is dict and frozenset(value) == keys and all(type(k) is str for k in value), code)


def linux_dev_major(dev):
    return ((dev >> 8) & 0xfff) | ((dev >> 32) & 0xfffff000)


def linux_dev_minor(dev):
    return (dev & 0xff) | ((dev >> 12) & 0xffffff00)


def parse_maps(text):
    """Strictly parse a complete maps body; any unparsable or partial line refuses the whole body."""
    _check(type(text) is str, 'MAPS_TYPE')
    _check(len(text.encode('utf-8', 'surrogatepass')) <= MAX_MAPS_BYTES, 'MAPS_SIZE')
    _check(text != '' and text.endswith('\n'), 'MAPS_TRUNCATED')
    lines = text[:-1].split('\n')
    _check(len(lines) <= MAX_MAPS_LINES, 'MAPS_SIZE')
    rows, previous_end = [], -1
    for line in lines:
        match = MAPS_LINE.fullmatch(line)
        _check(match is not None, 'MAPS_LINE_SYNTAX')
        # Kernel escapes newlines as \012; anything outside printable ASCII is refused, not interpreted.
        _check(all(0x20 <= ord(ch) <= 0x7e for ch in (match.group(11) or '')), 'MAPS_PATH_CHARACTERS')
        start, end = int(match.group(1), 16), int(match.group(2), 16)
        _check(start < end and start >= previous_end, 'MAPS_ORDER')
        previous_end = end
        rows.append({
            'start': start, 'end': end, 'read': match.group(3) == 'r', 'write': match.group(4) == 'w',
            'execute': match.group(5) == 'x', 'private': match.group(6) == 'p', 'offset': int(match.group(7), 16),
            'major': int(match.group(8), 16), 'minor': int(match.group(9), 16), 'inode': int(match.group(10)),
            'path': match.group(11) or '',
        })
    return rows


def validate_library_record(record):
    _exact_dict(record, LIBRARY_KEYS, 'LIBRARY_RECORD_SHAPE')
    _check(record['path'] == EXPECTED_LIBRARY_PATH and record['realpath'] == EXPECTED_LIBRARY_PATH, 'LIBRARY_PATH')
    _check(record['opened_nofollow'] is True and record['file_type'] == 'regular', 'LIBRARY_OPEN_MODE')
    for key in ('st_dev', 'st_ino', 'st_size', 'bytes_hashed'):
        _check(_int(record[key]), 'LIBRARY_RECORD_TYPE')
    _check(0 <= record['st_dev'] < 2 ** 64 and 0 < record['st_ino'] < 2 ** 64, 'LIBRARY_IDENTITY')
    _check(0 < record['st_size'] <= MAX_LIBRARY_BYTES, 'LIBRARY_SIZE')
    _check(record['truncated'] is False and record['bytes_hashed'] == record['st_size'], 'LIBRARY_HASH_INCOMPLETE')
    _check(type(record['sha256']) is str and HEX64.fullmatch(record['sha256']) is not None, 'LIBRARY_HASH_FORMAT')
    _check(record['sha256'] == EXPECTED_LIBRARY_SHA256, 'LIBRARY_HASH_MISMATCH')
    after = record['fstat_after_hash']
    _exact_dict(after, frozenset({'st_dev', 'st_ino', 'st_size'}), 'LIBRARY_RECORD_SHAPE')
    _check(all(_int(after[k]) and after[k] == record[k] for k in after), 'LIBRARY_CHANGED_DURING_HASH')
    return {'major': linux_dev_major(record['st_dev']), 'minor': linux_dev_minor(record['st_dev']), 'inode': record['st_ino'],
            'size': record['st_size']}


def validate_receipt_record(record):
    _exact_dict(record, RECEIPT_KEYS, 'RECEIPT_RECORD_SHAPE')
    _check(record['path'] == EXPECTED_RECEIPT_PATH and record['realpath'] == EXPECTED_RECEIPT_PATH, 'RECEIPT_PATH')
    _check(record['opened_nofollow'] is True and record['file_type'] == 'regular', 'RECEIPT_OPEN_MODE')
    _check(_int(record['st_size']) and _int(record['bytes_hashed']), 'RECEIPT_RECORD_TYPE')
    _check(0 < record['st_size'] <= MAX_RECEIPT_BYTES, 'RECEIPT_SIZE')
    _check(record['truncated'] is False and record['bytes_hashed'] == record['st_size'], 'RECEIPT_HASH_INCOMPLETE')
    _check(record['sha256'] == EXPECTED_RECEIPT_SHA256, 'RECEIPT_HASH_MISMATCH')
    return record['sha256']


def validate_lane_maps(text, identity):
    rows = parse_maps(text)
    mapped = []
    for row in rows:
        path, same_inode = row['path'], (row['major'], row['minor'], row['inode']) == (identity['major'], identity['minor'], identity['inode'])
        if path == EXPECTED_LIBRARY_PATH:
            mapped.append(row)
        elif path.endswith(DELETED_SUFFIX) and (path[:-len(DELETED_SUFFIX)] == EXPECTED_LIBRARY_PATH or same_inode):
            raise Refusal('DELETED_MAPPING')
        elif 'supautils' in path.lower():
            raise Refusal('ALTERNATE_SUPAUTILS_MAPPING')
        elif same_inode and row['inode'] != 0:
            raise Refusal('INODE_ALIAS_MAPPING')
    _check(mapped, 'LIBRARY_NOT_MAPPED')
    _check(len({(r['major'], r['minor'], r['inode']) for r in mapped}) == 1, 'MAPPED_IDENTITY_SPLIT')
    first = mapped[0]
    _check((first['major'], first['minor'], first['inode']) == (identity['major'], identity['minor'], identity['inode']),
           'MAPPED_IDENTITY_MISMATCH')
    _check(all(r['private'] for r in mapped), 'SHARED_LIBRARY_MAPPING')
    _check(not any(r['write'] and r['execute'] for r in mapped), 'WRITABLE_EXECUTABLE_MAPPING')
    _check(any(r['execute'] and r['read'] for r in mapped), 'LIBRARY_NOT_EXECUTABLE_MAPPED')
    _check(all(r['offset'] < identity['size'] for r in mapped), 'MAPPING_OFFSET_RANGE')
    return len(mapped)


def validate_loaded_library(evidence, expected_lanes):
    """evidence: {'library', 'receipt', 'lanes': [3 lane records]}; expected_lanes: {lane: {'pid', 'nonce'}} from the driver."""
    _exact_dict(evidence, frozenset({'library', 'receipt', 'lanes'}), 'EVIDENCE_SHAPE')
    _exact_dict(expected_lanes, frozenset(LANES), 'EXPECTED_LANES')
    for lane in LANES:
        value = expected_lanes[lane]
        _exact_dict(value, frozenset({'pid', 'nonce'}), 'EXPECTED_LANES')
        _check(_int(value['pid']) and value['pid'] > 0 and type(value['nonce']) is str and NONCE.fullmatch(value['nonce']),
               'EXPECTED_LANES')
    _check(len({expected_lanes[lane]['pid'] for lane in LANES}) == 3, 'EXPECTED_LANES')
    identity = validate_library_record(evidence['library'])
    receipt = validate_receipt_record(evidence['receipt'])
    lanes = evidence['lanes']
    _check(type(lanes) is list and len(lanes) == 3, 'LANE_SET')
    seen = {}
    for record in lanes:
        _exact_dict(record, LANE_KEYS, 'LANE_RECORD_SHAPE')
        lane = record['lane']
        _check(lane in LANES and lane not in seen, 'LANE_SET')
        _check(record['phase'] == PHASES[lane], 'LANE_PHASE')
        _check(_int(record['pid']) and record['pid'] == expected_lanes[lane]['pid'], 'LANE_PID')
        _check(record['nonce'] == expected_lanes[lane]['nonce'], 'LANE_NONCE')
        seen[lane] = validate_lane_maps(record['maps'], identity)
    _check(sorted(seen) == list(LANES), 'LANE_SET')
    return {
        'status': STATUS,
        'hook_chain_activation': 'UNRESOLVED',
        'library': {'path': EXPECTED_LIBRARY_PATH, 'sha256': EXPECTED_LIBRARY_SHA256,
                    'device': '%x:%x' % (identity['major'], identity['minor']), 'inode': identity['inode']},
        'receipt_sha256': receipt,
        'lane_pids': {lane: expected_lanes[lane]['pid'] for lane in LANES},
        'mapped_segments': dict(seen),
        'limitations': ['maps+hash shows loaded-artifact correspondence, not the function-pointer hook chain',
                        'observer namespace/PID derivation and overlay device semantics are validated elsewhere'],
    }
