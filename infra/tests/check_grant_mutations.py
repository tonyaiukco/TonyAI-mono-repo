#!/usr/bin/env python3
"""Prove Terraform mock assertions reject the reviewed secret-scope/principal mutants."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1] / 'terraform' / 'foundation'
TERRAFORM = os.environ.get('TERRAFORM_BINARY', 'terraform')


def check(directory):
    return subprocess.run([TERRAFORM, '-chdir=' + str(directory), 'test', '-no-color'],
                          env={**os.environ, 'TF_DATA_DIR': str(ROOT / '.terraform')},
                          capture_output=True, text=True)


def main():
    baseline = check(ROOT)
    if baseline.returncode:
        raise SystemExit('FAIL: Terraform mock control run did not pass; no mutation evidence.')
    source = (ROOT / 'access.tf').read_text()
    mutants = [
        ('runtime grant widened to vault', 'scope = "${azapi_resource.vault.id}/secrets/${name}"', 'scope = azapi_resource.vault.id'),
        ('runtime grant transferred to web', 'principal = azapi_resource.identity["api"].output.properties.principalId', 'principal = azapi_resource.identity["web"].output.properties.principalId'),
    ]
    for name, before, after in mutants:
        if source.count(before) != 1:
            raise SystemExit('FAIL: mutation anchor changed: ' + name)
        with tempfile.TemporaryDirectory(prefix='tonyai-grant-mutant-') as directory:
            target = Path(directory)
            for path in ROOT.iterdir():
                if path.is_file() and (path.suffix in ('.tf', '.hcl')):
                    shutil.copy2(path, target / path.name)
            (target / 'access.tf').write_text(source.replace(before, after))
            result = check(target)
            errors = [line for line in result.stderr.splitlines() if line.startswith('Error:')]
            if result.returncode != 1 or not errors or any(line != 'Error: Test assertion failed' for line in errors):
                raise SystemExit('FAIL: mutant survived or failed for reasons other than an assertion: ' + name)
            print('KILLED: ' + name)
    print('PASS: both Terraform grant mutations detected by mock assertions.')


if __name__ == '__main__':
    main()
