"""Published-source checks independent of operator Git environment and replace refs."""
import os
from pathlib import Path
import stat
import subprocess

from r3_noble_common import ENV, digest


def git(root, *args):
    env = {**ENV, 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null'}
    return subprocess.check_output(['git', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', str(root), *args],
                                   env=env, timeout=10)


def refuse_program_config(root):
    # Request only local key names (no included entries or values). Refuse
    # program-bearing configuration before status/object reads.
    keys = git(root, 'config', '--local', '--no-includes', '--null', '--name-only', '--list').decode().lower().split('\0')
    if any(key.startswith(('filter.', 'include.', 'includeif.', 'diff.'))
           or key in ('extensions.worktreeconfig', 'extensions.partialclone', 'core.worktree')
           or (key.startswith('remote.') and key.endswith('.promisor')) for key in keys):
        raise ValueError('Program-bearing Git configuration')
    path = Path(os.fsdecode(git(root, 'rev-parse', '--git-path', 'info/attributes')).rstrip('\n'))
    if not path.is_absolute():
        path = root / path
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_size != 0:
        raise ValueError('Unreviewed Git info attributes')


def verified_head(root, files):
    refuse_program_config(root)
    head = git(root, 'rev-parse', 'HEAD').decode().strip()
    # Status may recurse into child repositories with independent program
    # configuration. Inspect only index/tree metadata; never enter gitlinks.
    for listing in (git(root, 'ls-files', '--stage', '-z'), git(root, 'ls-tree', '-r', '-z', head)):
        if any(entry.startswith(b'160000 ') for entry in listing.split(b'\0')):
            raise ValueError('Gitlinks are outside verified source scope')
    if (git(root, 'status', '--porcelain', '--untracked-files=all')
            or git(root, 'status', '--porcelain', '--ignored', '--untracked-files=all',
                   '--', 'infra/scripts', 'infra/selfhost')):
        raise ValueError('Unclean source or ignored runtime files')
    for name, expected in files.items():
        if digest(git(root, 'show', head + ':' + name)) != expected:
            raise ValueError('Published source differs')
    return head
