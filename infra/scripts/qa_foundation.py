#!/usr/bin/env python3
"""Offline binary-plan inspection. No init, Azure calls, state download or apply."""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile
from candidate import clean_source
from qa_contract import ROOT, load, require, sha256
from qa_foundation_inputs import initial_inputs
from qa_foundation_plan import check_plan

QA_ROOT = ROOT / 'infra/terraform/foundation/qa'
CONFIG_FILES = {'access.tf', 'main.tf', 'network.tf', 'oidc.tf', 'outputs.tf', 'variables.tf', 'versions.tf'}


def bind_snapshot(binary, root=QA_ROOT, *, config_files=CONFIG_FILES):
    """Pinned Terraform 1.13.3 config snapshot; never read embedded state entries.

    Format: hashicorp/terraform v1.13.3 internal/plans/planfile/config_snapshot.go.
    Unknown ZIP formats or extra root/module configuration refuse, not downgrade.
    """
    require(len(binary) <= 32 * 1024 * 1024)
    with zipfile.ZipFile(io.BytesIO(binary)) as archive:
        entries = archive.infolist()
        names = [e.filename for e in entries]
        require(len(entries) <= 64 and len(set(names)) == len(names)
                and all(e.file_size <= 32 * 1024 * 1024 for e in entries))
        files = {p.name: p.read_bytes() for p in root.glob('*.tf')}
        require(set(files) == config_files and not list(root.glob('*.tf.json')))
        wanted = {'tfconfig/m-/' + name for name in files} | {'tfconfig/modules.json'}
        require({n for n in names if n.startswith('tfconfig/')} == wanted)
        require(archive.getinfo('tfconfig/modules.json').file_size <= 4096)
        modules = json.loads(archive.read('tfconfig/modules.json'))
        require(isinstance(modules, list) and len(modules) == 1 and modules[0].get('Key') == ''
                and set(modules[0]) <= {'Key', 'Dir'} and isinstance(modules[0].get('Dir'), str))
        for name, content in files.items():
            require(archive.getinfo('tfconfig/m-/' + name).file_size == len(content))
            require(archive.read('tfconfig/m-/' + name) == content)
        require(archive.read('.terraform.lock.hcl') == (root / '.terraform.lock.hcl').read_bytes())
    return sha256(binary)


def inspect_plan(inputs, binary_path, terraform, *, runner=subprocess.run):
    config = initial_inputs(inputs)
    clean_source(config['release_sha'])
    binary_path = Path(binary_path).resolve(strict=True)
    require(binary_path.is_file() and binary_path.stat().st_size <= 32 * 1024 * 1024)
    binary = binary_path.read_bytes()
    digest = bind_snapshot(binary)
    require(Path(terraform).is_absolute() and Path(terraform).is_file())
    # Inspect our immutable private copy, not a path that can change during show.
    with tempfile.TemporaryDirectory(prefix='qa-plan-inspect-') as directory:
        saved = Path(directory) / 'review.tfplan'
        saved.write_bytes(binary)
        saved.chmod(0o600)
        result = runner([terraform, 'show', '-json', str(saved)], cwd=QA_ROOT,
                        env={'PATH': os.defpath, 'HOME': directory, 'CHECKPOINT_DISABLE': '1'},
                        capture_output=True, text=True, timeout=120, check=False)
        require(result.returncode == 0 and len(result.stdout) <= 32 * 1024 * 1024)
        summary = check_plan(json.loads(result.stdout), inputs, source_bound=True)
    require(binary_path.read_bytes() == binary)
    clean_source(config['release_sha'])
    return {**summary, 'plan_sha256': digest, 'source_sha': config['release_sha'],
            'normalized_inputs_sha256': sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()),
            'provider_lock_sha256': sha256((QA_ROOT / '.terraform.lock.hcl').read_bytes())}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--saved-plan', required=True)
    parser.add_argument('--terraform', required=True, help='Absolute path to trusted Terraform 1.13.3 binary')
    args = parser.parse_args()
    try:
        input_hash = sha256(Path(args.inputs).read_bytes())
        report = inspect_plan(load(args.inputs), args.saved_plan, args.terraform)
        require(sha256(Path(args.inputs).read_bytes()) == input_hash)
        report['input_file_sha256'] = input_hash
    except Exception:
        raise SystemExit('FAIL: initial QA foundation plan refused; details withheld.') from None
    print(json.dumps({'status': 'OFFLINE_PLAN_CHECK_ONLY', **report,
                      'authorization': False, 'live_acceptance': False}, sort_keys=True))
