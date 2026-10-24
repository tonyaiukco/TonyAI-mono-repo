"""Fixed-leaf metadata diagnostic; never open or resolve the snap link target."""
import base64
import os
import stat

from r3_noble_common import digest, encoded

PURPOSE = 'FIXTURE_SNAP_LEAF_DIAGNOSTIC'
OBSERVED = 'DIAGNOSTIC_OBSERVED_REVIEW_REQUIRED'
PARTIAL = 'PARTIAL_REVIEW_REQUIRED'
FIELDS = ('st_dev', 'st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
          'st_size', 'st_mtime_ns', 'st_ctime_ns')
STAGES = ('open-parent', 'before', 'link-before', 'after', 'link-after',
          'reopen-parent', 'compare', 'complete')


def require(value):
    if not value:
        raise ValueError('Snap diagnostic contract differs')


def metadata(value):
    return {name: getattr(value, name) for name in FIELDS}


def open_parent(held):
    """Retain every no-follow directory descriptor until final cleanup."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    held.append(fd)
    for name in ('usr', 'bin'):
        fd = os.open(name, flags, dir_fd=fd)
        held.append(fd)
    return fd


def leaf(parent):
    try:
        return metadata(os.stat(b'snap', dir_fd=parent, follow_symlinks=False))
    except FileNotFoundError:
        return None


def kind(value):
    if value is None:
        return 'absent'
    mode = value['st_mode']
    if stat.S_ISLNK(mode):
        return 'symlink'
    return 'regular' if stat.S_ISREG(mode) else 'unsupported'


def link(parent, value):
    if kind(value) != 'symlink':
        return None
    require(value['st_size'] <= 4096)
    raw = os.readlink(b'snap', dir_fd=parent)
    require(isinstance(raw, bytes) and 0 < len(raw) <= 4096 and len(raw) == value['st_size'])
    return {'base64': base64.b64encode(raw).decode('ascii'), 'bytes': len(raw),
            'sha256': digest(raw)}


def failure(exc):
    return {'type': 'TimeoutError' if isinstance(exc, TimeoutError) else
            'OSError' if isinstance(exc, OSError) else 'ValueError',
            'errno': exc.errno if isinstance(exc, OSError) and not isinstance(exc, TimeoutError) else None}


def observe(binding):
    """Caller provides fixture identity and cooperative deadline; no CLI or I/O scope input."""
    value = {'format': 1, 'purpose': PURPOSE, 'binding': binding,
             'fixed_path': '/usr/bin/snap', 'status': PARTIAL, 'stage': 'open-parent',
             'parent_before': None, 'parent_after': None, 'parent_reopened': None,
             'leaf_before': None, 'leaf_after': None, 'link_before': None, 'link_after': None,
             'leaf_kind': None, 'error': None, 'cleanup_errors': [],
             'policy_generated': False, 'qualification': False, 'installation_success': False}
    held = []
    try:
        parent = open_parent(held)
        value['stage'] = 'before'
        value['parent_before'] = metadata(os.fstat(parent))
        value['leaf_before'] = leaf(parent)
        value['leaf_kind'] = kind(value['leaf_before'])
        require(value['leaf_kind'] != 'unsupported')
        value['stage'] = 'link-before'
        value['link_before'] = link(parent, value['leaf_before'])
        value['stage'] = 'after'
        value['leaf_after'] = leaf(parent)
        value['parent_after'] = metadata(os.fstat(parent))
        value['stage'] = 'link-after'
        value['link_after'] = link(parent, value['leaf_after'])
        value['stage'] = 'reopen-parent'
        value['parent_reopened'] = metadata(os.fstat(open_parent(held)))
        value['stage'] = 'compare'
        require(value['parent_before'] == value['parent_after'] == value['parent_reopened'])
        require(value['leaf_before'] == value['leaf_after'] and value['link_before'] == value['link_after'])
        value.update(stage='complete', status=OBSERVED)
    except (OSError, ValueError, TimeoutError) as exc:
        value['error'] = failure(exc)
    finally:
        for fd in reversed(held):
            try:
                os.close(fd)
            except (OSError, TimeoutError) as exc:
                value['cleanup_errors'].append(failure(exc))
                value['status'] = PARTIAL
    return value


def check_metadata(value, directory=False):
    if value is None:
        return
    require(isinstance(value, dict) and set(value) == set(FIELDS))
    require(all(type(x) is int and 0 <= x < 2**64 for x in value.values()))
    require(value['st_mode'] <= 0o177777)
    if directory:
        require(stat.S_ISDIR(value['st_mode']))


def check_link(value, meta):
    if value is None:
        return
    require(kind(meta) == 'symlink' and meta['st_size'] <= 4096)
    require(isinstance(value, dict) and set(value) == {'base64', 'bytes', 'sha256'})
    require(type(value['bytes']) is int and 0 < value['bytes'] <= 4096)
    require(isinstance(value['base64'], str) and len(value['base64']) <= 5464)
    raw = base64.b64decode(value['base64'], validate=True)
    require(len(raw) == value['bytes'] == meta['st_size'] and base64.b64encode(raw).decode() == value['base64']
            and digest(raw) == value['sha256'])


def check_error(value):
    require(isinstance(value, dict) and set(value) == {'type', 'errno'})
    require(value['type'] in ('OSError', 'TimeoutError', 'ValueError'))
    number = value['errno']
    require(number is None or type(number) is int and 0 <= number <= 4095)
    require(value['type'] == 'OSError' or number is None)


def validate(value, binding):
    keys = {'format', 'purpose', 'binding', 'fixed_path', 'status', 'stage', 'parent_before',
            'parent_after', 'parent_reopened', 'leaf_before', 'leaf_after', 'link_before',
            'link_after', 'leaf_kind', 'error', 'cleanup_errors', 'policy_generated',
            'qualification', 'installation_success'}
    require(isinstance(value, dict) and set(value) == keys and len(encoded(value)) <= 16384)
    require(type(value['format']) is int and value['format'] == 1 and value['purpose'] == PURPOSE)
    require(encoded(value['binding']) == encoded(binding) and value['fixed_path'] == '/usr/bin/snap')
    require(value['status'] in (OBSERVED, PARTIAL) and value['stage'] in STAGES)
    require(all(value[k] is False for k in ('policy_generated', 'qualification', 'installation_success')))
    require(value['leaf_kind'] in (None, 'absent', 'regular', 'symlink', 'unsupported'))
    for key in ('parent_before', 'parent_after', 'parent_reopened'):
        check_metadata(value[key], directory=True)
    for suffix in ('before', 'after'):
        check_metadata(value['leaf_' + suffix])
        check_link(value['link_' + suffix], value['leaf_' + suffix])
    require(isinstance(value['cleanup_errors'], list) and len(value['cleanup_errors']) <= 6)
    for error in value['cleanup_errors'] + ([value['error']] if value['error'] is not None else []):
        check_error(error)
    if value['status'] == OBSERVED:
        require(value['stage'] == 'complete' and value['error'] is None and not value['cleanup_errors'])
        require(value['parent_before'] is not None and
                value['parent_before'] == value['parent_after'] == value['parent_reopened'])
        require(value['leaf_before'] == value['leaf_after'] and value['link_before'] == value['link_after'])
        require(value['leaf_kind'] == kind(value['leaf_before']) != 'unsupported')
        require((value['link_before'] is not None) == (value['leaf_kind'] == 'symlink'))
    else:
        require(value['error'] is not None or bool(value['cleanup_errors']))
    return {'status': value['status'], 'policy_generated': False, 'qualification': False}
