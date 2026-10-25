"""Bounded, descriptor-relative policy reads. No system mutation or arbitrary CLI."""
import base64
import os
from pathlib import Path
import stat

from r3_noble_common import digest

LIMIT = 8 * 1024 * 1024
BODY_LIMIT = 128 * 1024
FIELDS = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid', 'st_gid', 'st_nlink')
READ_STAGES = ('resolve-parent', 'open-file', 'stat-before', 'read', 'stat-after',
               'stat-path', 'close-file', 'close-parent')


class ReadError(OSError):
    """Fixed syscall context only; never retain exception text or filenames."""
    def __init__(self, stage, error):
        super().__init__()
        self.stage = stage
        self.errno = error.errno if type(error.errno) is int and 1 <= error.errno <= 4095 else None
        self.cleanup = []


def observed(stage, function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except TimeoutError:
        # Preserve the existing timeout classification, including cleanup.
        raise
    except OSError as exc:
        if isinstance(exc, FileNotFoundError) and stage in ('resolve-parent', 'open-file'):
            raise
        raise ReadError(stage, exc) from None


def close(fd, stage, primary=None):
    try:
        os.close(fd)
    except OSError as exc:
        failure = ReadError(stage, exc)
        if primary is None or isinstance(primary, FileNotFoundError):
            if isinstance(exc, TimeoutError):
                raise
            raise failure from None
        # Never replace an active timeout/outer deadline with an Exception that
        # the section handler could swallow. Snap OSErrors retain cleanup detail.
        if isinstance(primary, ReadError):
            primary.cleanup.append({'stage': failure.stage, 'errno': failure.errno})


def same(left, right):
    if any(getattr(left, key) != getattr(right, key) for key in FIELDS):
        raise ValueError('CHANGED')


def directory(path, root='/'):
    """`root` is only for tests on temporary trees; production reads `/`."""
    fd = observed('resolve-parent', os.open, root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            nxt = observed('resolve-parent', os.open, part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            previous, fd = fd, nxt
            close(previous, 'close-parent')
        return fd
    except BaseException as exc:
        close(fd, 'close-parent', exc)
        raise


def metadata(info):
    return {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def blob(data):
    return {'base64': base64.b64encode(data).decode(), 'bytes': len(data), 'sha256': digest(data)}


def file_record(path, body=False, root='/'):
    try:
        parent = directory(str(Path(path).parent), root)
    except FileNotFoundError:
        return {'absent': True}
    parent_error = None
    try:
        try:
            fd = observed('open-file', os.open, Path(path).name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
        except FileNotFoundError:
            return {'absent': True}
        file_error = None
        try:
            before = observed('stat-before', os.fstat, fd)
            cap = BODY_LIMIT if body else LIMIT
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > cap:
                raise ValueError('UNSAFE_FILE')
            data = bytearray()
            while len(data) <= cap:
                block = observed('read', os.read, fd, min(65536, cap + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
            same(before, observed('stat-after', os.fstat, fd))
            same(before, observed('stat-path', os.stat, Path(path).name, dir_fd=parent, follow_symlinks=False))
            if len(data) != before.st_size:
                raise ValueError('CHANGED')
            value = {**metadata(before), 'bytes': len(data), 'sha256': digest(data)}
            if body:
                value['body'] = blob(bytes(data))
            return value
        except BaseException as exc:
            file_error = exc
            raise
        finally:
            close(fd, 'close-file', file_error)
    except BaseException as exc:
        parent_error = exc
        raise
    finally:
        close(parent, 'close-parent', parent_error)


def membership(path, maximum=256):
    fd = directory(path)
    try:
        before = os.fstat(fd)
        names = []
        with os.scandir(fd) as entries:
            for entry in entries:
                if len(names) >= maximum:
                    raise ValueError('DIRECTORY_LIMIT')
                names.append(entry.name)
        same(before, os.fstat(fd))
        return {'metadata': metadata(before), 'names': sorted(names)}
    finally:
        os.close(fd)


def socket_record(root='/'):
    try:
        fd = directory('/run/dbus', root)
    except FileNotFoundError:
        return {'exists': False, 'socket': False}
    try:
        try:
            value = os.stat('system_bus_socket', dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return {'exists': False, 'socket': False}
        if not stat.S_ISSOCK(value.st_mode):
            raise ValueError('UNSAFE_SOCKET')
        return {'exists': True, 'socket': True}
    finally:
        os.close(fd)


def cache(root='/var/cache/man'):
    """No symlink recursion; bounded membership and total hashed bytes."""
    result, total = {}, 0
    def walk(path, relative):
        nonlocal total
        if len(result) >= 4096:
            raise ValueError('CACHE_LIMIT')
        fd = directory(path)
        try:
            before = os.fstat(fd)
            result[relative] = {'directory': True, **metadata(before)}
            names = membership(path, 4096)['names']
            for name in names:
                if len(result) >= 4096:
                    raise ValueError('CACHE_LIMIT')
                target = path + '/' + name
                key = name if relative == '.' else relative + '/' + name
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    walk(target, key)
                else:
                    value = file_record(target)
                    if value.get('absent'):
                        raise ValueError('CHANGED')
                    total += value['bytes']
                    if total > 32 * 1024 * 1024:
                        raise ValueError('CACHE_LIMIT')
                    result[key] = value
            same(before, os.fstat(fd))
        finally:
            os.close(fd)
    walk(root, '.')
    return result
