"""Offline-only recovery draft renderer. It cannot approve or dispatch a repair."""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import sys
import uuid

if __name__ == '__main__':
    import tempfile
    _cache = tempfile.TemporaryDirectory(prefix='r3-access-source-cache-')
    sys.pycache_prefix = _cache.name
    sys.dont_write_bytecode = True

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_noble_common import digest, encoded, read, write
from r3_policy_packet import MODULES as COLLECTION_MODULES, PACKET_HELPERS
from r3_policy_git import verified_head
from r3_policy_evidence import load
from r3_access_repair import public_line, require
from r3_policy_target import IMDS_FIELDS

ROOT = Path(__file__).resolve().parents[2]
MODULES = (*COLLECTION_MODULES, 'r3_access_repair', 'r3_access_repair_guest', 'r3_access_repair_export', 'r3_access_identity_diagnostic')
HELPERS = tuple(dict.fromkeys(('r3_access_repair_packet', 'r3_policy_packet',
    'r3_access_repair_contract', 'r3_access_repair_control', 'r3_access_repair_transport',
    'r3_access_repair_custody', 'r3_access_repair_receive',
    *(name.removesuffix('.py') for name in PACKET_HELPERS))))


def source_map():
    return {'infra/scripts/' + name + '.py': digest(read(ROOT / 'infra/scripts' / (name + '.py')))
            for name in (*MODULES, *HELPERS)}


def payload(proposal):
    modules = {name: base64.b64encode(read(ROOT / 'infra/scripts' / (name + '.py'))).decode()
               for name in MODULES}
    # Same source-only importer pattern as collection, with a distinct entry
    # module. Importing identity helpers never calls a collector entry point.
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
        exec(compile(data, '<reviewed-access-repair/' + module.__name__ + '>', 'exec'), module.__dict__)
sys.meta_path.insert(0, Loader())
from r3_access_repair_guest import main
result = main(proposal)
summary = {key: result[key] for key in ('status', 'phase', 'failure', 'cleanup_errors',
    'access_verified', 'qualification', 'installation_success', 'evidence_path')}
summary['pre_close_result_sha256'] = result['pre_close_result_sha256']
summary['finalization'] = {key: result[key] for key in ('status', 'cleanup_errors')}
summary['identity_stable'] = result['identity_before'] is not None and result['identity_before'] == result['identity_after']
summary['append'] = result['append']
data = json.dumps(summary, sort_keys=True).encode()
if len(data) > 4096:
    raise ValueError('Summary bound exceeded')
sys.stdout.buffer.write(data + b'\\n')
raise SystemExit(0 if result['status'] == 'KEY_APPENDED_REVIEW_REQUIRED' else 2)
''' % (encoded(modules).decode(), encoded(proposal).decode())).encode()


def export_payload(proposal):
    prefix = payload(proposal).split(b'from r3_access_repair_guest import main\n', 1)[0]
    return prefix + b'''from r3_access_repair_export import export
result = export(proposal)
data = json.dumps(result, sort_keys=True).encode()
if len(data) > 512 * 1024:
    raise ValueError('Export bound exceeded')
sys.stdout.buffer.write(data + b'\\n')
raise SystemExit(0 if result['status'] == 'EXPORTED_REVIEW_REQUIRED' else 2)
'''


def diagnostic_payload(proposal):
    prefix = payload(proposal).split(b'from r3_access_repair_guest import main\n', 1)[0]
    return prefix + b'''from r3_access_identity_diagnostic import main
result = main(proposal)
data = json.dumps(result, sort_keys=True).encode()
if len(data) > 4096:
    raise ValueError('Diagnostic bound exceeded')
sys.stdout.buffer.write(data + b'\\n')
'''


def prepare(destination, target_proposal, public_key, public_key_sha256, bindings=None, *, identity_diagnostic=False):
    from r3_access_repair_contract import PURPOSE, requests
    raw = read(public_key)
    public_line(raw, public_key_sha256)
    retained_raw = read(target_proposal)
    retained = load(retained_raw)
    imds = retained.get('target', {}).get('imds')
    require(isinstance(imds, dict) and set(imds) == set(IMDS_FIELDS) and
            all(isinstance(v, str) and 0 < len(v) <= 2048 for v in imds.values()), 'TARGET')
    files = source_map()
    try:
        candidate = verified_head(ROOT, files)
    except (ValueError, subprocess.CalledProcessError):
        candidate = None
    bindings = {} if bindings is None else bindings
    published = bindings.get('published_sha')
    require(published is None or candidate is not None and published == candidate, 'PUBLICATION_BINDING')
    proposal = {'format': 1, 'purpose': 'R3_SSH_KEY_APPEND_ONLY', 'packet_id': uuid.uuid4().hex,
                'source': {'published_sha': published, 'files': files, 'sha256': digest(encoded(files))},
                'target_imds': imds, 'public_key': raw.decode('ascii'),
                'public_key_sha256': public_key_sha256, 'execution_authorized': False}
    if identity_diagnostic:
        proposal['purpose'] = 'R3_ACCESS_IDENTITY_DIAGNOSTIC'
    destination.mkdir(mode=0o700)
    write(destination / 'proposal.json', encoded(proposal))
    write(destination / 'guest.py', diagnostic_payload(proposal) if identity_diagnostic else payload(proposal))
    write(destination / 'export.py', b'' if identity_diagnostic else export_payload(proposal))
    plan = {'format': 1, 'purpose': PURPOSE, 'packet_path': str(destination.resolve()),
            'proposal_sha256': digest(encoded(proposal)), 'guest_sha256': digest(read(destination / 'guest.py')),
            'export_sha256': digest(read(destination / 'export.py')),
            'target': retained['target'], 'custody': retained.get('custody'),
            'client': bindings.get('client'), 'handler_trust': bindings.get('handler_trust'),
            'design_decision_sha256': bindings.get('design_decision_sha256'),
            'requests': requests(proposal, read(destination / 'guest.py'))}
    if identity_diagnostic:
        plan['prior_command'] = bindings.get('prior_command')
    write(destination / 'delivery.json', encoded(plan))
    write(destination / 'packet.json', encoded({
        'state': 'DRAFT_NOT_EXECUTION_READY_UNAPPROVED_UNEXECUTED',
        'verified_local_source_sha': candidate,
        'proposal_sha256': digest(encoded(proposal)),
        'guest_sha256': digest(read(destination / 'guest.py')),
        'retained_target_proposal_sha256': digest(retained_raw),
        'retained_target_is_fresh': False,
        'delivery_and_handler_binding': None,
        'controller_approval_and_consumption_binding': None,
        'encrypted_custody_export': None,
        'post_recovery_readback': None,
        'delivery_sha256': digest(encoded(plan)),
        'remaining_blockers': ['published source', 'authenticated client and live handler observations',
                               'fresh target/concurrency binding', 'independent complete-packet review',
                               'separate exact phase approvals', 'actual private encrypted export and readback']}))
    return proposal


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--target-proposal', type=Path, required=True)
    parser.add_argument('--public-key', type=Path, required=True)
    parser.add_argument('--public-key-sha256', required=True)
    parser.add_argument('--bindings', type=Path, help='Optional publication/client/design bindings; never execution authority')
    parser.add_argument('--identity-diagnostic', action='store_true', help='Distinct metadata-only purpose; never repair replay')
    args = parser.parse_args()
    from r3_access_repair_contract import load as strict_load
    prepare(args.destination, args.target_proposal, args.public_key, args.public_key_sha256,
            strict_load(read(args.bindings)) if args.bindings else None, identity_diagnostic=args.identity_diagnostic)
