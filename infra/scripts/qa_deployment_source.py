"""Read public historical Git blobs only; never execute historical code or fetch."""
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import tempfile
from qa_contract import ROOT, match, require, sha256
from qa_discovery import digest
from qa_foundation import CONFIG_FILES
from qa_application import CONFIG_FILES as APP_FILES


@contextmanager
def historical_source(source_sha):
    match(r'[a-f0-9]{40}', source_sha)
    paths = ['infra/terraform/foundation/qa', 'infra/terraform/application/qa',
             'infra/config/deployment-policy.json', 'pnpm-lock.yaml', 'packages/db/prisma/migrations']
    env = {'PATH': os.defpath, 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
    def git(*args):
        run = subprocess.run(['git', *args], cwd=ROOT, env=env, capture_output=True, timeout=30)
        require(run.returncode == 0)
        return run.stdout
    require(git('rev-parse', source_sha + '^{commit}').decode().strip() == source_sha)
    entries = git('ls-tree', '-rz', source_sha, '--', *paths).split(b'\0')
    names = [Path(entry.decode().split('\t')[1]) for entry in entries if entry]
    for folder, expected in ((paths[0], CONFIG_FILES), (paths[1], APP_FILES)):
        actual = {p.name for p in names if p.parent.as_posix() == folder and (p.name.endswith('.tf') or p.name.endswith('.tf.json'))}
        require(actual == expected)
    with tempfile.TemporaryDirectory(prefix='qa-unit8-history-') as directory:
        root = Path(directory)
        for entry in filter(None, entries):
            meta, name = entry.decode().split('\t')
            mode, kind, oid = meta.split()
            path = Path(name)
            # Never silently drop a symlink/gitlink that changes the source fingerprint universe.
            require(kind == 'blob' and mode in ('100644', '100755'))
            allowed = (name in paths[2:4] or
                       path.parent.as_posix() == paths[0] and path.name in CONFIG_FILES | {'.terraform.lock.hcl'} or
                       path.parent.as_posix() == paths[1] and path.name in APP_FILES | {'.terraform.lock.hcl'} or
                       path.match('packages/db/prisma/migrations/*/migration.sql'))
            if not allowed:
                continue
            require(mode == '100644' and kind == 'blob' and '..' not in path.parts and not path.is_absolute())
            content = git('cat-file', 'blob', oid)
            require(len(content) <= 4 * 1024 * 1024)
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        yield root


def bind_report(report, root, kind='foundation'):
    folder = root / 'infra/terraform' / kind / 'qa'
    names = CONFIG_FILES if kind == 'foundation' else APP_FILES
    require(report['provider_lock_sha256'] == sha256((folder / '.terraform.lock.hcl').read_bytes()))
    if 'configuration_sha256' in report:
        require(report['configuration_sha256'] == digest({n: sha256((folder / n).read_bytes()) for n in sorted(names)}))
    if 'deployment_policy_sha256' in report:
        require(report['deployment_policy_sha256'] == sha256((root / 'infra/config/deployment-policy.json').read_bytes()))
