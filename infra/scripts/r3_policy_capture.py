"""Bounded, descriptor-relative policy reads. No system mutation or arbitrary CLI."""
import base64
import os
from pathlib import Path
import stat

from r3_noble_common import digest

LIMIT = 8 * 1024 * 1024
BODY_LIMIT = 128 * 1024
FIELDS = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode', 'st_uid', 'st_gid', 'st_nlink')


def same(left, right):
    if any(getattr(left, key) != getattr(right, key) for key in FIELDS):
        raise ValueError('CHANGED')


def directory(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in Path(path).parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def metadata(info):
    return {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode)}


def blob(data):
    return {'base64': base64.b64encode(data).decode(), 'bytes': len(data), 'sha256': digest(data)}


def file_record(path, body=False):
    try:
        parent = directory(str(Path(path).parent))
    except FileNotFoundError:
        return {'absent': True}
    try:
        try:
            fd = os.open(Path(path).name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
        except FileNotFoundError:
            return {'absent': True}
        try:
            before = os.fstat(fd)
            cap = BODY_LIMIT if body else LIMIT
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > cap:
                raise ValueError('UNSAFE_FILE')
            data = bytearray()
            while len(data) <= cap:
                block = os.read(fd, min(65536, cap + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
            same(before, os.fstat(fd))
            same(before, os.stat(Path(path).name, dir_fd=parent, follow_symlinks=False))
            if len(data) != before.st_size:
                raise ValueError('CHANGED')
            value = {**metadata(before), 'bytes': len(data), 'sha256': digest(data)}
            if body:
                value['body'] = blob(bytes(data))
            return value
        finally:
            os.close(fd)
    finally:
        os.close(parent)


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


def socket_record():
    try:
        fd = directory('/run/dbus')
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
