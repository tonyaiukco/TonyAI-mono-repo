"""Offline packet preparation. No SSH, cloud access or accepted policy generation."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import sys

# Direct CLI execution loads repository helpers from source, even with a stale
# unchecked-hash .pyc beside them. -B alone only disables cache writes.
if __name__ == '__main__':
    import tempfile
    _source_cache = tempfile.TemporaryDirectory(prefix='r3-policy-source-cache-')
    sys.pycache_prefix = _source_cache.name
    sys.dont_write_bytecode = True

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_noble_common import digest, encoded, read, write
from r3_policy_evidence import B_PURPOSE
from r3_policy_git import verified_head

ROOT = Path(__file__).resolve().parents[2]
MODULES = ('r3_noble_common', 'r3_package_state', 'r3_apt_observer', 'r3_install_policy', 'r3_packagekit_state',
           'r3_policy_capture', 'r3_policy_snap', 'r3_policy_scope', 'r3_policy_evidence', 'r3_policy_validate', 'r3_policy_target')
PACKET_HELPERS = ('r3_policy_git.py', 'r3_policy_receive.py', 'r3_policy_packet.py', 'r3_noble_inputs.py', 'r3_toolchain.py', 'r3_artifacts.py')


def sources():
    return {'infra/scripts/' + name + '.py': digest(read(ROOT / 'infra/scripts' / (name + '.py')))
            for name in MODULES} | {'infra/scripts/' + n: digest(read(ROOT / 'infra/scripts' / n)) for n in PACKET_HELPERS} | {'infra/selfhost/r3-toolchain.lock.json': digest(read(ROOT / 'infra/selfhost/r3-toolchain.lock.json'))}


def payload(proposal):
    """In-memory importer: no helper upload, installation or guest source files."""
    modules = {name: base64.b64encode(read(ROOT / 'infra/scripts' / (name + '.py'))).decode() for name in MODULES}
    return ('''import base64, hashlib, importlib.abc, importlib.util, json, sys
modules = json.loads(%r)
proposal = json.loads(%r)
class Loader(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        return importlib.util.spec_from_loader(fullname, self) if fullname in modules else None
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        data = base64.b64decode(modules[module.__name__], validate=True)
        key = 'infra/scripts/' + module.__name__ + '.py'
        if hashlib.sha256(data).hexdigest() != proposal['source']['files'][key]:
            raise ValueError('Source correspondence differs')
        exec(compile(data, '<reviewed-collection/' + module.__name__ + '>', 'exec'), module.__dict__)
sys.meta_path.insert(0, Loader())
from r3_policy_target import main
raise SystemExit(main(proposal))
''' % (encoded(modules).decode(), encoded(proposal).decode())).encode()


def prepare(destination, supplied=None):
    destination.mkdir(mode=0o700)
    files = sources()
    try:
        base_sha = verified_head(ROOT, files)
    except (ValueError, subprocess.CalledProcessError):
        # Development drafts bind file hashes but never claim a verified commit.
        base_sha = None
    proposal = {'format': 1, 'purpose': B_PURPOSE,
                'source': {'base_sha': base_sha,
                           'published_sha': None, 'files': files, 'sha256': digest(encoded(files))},
                'target': None, 'custody': None, 'execution_authorized': False,
                'historical_B_rebound': False}
    if supplied is not None:
        from r3_policy_validate import require
        require(supplied['purpose'] == B_PURPOSE and supplied['source']['files'] == files
                and supplied['source']['sha256'] == digest(encoded(files))
                and supplied['execution_authorized'] is False and supplied['historical_B_rebound'] is False)
        proposal = supplied
    # Missing target/custody/publication stay null; the runtime rejects this draft.
    write(destination / 'proposal.json', encoded(proposal))
    write(destination / 'guest.py', payload(proposal))
    write(destination / 'packet.json', encoded({'proposal_sha256': digest(encoded(proposal)),
          'guest_sha256': digest(read(destination / 'guest.py')),
          'state': 'PREPARED_UNAPPROVED_UNEXECUTED'}))
    return proposal


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', required=True, type=Path)
    parser.add_argument('--proposal', type=Path, help='Separately completed exact proposal; never an old B packet')
    args = parser.parse_args()
    from r3_policy_evidence import load
    prepare(args.destination, load(read(args.proposal)) if args.proposal else None)
