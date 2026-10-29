#!/usr/bin/env python3
"""Credential-free direct Terraform target attacks and ACS assertion mutations."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SUBSCRIPTION = 'cb7efc2f-37a7-4672-b62c-93c207bcd33d'


def run(folder, *args):
    result = subprocess.run(['terraform', '-chdir=' + str(folder), *args],
                            capture_output=True, text=True, env={
                                k: v for k, v in os.environ.items()
                                if not k.startswith(('TF_', 'ARM_', 'AZAPI_'))})
    return result


def check():
    with tempfile.TemporaryDirectory(prefix='tonyai-hosted-contract-') as directory:
        root = Path(directory)
        shutil.copytree(ROOT / 'config', root / 'config')
        exception = dict(subscription=SUBSCRIPTION, resource_group='tonyai-qatmp-apps',
                         prefix='tonyaiqt', backend_resource_group='tonyai-qatmp-tfstate',
                         backend_storage_account='tonyaiqtteststate')
        (root / 'config/hosted-qa-exception.json').write_text(json.dumps(exception))
        for lane, variable in [('foundation', 'config'), ('application', 'foundation')]:
            folder = root / 'terraform' / lane
            shutil.copytree(ROOT / 'terraform' / lane, folder,
                            ignore=shutil.ignore_patterns('.terraform', 'qa'))
            # Reuse installed provider binaries, never backend metadata or credentials.
            shutil.copytree(ROOT / 'terraform' / lane / '.terraform/providers',
                            folder / '.terraform/providers', symlinks=True)
            result = run(folder, 'init', '-backend=false', '-input=false', '-lockfile=readonly',
                         '-plugin-dir=' + str(folder / '.terraform/providers'))
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
            source = (folder / 'security.tftest.hcl').read_text()
            # Existing fixtures provide provider mocks and all unrelated required fields.
            source += '\nrun "hosted_exact_target" {\n command = plan\n variables {\n'
            email = ', email = { client_id = "00000000-0000-0000-0000-000000000010", principal_id = "00000000-0000-0000-0000-000000000011", tenant_id = "00000000-0000-0000-0000-000000000002" }' if lane == 'foundation' else ''
            fields = f'subscription_id = "{SUBSCRIPTION}", resource_group = "tonyai-qatmp-apps", prefix = "tonyaiqt", environment = "staging"{email}'
            source += f' {variable} = merge(var.{variable}, {{ {fields} }})\n }}\n}}\n'
            for index, (field, value) in enumerate([
                    ('subscription_id', '00000000-0000-0000-0000-000000000099'),
                    ('resource_group', 'tonyai-staging-apps'), ('resource_group', 'tonyai-staging-data-r02'),
                    ('resource_group', 'tonyai-qatmp-apps-extra'), ('prefix', 'tonyai'),
                    ('environment', 'production')]):
                changed = fields.replace(f'{field} = "' + {
                    'subscription_id': SUBSCRIPTION, 'resource_group': 'tonyai-qatmp-apps',
                    'prefix': 'tonyaiqt', 'environment': 'staging'}[field] + '"', f'{field} = "{value}"')
                source += f'run "hosted_attack_{index}" {{\n command = plan\n variables {{\n {variable} = merge(var.{variable}, {{ {changed} }})\n }}\n expect_failures = [var.{variable}]\n}}\n'
            (folder / 'security.tftest.hcl').write_text(source)
            result = run(folder, 'test', '-no-color')
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
            print(lane + ': exact exception accepted; six wrong-target attacks refused.')
            if lane == 'foundation':
                email_path = folder / 'email.tf'
                original = email_path.read_text()
                mutations = [
                    ('US residency', 'dataLocation = "Europe"', 'dataLocation = "United States"'),
                    ('group-scoped SMTP grant', 'parent_id = azapi_resource.communication[each.key].id', 'parent_id = azapi_resource.group.id'),
                    ('wildcard SMTP actions', '"Microsoft.Communication/CommunicationServices/Read"', '"Microsoft.Communication/*"'),
                    ('SMTP child name equals login', 'name = "${local.stem}-smtp-user"', 'name = "${local.stem}-smtp"'),
                ]
                # Format-independent substitutions still target the exact HCL attribute.
                import re
                for label, before, after in mutations:
                    pattern = re.escape(before).replace(r'\ ', r'\s+')
                    mutated, count = re.subn(pattern, lambda _: after, original)
                    if count == 0:
                        raise RuntimeError('Missing mutation anchor: ' + label)
                    email_path.write_text(mutated)
                    result = run(folder, 'test', '-no-color')
                    if result.returncode == 0 or 'Test assertion failed' not in result.stderr + result.stdout:
                        raise RuntimeError('Mutation did not fail by assertion: ' + label + '\n' + result.stdout + result.stderr)
                    print('KILLED: ' + label)
                email_path.write_text(original)


if __name__ == '__main__':
    check()
