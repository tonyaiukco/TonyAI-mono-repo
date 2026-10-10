#!/usr/bin/env python3
"""Prove the API resource assertions reject runtime-policy regressions offline."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

INFRA = Path(__file__).resolve().parents[1]
ROOT = INFRA / 'terraform/application'
TERRAFORM = os.environ.get('TERRAFORM_BINARY', 'terraform')
MUTANTS = [
    ('budgets omitted from container', 'variables.tf', '[for k, v in local.runtime_limits : { name = k, value = tostring(v) }]', '[]'),
    ('heap omitted', 'variables.tf', '{ name = "NODE_OPTIONS", value = "--max-old-space-size=768" },', ''),
    ('proxy omitted', 'variables.tf', '{ name = "PROXY_MODE", value = "azure" },', ''),
    ('ingress boundary omitted', 'variables.tf', '{ name = "AZURE_INGRESS_ONLY", value = "true" },', ''),
    ('fractional budget accepted', 'variables.tf', ' && floor(v) == v', ''),
    ('CPU doubled', 'main.tf', 'cpu = 1, memory = "2Gi"', 'cpu = 2, memory = "2Gi"'),
    ('memory reduced', 'main.tf', 'cpu = 1, memory = "2Gi"', 'cpu = 1, memory = "1Gi"'),
    ('multiple active revisions', 'main.tf', 'activeRevisionsMode = "Single"', 'activeRevisionsMode = "Multiple"'),
    ('short shutdown grace', 'main.tf', 'ceil(local.runtime_limits.SHUTDOWN_GRACE_MS / 1000)', '30'),
]


def check(directory):
    return subprocess.run([TERRAFORM, '-chdir=' + str(directory), 'test', '-no-color'],
                          env={**os.environ, 'TF_DATA_DIR': str(ROOT / '.terraform')},
                          capture_output=True, text=True)


def main():
    if check(ROOT).returncode: raise SystemExit('FAIL: unchanged Terraform tests failed.')
    for name, filename, before, after in MUTANTS:
        with tempfile.TemporaryDirectory(prefix='tonyai-runtime-mutant-') as directory:
            target = Path(directory) / 'terraform/application'; target.mkdir(parents=True)
            shutil.copytree(INFRA / 'config', Path(directory) / 'config')
            for source in ROOT.iterdir():
                if source.is_file() and source.suffix in ('.tf', '.hcl'): shutil.copy2(source, target / source.name)
            if check(target).returncode: raise SystemExit('FAIL: disposable control failed: ' + name)
            path = target / filename; source = path.read_text()
            if source.count(before) != 1: raise SystemExit('FAIL: mutation anchor changed: ' + name)
            path.write_text(source.replace(before, after)); result = check(target)
            errors = [line for line in result.stderr.splitlines() if line.startswith('Error:')]
            if result.returncode != 1 or not errors or any(line not in ('Error: Test assertion failed', 'Error: Missing expected failure') for line in errors):
                raise SystemExit('FAIL: mutant survived or failed outside assertions: ' + name + '\n' + result.stderr)
            print('KILLED: ' + name, flush=True)
    print('PASS: all 9 runtime Terraform mutants detected.')


if __name__ == '__main__': main()
