"""Independent all-section readback; complete evidence is never eligibility."""
import base64
import re
from pathlib import PurePosixPath

from r3_noble_common import digest, encoded
from r3_package_state import inventory
from r3_install_policy import FIXED, DIRECTORIES
from r3_policy_capture import LIMIT, BODY_LIMIT, READ_STAGES
from r3_policy_evidence import COMMANDS, BODIES, EXTRA_FILES, DIRECTORY_NAMES, PURPOSE, ERRORS, SCOPES, load


def require(condition):
    if not condition:
        raise ValueError('Policy evidence correspondence/schema differs')


def sha(value):
    require(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None)


def blob(value, cap):
    require(isinstance(value, dict) and set(value) == {'base64', 'bytes', 'sha256'})
    require(type(value['bytes']) is int and 0 <= value['bytes'] <= cap)
    require(isinstance(value['base64'], str) and len(value['base64']) <= 4 * ((cap + 2) // 3))
    data = base64.b64decode(value['base64'], validate=True)
    require(len(data) == value['bytes'] and digest(data) == value['sha256'])
    return data


def metadata(value):
    require(all(type(value.get(k)) is int and 0 <= value[k] <= 2**32 - 1 for k in ('uid', 'gid')))
    require(type(value.get('mode')) is int and 0 <= value['mode'] <= 0o7777)


def file_record(value, body=False, absent=True):
    require(isinstance(value, dict))
    if absent and set(value) == {'absent'} and value['absent'] is True:
        return
    keys = {'uid', 'gid', 'mode', 'bytes', 'sha256'} | ({'body'} if body else set())
    require(set(value) == keys)
    metadata(value)
    sha(value['sha256'])
    require(type(value['bytes']) is int and 0 <= value['bytes'] <= (BODY_LIMIT if body else LIMIT))
    if body:
        data = blob(value['body'], BODY_LIMIT)
        require(digest(data) == value['sha256'] and len(data) == value['bytes'])


def member_name(name):
    require(isinstance(name, str) and 0 < len(name) <= 255
            and '/' not in name and '\0' not in name and name not in ('.', '..'))


def directory_record(value):
    require(isinstance(value, dict) and set(value) == {'metadata', 'names'})
    require(isinstance(value['metadata'], dict) and set(value['metadata']) == {'uid', 'gid', 'mode'})
    metadata(value['metadata'])
    names = value['names']
    require(isinstance(names, list) and len(names) <= 256)
    for name in names:
        member_name(name)
    require(names == sorted(set(names)))


def cache(value):
    require(isinstance(value, dict) and '.' in value and len(value) <= 4096)
    total = 0
    for name, item in value.items():
        require(isinstance(name, str) and (name == '.' or (not PurePosixPath(name).is_absolute()
                and str(PurePosixPath(name)) == name and '..' not in PurePosixPath(name).parts)))
        if name != '.':
            for part in PurePosixPath(name).parts:
                member_name(part)
            parent = str(PurePosixPath(name).parent)
            require(value.get(parent, {}).get('directory') is True)
        require(isinstance(item, dict))
        if item.get('directory') is True:
            require(set(item) == {'directory', 'uid', 'gid', 'mode'})
            metadata(item)
        else:
            file_record(item, absent=False)
            total += item['bytes']
    require(value['.'].get('directory') is True and total <= 32 * 1024 * 1024)


def read_context(value):
    require(isinstance(value, dict) and set(value) == {'format', 'stage', 'errno', 'cleanup'})
    require(type(value['format']) is int and value['format'] == 1)
    def failure(item, stages):
        require(item['stage'] in stages)
        require(item['errno'] is None or type(item['errno']) is int and 1 <= item['errno'] <= 4095)
    failure(value, READ_STAGES)
    require(isinstance(value['cleanup'], list) and len(value['cleanup']) <= 2)
    for item in value['cleanup']:
        require(isinstance(item, dict) and set(item) == {'stage', 'errno'})
        failure(item, ('close-file', 'close-parent'))


def section(value, check, allow_unreviewed=False, snap_context=False):
    require(isinstance(value, dict))
    state = value.get('state')
    if state == 'ok':
        require(set(value) == {'state', 'value'})
        check(value['value'])
        return True
    if state == 'not_reached':
        require(set(value) == {'state'})
        return False
    keys = ({'state', 'error'}, {'state', 'error', 'prior'})
    require(state == 'error' and (set(value) in keys or
            snap_context and set(value) == {'state', 'error', 'context'}))
    require(value['error'] in (*ERRORS, 'CHANGED', *(['UNREVIEWED_PATH'] if allow_unreviewed else [])))
    if 'context' in value:
        require(value['error'] == 'OSError')
        read_context(value['context'])
    if 'prior' in value:
        require(value['error'] in ('CHANGED', 'TimeoutError'))
        check(value['prior'])
    return False


def command(value, name):
    require(isinstance(value, dict) and set(value) == {'argv', 'stdout', 'stderr', 'returncode', 'failure'})
    require(value['argv'] == COMMANDS[name])
    blob(value['stdout'], 2 * 1024 * 1024)
    blob(value['stderr'], 2 * 1024 * 1024)
    require(value['returncode'] is None or type(value['returncode']) is int)
    require(value['failure'] is None or value['failure'] in ERRORS)


def scope(value, apt):
    from r3_policy_scope import check_apt, APT_ROOT, UNIT_ROOTS
    require(isinstance(value, dict) and set(value) == ({'directory', 'files'} if apt else {'paths', 'files'}))
    if apt:
        directory_record(value['directory'])
        require(all(n in DIRECTORY_NAMES[APT_ROOT] for n in value['directory']['names']))
        expected = {'/etc/apt/apt.conf', *(APT_ROOT + '/' + n for n in value['directory']['names'])}
    else:
        from r3_apt_observer import UNITS
        require(isinstance(value['paths'], dict) and set(value['paths']) == set(UNITS))
        require(all(path in [root + unit for root in UNIT_ROOTS] for unit, path in value['paths'].items()))
        expected = set(value['paths'].values())
    require(isinstance(value['files'], dict) and set(value['files']) == expected)
    for path, item in value['files'].items():
        file_record(item, True, absent=apt and path == '/etc/apt/apt.conf')
    if apt:
        check_apt(value)


def validate(data, binding):
    doc = load(data)
    require(isinstance(doc, dict) and set(doc) == {'format', 'purpose', 'binding', 'sections',
            'qualification', 'installation_success', 'policy_generated'})
    require(type(doc['format']) is int and doc['format'] == 1 and doc['purpose'] == PURPOSE
            and doc['binding'] == binding and all(doc[k] is False for k in
                ('qualification', 'installation_success', 'policy_generated')))
    sections = doc['sections']
    require(isinstance(sections, dict))
    expected = set(COMMANDS) | {'file:' + p for p in (*FIXED, *EXTRA_FILES)} | {'directory:' + p for p in DIRECTORIES} | set(SCOPES) | {'cache', 'dbus-socket'}
    complete, commands_ok, parsed = True, {}, None
    for name in COMMANDS:
        good = section(sections.get(name), lambda v, name=name: command(v, name))
        item = sections[name].get('value', {})
        good = good and item['returncode'] == 0 and item['failure'] is None
        if name in ('apt-config', 'unit-config', 'unit-paths', 'unit-paths-after') and good:
            good = blob(item['stderr'], 2 * 1024 * 1024) == b''
        commands_ok[name] = good
        complete &= good
    for path in DIRECTORIES:
        key = 'directory:' + path
        good = section(sections.get(key), directory_record)
        complete &= good
        item = sections[key].get('value', sections[key].get('prior', {}))
        for name in item.get('names', []):
            full = path + '/' + name
            expected.add('file:' + full)
            record = sections.get('file:' + full)
            known = name in DIRECTORY_NAMES[path]
            if not known:
                require(record == {'state': 'error', 'error': 'UNREVIEWED_PATH'})
                complete = False
            else:
                complete &= section(record, lambda v: file_record(v, True, absent=False))
    for path in (*FIXED, *EXTRA_FILES):
        complete &= section(sections.get('file:' + path), lambda v, path=path: file_record(v, path in BODIES),
                            snap_context=path == '/usr/bin/snap')
    complete &= section(sections.get('cache'), cache)
    def socket(v):
        require(v in ({'exists': False, 'socket': False}, {'exists': True, 'socket': True})
                and all(type(i) is bool for i in v.values()))
    complete &= section(sections.get('dbus-socket'), socket)
    require(set(sections) == expected)
    # Syntactically captured command failures/dirty audit are partial, not success.
    if commands_ok['inventory']:
        try:
            parsed = inventory(blob(sections['inventory']['value']['stdout'], 2 * 1024 * 1024).decode())
        except (ValueError, UnicodeError):
            complete = False
    if commands_ok['architecture']:
        complete &= blob(sections['architecture']['value']['stdout'], 2 * 1024 * 1024).strip() == b'amd64'
    release = sections['file:/usr/lib/os-release']
    if release['state'] == 'ok' and not release['value'].get('absent'):
        raw = blob(release['value']['body'], BODY_LIMIT)
        complete &= (re.findall(rb'^ID=(.*)$', raw, re.M) == [b'ubuntu']
                     and re.findall(rb'^VERSION_ID=(.*)$', raw, re.M) == [b'"24.04"'])
    else:
        complete = False
    if commands_ok['audit']:
        complete &= blob(sections['audit']['value']['stdout'], 2 * 1024 * 1024) == b''
    if commands_ok['unit-config']:
        from r3_apt_observer import UNITS
        raw = blob(sections['unit-config']['value']['stdout'], 2 * 1024 * 1024)
        complete &= all(re.search(rb'^# /[^\n]*/' + re.escape(unit.encode()) + rb'$', raw, re.M) for unit in UNITS)
    for name in SCOPES:
        complete &= section(sections.get(name), lambda v, name=name: scope(v, name.startswith('apt-')))
    for prefix in ('apt', 'unit'):
        before_scope = sections[prefix + '-scope-before']
        after_scope = sections[prefix + '-scope-after']
        complete &= before_scope['state'] == after_scope['state'] == 'ok' and before_scope == after_scope
    if sections['apt-scope-before']['state'] == 'ok':
        apt = sections['apt-scope-before']['value']
        for path, item in apt['files'].items():
            complete &= sections.get('file:' + path) == {'state': 'ok', 'value': item}
        complete &= sections['directory:/etc/apt/apt.conf.d'] == {'state': 'ok', 'value': apt['directory']}
    if sections['unit-scope-before']['state'] == 'ok' and commands_ok['unit-config']:
        from r3_policy_scope import unit_paths
        unit = sections['unit-scope-before']['value']
        for name in ('unit-paths', 'unit-paths-after'):
            if commands_ok[name]:
                try:
                    complete &= unit_paths(blob(sections[name]['value']['stdout'], 2 * 1024 * 1024)) == unit['paths']
                except (ValueError, UnicodeError):
                    complete = False
        for path, item in unit['files'].items():
            if path in FIXED:
                complete &= sections['file:' + path] == {'state': 'ok', 'value': item}
        raw = blob(sections['unit-config']['value']['stdout'], 2 * 1024 * 1024)
        from r3_apt_observer import UNITS
        def cat_body(name):
            body = blob(unit['files'][unit['paths'][name]]['body'], BODY_LIMIT)
            # systemd's line reader adds a newline only to an unterminated line.
            if body and not body.endswith(b'\n'):
                body += b'\n'
            return b'# ' + unit['paths'][name].encode() + b'\n' + body
        expected_text = b'\n'.join(cat_body(name) for name in UNITS)
        complete &= raw == expected_text
    service = sections['file:/usr/share/dbus-1/system-services/org.freedesktop.PackageKit.service']
    sock = sections['dbus-socket']
    predicate = None
    if service['state'] == sock['state'] == 'ok':
        predicate = not service['value'].get('absent', False) and sock['value']['exists']
    hashes = {}
    if complete:
        files = {key[5:]: {k: v for k, v in value['value'].items() if k != 'body'}
                 for key, value in sections.items() if key.startswith('file:') and key[5:] not in EXTRA_FILES}
        facts = {'files': files, 'directories': {p: sections['directory:' + p]['value']['names'] for p in DIRECTORIES},
                 'packagekit_activation_possible': predicate}
        hashes = {'inventory_sha256': digest(encoded(parsed)), 'facts_sha256': digest(encoded(facts)),
                  'cache_before_sha256': digest(encoded(sections['cache']['value'])),
                  **{key + '_sha256': sections[name]['value']['stdout']['sha256']
                     for name, key in (('apt-config', 'apt_config'), ('unit-config', 'unit_config'))}}
    return {'status': 'COLLECTED_REVIEW_REQUIRED' if complete else 'PARTIAL_REVIEW_REQUIRED',
            'packagekit_activation_possible': predicate, 'policy_input_hashes': hashes,
            'qualification': False, 'installation_success': False, 'policy_generated': False}
