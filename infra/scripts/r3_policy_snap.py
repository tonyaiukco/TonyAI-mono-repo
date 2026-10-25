"""Evidence-only record for the one known snap alias. Never follows links generally.

`/usr/bin/snap` on Ubuntu 24.04 is a relative symbolic link to
`../lib/snapd/snapd`. The shared collector opens files with O_NOFOLLOW, so the
alias itself ends in ELOOP. This record states what the alias is without
opening it: absent, a regular file, or exactly the known link, in which case
the fixed target path is opened independently, again with O_NOFOLLOW. A regular
alias (older snapd ships the binary itself) and the link target are streamed
into a digest under the same cap. Any other link, type or drift is refused,
never hashed.
Completeness here is collection evidence only; it never enters installer facts.
"""
import hashlib
import os
import stat
import time

import r3_policy_capture as capture

SECTION = 'snap:/usr/bin/snap'
# Format 2 streams a regular-file alias under TARGET_LIMIT (owner decision
# 2026-10-25); format 1 read it with the shared 8 MiB file reader.
FORMAT = 2
ALIAS_PARENT, ALIAS_NAME = '/usr/bin', 'snap'
LINK = b'../lib/snapd/snapd'
TARGET_PARENT, TARGET_NAME = '/usr/lib/snapd', 'snapd'
LINK_LIMIT = 4096
TARGET_LIMIT = 64 * 1024 * 1024
KINDS = ('absent', 'regular', 'known-alias')
REFUSALS = ('UNEXPECTED_ALIAS', 'UNSUPPORTED_TYPE', 'TARGET_UNSAFE', 'TARGET_LIMIT', 'REGULAR_UNSAFE', 'REGULAR_LIMIT')
# Own stages plus the shared reader's, which a regular-file alias still uses.
STAGES = tuple(dict.fromkeys(('resolve-parent', 'stat-parent', 'stat-alias', 'read-link', 'open-target', 'open-alias',
                              *capture.READ_STAGES)))


class Refusal(ValueError):
    """A reviewed, fixed refusal code; carries no path or host text."""
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def parent_record(fd):
    return capture.metadata(capture.observed('stat-parent', os.fstat, fd))


