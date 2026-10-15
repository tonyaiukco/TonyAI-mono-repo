#!/usr/bin/env python3
"""Prove host mock tests reject internet DB access and destructive VM disk options."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1] / 'terraform' / 'selfhost'
TERRAFORM = os.environ.get('TERRAFORM_BINARY', 'terraform')


def check(directory):
    return subprocess.run([TERRAFORM, '-chdir=' + str(directory), 'test', '-no-color'],
                          env={**os.environ, 'TF_DATA_DIR': str(ROOT / '.terraform')},
                          capture_output=True, text=True)


def main():
    if check(ROOT).returncode:
        raise SystemExit('FAIL: selfhost baseline did not pass; no mutation evidence.')
    mutants = [
        ('public PostgreSQL', 'network.tf', 'sourceAddressPrefix = local.apps_net', 'sourceAddressPrefix = "Internet"'),
        ('app subnet renamed during update', 'network.tf', '{ name = "container-apps", properties', '{ name = "lost-subnet", properties'),
        ('destructive disk removal', 'compute.tf', 'deleteOption = "Detach"', 'deleteOption = "Delete"'),
        ('password authentication', 'compute.tf', 'disablePasswordAuthentication = true', 'disablePasswordAuthentication = false'),
        ('OS disk export', 'compute.tf', 'networkAccessPolicy = "DenyAll", publicNetworkAccess = "Disabled"', 'networkAccessPolicy = "AllowAll", publicNetworkAccess = "Enabled"'),
        ('DNS reuse', 'network.tf', 'domainNameLabelScope = "NoReuse"', 'domainNameLabelScope = "TenantReuse"'),
        ('vault firewall', 'recovery.tf', 'defaultAction = "Deny"', 'defaultAction = "Allow"'),
        ('vault purge protection', 'recovery.tf', 'enablePurgeProtection     = true', 'enablePurgeProtection     = false'),
        ('NIC unscoped IP', 'network.tf', 'publicIPAddress           = { id = azapi_resource.scoped_public_ip.id }', 'publicIPAddress           = { id = azapi_resource.public_ip.id }'),
        ('wrong lock target', 'recovery.tf', 'scoped_public_ip = azapi_resource.scoped_public_ip.id', 'scoped_public_ip = azapi_resource.nic.id'),
        ('extra vault allowed IP', 'recovery.tf', 'ipRules = [{ value = var.config.operator_ipv4 }]', 'ipRules = [{ value = var.config.operator_ipv4 }, { value = "1.1.1.1/32" }]'),
        ('wrong vault role', 'recovery.tf', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7', '00482a5a-887f-4fb3-b363-3b7fe8e74483'),
        ('wrong OS export target', 'compute.tf', '/providers/Microsoft.Compute/disks/${local.stem}-os"', '/providers/Microsoft.Compute/disks/${local.stem}-other"'),
        ('vault soft delete disabled', 'recovery.tf', 'enableSoftDelete          = true', 'enableSoftDelete          = false'),
        ('vault extra network rule', 'recovery.tf', 'virtualNetworkRules = []', 'virtualNetworkRules = [{ id = "${azapi_resource.network.id}/subnets/container-apps" }]'),
        ('vault nonuser principal', 'recovery.tf', 'principalType    = "User"', 'principalType    = "ServicePrincipal"'),
    ]
    for name, filename, before, after in mutants:
        source = (ROOT / filename).read_text()
        if before not in source:
            raise SystemExit('FAIL: mutation anchor changed: ' + name)
        with tempfile.TemporaryDirectory(prefix='tonyai-selfhost-mutant-') as directory:
            target = Path(directory)
            for path in ROOT.iterdir():
                if path.is_file() and path.suffix in ('.tf', '.hcl'):
                    shutil.copy2(path, target / path.name)
            (target / filename).write_text(source.replace(before, after))
            result = check(target)
            errors = [line for line in result.stderr.splitlines() if line.startswith('Error:')]
            if result.returncode != 1 or not errors or any(line != 'Error: Test assertion failed' for line in errors):
                raise SystemExit('FAIL: mutant survived or did not fail an assertion: ' + name)
            print('KILLED: ' + name)
    print('PASS: all selfhost security mutations detected.')


if __name__ == '__main__':
    main()
