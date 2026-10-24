"""Native dump read-scope guards. Before/after sampling is not snapshot isolation."""
import re

from r3_policy_capture import file_record, membership
from r3_policy_evidence import DIRECTORY_NAMES
from r3_apt_observer import UNITS

APT_ROOT = '/etc/apt/apt.conf.d'
UNIT_ROOTS = ('/usr/lib/systemd/system/', '/etc/systemd/system/', '/run/systemd/system/')


def apt_scope():
    directory = membership(APT_ROOT)
    if any(name not in DIRECTORY_NAMES[APT_ROOT] for name in directory['names']):
        raise ValueError('Unreviewed APT member')
    paths = ['/etc/apt/apt.conf', *(APT_ROOT + '/' + name for name in directory['names'])]
    value = {'directory': directory, 'files': {path: file_record(path, True) for path in paths}}
    check_apt(value)
    return value


def strip_comments(raw):
    """Keep quoted hook values while stripping APT's C/C++ comments."""
    result = bytearray()
    quoted, index = False, 0
    while index < len(raw):
        byte = raw[index:index + 1]
        if byte == b'"':
            quoted = not quoted
        if not quoted and raw[index:index + 2] == b'//':
            end = raw.find(b'\n', index + 2)
            index = len(raw) if end < 0 else end
            continue
        if not quoted and raw[index:index + 2] == b'/*':
            end = raw.find(b'*/', index + 2)
            if end < 0:
                raise ValueError('Unclosed APT comment')
            index = end + 2
            continue
        result.extend(byte)
        index += 1
    if quoted:
        raise ValueError('Unclosed APT quote')
    return bytes(result)


def apt28_comment_view(raw):
    """Port of APT 2.8.2 configuration.cc physical-line comment preprocessing.

    Deliberately only the comment view; not a complete APT parser/approval.
    Pending block comments span physical lines; quote parity never does.
    """
    fragments, in_comment = [], False
    for physical in raw.split(b'\n'):
        line = physical.replace(b'\t', b'        ').strip()
        if in_comment:
            end = line.find(b'*/')
            if end < 0:
                continue
            line = line[end + 2:]
            in_comment = False
        for marker in (b'//', b'#'):
            start = 0
            while True:
                start = line.find(marker, start)
                if start < 0:
                    break
                magic = marker == b'#' and any(line[start + 1:].startswith(m) for m in (b'clear', b'include', b'x-apt-configure-index'))
                if line[:start].count(b'"') % 2 or magic:
                    start += 1
                    continue
                line = line[:start]
                break
        pieces, start = [], 0
        while True:
            start = line.find(b'/*', start)
            if start < 0:
                break
            if line[:start].count(b'"') % 2:
                start += 2
                continue
            pieces.append(line[:start])
            end = line.find(b'*/', start + 2)
            if end < 0:
                line, in_comment = b'', True
                break
            line = line[end + 2:]
            start = 0
        pieces.append(line)
        fragments.append(b''.join(pieces))
    if in_comment:
        raise ValueError('Unclosed APT block comment')
    return b'\n'.join(fragments)

def normalized(raw):
    # APT ParseQuoteWord removes quotes, then decodes percent hex once.
    return re.sub(rb'%([A-Fa-f0-9]{2})', lambda m: bytes([int(m[1], 16)]), raw.replace(b'"', b''))


def check_apt(value):
    import base64
    for path, item in value['files'].items():
        if item.get('absent'):
            if path != '/etc/apt/apt.conf':
                raise ValueError('Changed APT member')
            continue
        raw = base64.b64decode(item['body']['base64'], validate=True)
        # APT 2.8 configuration.cc + strutl.cc: both include directives read
        # files; quoted/percent-encoded tags and C/C++ comments are accepted.
        # Scan both views so literal comment markers inside hook values cannot
        # hide directives. Mentioning a dangerous token in a value also refuses.
        for view in (normalized(raw), normalized(strip_comments(raw)), normalized(apt28_comment_view(raw))):
            if re.search(rb'#\s*(?:include|x-apt-configure-index)\b|\b(?:Dir|RootDir)\b', view, re.I):
                raise ValueError('APT scope redirection')


def unit_paths(raw):
    text = raw.decode()
    records = text.strip().split('\n\n')
    result = {}
    for record in records:
        pairs = [line.split('=', 1) for line in record.splitlines()]
        if any(len(pair) != 2 for pair in pairs) or len(pairs) != 4:
            raise ValueError('Malformed unit path query')
        item = dict(pairs)
        if set(item) != {'Id', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload'} or item['Id'] in result or item['Id'] not in UNITS:
            raise ValueError('Unexpected unit path query')
        if item['NeedDaemonReload'] != 'no' or item['DropInPaths'] or item['FragmentPath'] not in [root + item['Id'] for root in UNIT_ROOTS]:
            raise ValueError('Unreviewed unit fragment/drop-in path')
        result[item['Id']] = item['FragmentPath']
    if set(result) != set(UNITS):
        raise ValueError('Incomplete unit paths')
    return result


def unit_scope(raw):
    paths = unit_paths(raw)
    files = {path: file_record(path, True) for path in paths.values()}
    if any(value.get('absent') for value in files.values()):
        raise ValueError('Missing unit fragment')
    return {'paths': paths, 'files': files}