def recheck(path, held, check=None):
    """Reopen the path chain: it must still name the held directory (device and
    inode), so a rename swap during the read is refused; `check` then reads the
    leaf again through the reopened chain."""
    again = capture.directory(path)
    error = None
    try:
        now, before = (capture.observed('stat-parent', os.fstat, fd) for fd in (again, held))
        if (now.st_dev, now.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('CHANGED')
        if check is not None:
            check(again)
    except BaseException as exc:
        error = exc
        raise
    finally:
        capture.close(again, 'close-parent', error)


def alias_state(parent):
    """lstat plus, for a link, its bounded bytes; the alias is never opened."""
    try:
        info = os.stat(ALIAS_NAME, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise capture.ReadError('stat-alias', exc) from None
    if not stat.S_ISLNK(info.st_mode):
        return info, None
    if info.st_size > LINK_LIMIT:
        raise Refusal('UNEXPECTED_ALIAS')
    return info, capture.observed('read-link', os.readlink, ALIAS_NAME.encode(), dir_fd=parent)


def leaf(parent, name, deadline, stage, unsafe, limit):
    """One fixed name under a held directory, opened with O_NOFOLLOW and streamed
    into a digest; returns its fstat and record. Refusal codes are the caller's."""
    fd = capture.observed(stage, os.open, name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
    file_error = None
    try:
        before = capture.observed('stat-before', os.fstat, fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise Refusal(unsafe)
        if before.st_size > TARGET_LIMIT:
            raise Refusal(limit)
        hashed, count = hashlib.sha256(), 0
        while count <= TARGET_LIMIT:
            if time.monotonic() >= deadline:
                raise TimeoutError('Deadline')
            block = capture.observed('read', os.read, fd, min(65536, TARGET_LIMIT + 1 - count))
            if not block:
                break
            hashed.update(block)
            count += len(block)
        capture.same(before, capture.observed('stat-after', os.fstat, fd))
        capture.same(before, capture.observed('stat-path', os.stat, name, dir_fd=parent, follow_symlinks=False))
        if count != before.st_size:
            raise ValueError('CHANGED')
        return before, {**capture.metadata(before), 'bytes': count, 'sha256': hashed.hexdigest()}
    except BaseException as exc:
        file_error = exc
        raise
    finally:
        capture.close(fd, 'close-file', file_error)


def target(deadline):
    """The fixed target path, opened on its own with O_NOFOLLOW and streamed into a digest."""
    parent = capture.directory(TARGET_PARENT)
    parent_error = None
    try:
        directory = parent_record(parent)
        before, record = leaf(parent, TARGET_NAME, deadline, 'open-target', 'TARGET_UNSAFE', 'TARGET_LIMIT')
        if parent_record(parent) != directory:
            raise ValueError('CHANGED')
        recheck(TARGET_PARENT, parent, lambda again: capture.same(before, capture.observed(
            'stat-path', os.stat, TARGET_NAME, dir_fd=again, follow_symlinks=False)))
        return {'parent': directory, **record}
    except BaseException as exc:
        parent_error = exc
        raise
    finally:
        capture.close(parent, 'close-parent', parent_error)


def observe(deadline):
    try:
        parent = capture.directory(ALIAS_PARENT)
    except FileNotFoundError:
        raise ValueError('CHANGED') from None
    parent_error = None
    try:
        directory = parent_record(parent)
        try:
            info, link = alias_state(parent)
        except FileNotFoundError:
            return {'format': FORMAT, 'kind': 'absent', 'alias': {'parent': directory}}
        if stat.S_ISREG(info.st_mode):
            before, value = leaf(parent, ALIAS_NAME, deadline, 'open-alias', 'REGULAR_UNSAFE', 'REGULAR_LIMIT')
            # The opened file must be the one the lstat named.
            capture.same(info, before)
            recheck(ALIAS_PARENT, parent, lambda again: capture.same(before, capture.observed(
                'stat-path', os.stat, ALIAS_NAME, dir_fd=again, follow_symlinks=False)))
            if parent_record(parent) != directory:
                raise ValueError('CHANGED')
            return {'format': FORMAT, 'kind': 'regular', 'alias': {'parent': directory}, 'file': value}
        if link is None:
            raise Refusal('UNSUPPORTED_TYPE')
        if link != LINK:
            raise Refusal('UNEXPECTED_ALIAS')
        resolved = target(deadline)
        def unchanged(fd):
            try:
                again, link_again = alias_state(fd)
            except FileNotFoundError:
                raise ValueError('CHANGED') from None
            capture.same(info, again)
            if link_again != link:
                raise ValueError('CHANGED')
        unchanged(parent)
        recheck(ALIAS_PARENT, parent, unchanged)
        if parent_record(parent) != directory:
            raise ValueError('CHANGED')
        return {'format': FORMAT, 'kind': 'known-alias',
                'alias': {'parent': directory, 'leaf': capture.metadata(info), 'link': link.decode('ascii')},
                'target': resolved}
    except BaseException as exc:
        parent_error = exc
        raise
    finally:
        capture.close(parent, 'close-parent', parent_error)


def operation(function):
    """Section value for the collector: refusals keep their code, OSErrors a bounded context."""
    try:
        return {'state': 'ok', 'value': function()}
    except Refusal as exc:
        return {'state': 'error', 'error': exc.code}
    except ValueError as exc:
        # Drift keeps its own code; any other ValueError stays the class name.
        if type(exc) is ValueError and exc.args == ('CHANGED',):
            return {'state': 'error', 'error': 'CHANGED'}
        from r3_policy_evidence import error_code
        return {'state': 'error', 'error': error_code(exc)}
    except Exception as exc:
        from r3_policy_evidence import error_code
        result = {'state': 'error', 'error': error_code(exc)}
        if isinstance(exc, capture.ReadError):
            result['context'] = {'format': 2, 'stage': exc.stage, 'errno': exc.errno, 'cleanup': exc.cleanup}
        return result


# Pure readback below: no filesystem access.

def require(condition):
    if not condition:
        raise ValueError('Snap evidence schema differs')


def metadata(value):
    require(isinstance(value, dict) and set(value) == {'uid', 'gid', 'mode'})
    require(all(type(value[k]) is int and 0 <= value[k] <= 2**32 - 1 for k in ('uid', 'gid')))
    require(type(value['mode']) is int and 0 <= value['mode'] <= 0o7777)


def streamed(item):
    require(isinstance(item, dict) and set(item) == {'uid', 'gid', 'mode', 'bytes', 'sha256'})
    metadata({k: item[k] for k in ('uid', 'gid', 'mode')})
    require(type(item['bytes']) is int and 0 <= item['bytes'] <= TARGET_LIMIT)
    require(isinstance(item['sha256'], str) and len(item['sha256']) == 64 and
            all(c in '0123456789abcdef' for c in item['sha256']))


def validate_record(value, file_record):
    """Strict schema; returns whether the record is complete collection evidence."""
    require(isinstance(value, dict) and type(value.get('format')) is int and value['format'] in (1, FORMAT))
    kind = value.get('kind')
    require(kind in KINDS)
    alias = value.get('alias')
    require(isinstance(alias, dict))
    metadata(alias.get('parent'))
    if kind == 'absent':
        require(set(value) == {'format', 'kind', 'alias'} and set(alias) == {'parent'})
        parents = [alias['parent']]
    elif kind == 'regular':
        require(set(value) == {'format', 'kind', 'alias', 'file'} and set(alias) == {'parent'})
        if value['format'] == 1:
            file_record(value['file'], False, absent=False)
        else:
            streamed(value['file'])
        parents = [alias['parent']]
    else:
        require(set(value) == {'format', 'kind', 'alias', 'target'} and set(alias) == {'parent', 'leaf', 'link'})
        metadata(alias['leaf'])
        require(alias['link'] == LINK.decode('ascii'))
        item = value['target']
        require(isinstance(item, dict) and set(item) == {'parent', 'uid', 'gid', 'mode', 'bytes', 'sha256'})
        metadata(item['parent'])
        streamed({k: v for k, v in item.items() if k != 'parent'})
        parents = [alias['parent'], item['parent']]
    # Owner decision 2026-10-25: complete only under root-owned parents that
    # neither group nor others can write.
    return all(p['uid'] == 0 and p['mode'] & 0o022 == 0 for p in parents)


def validate_context(value):
    require(isinstance(value, dict) and set(value) == {'format', 'stage', 'errno', 'cleanup'})
    require(type(value['format']) is int and value['format'] == 2 and value['stage'] in STAGES)
    def errno(item):
        require(item['errno'] is None or type(item['errno']) is int and 1 <= item['errno'] <= 4095)
    errno(value)
    # At most four descriptors are open at once: a reopened chain during a recheck,
    # the target file, the target parent and the alias parent.
    require(isinstance(value['cleanup'], list) and len(value['cleanup']) <= 4)
    for item in value['cleanup']:
        require(isinstance(item, dict) and set(item) == {'stage', 'errno'} and item['stage'] in ('close-file', 'close-parent'))
        errno(item)
