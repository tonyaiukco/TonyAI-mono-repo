#!/usr/bin/env python3
"""Exact new-tenant injection/reconcile/offboard; never provisions or mails."""
import argparse
import json
from pathlib import Path
import re
import sys
from cloud_ops import secret
from hosted_smoke import prepared
from hosted_probe_runner import run as run_probe, validate_receipt_location
from pooler import SafeFailure, validate_pooler


def run(candidate, inputs, helper_sha, source, target_file, receipt, direct_version, step):
    receipt = validate_receipt_location(receipt)
    if receipt.exists() or not re.fullmatch(r'[a-f0-9]{32}', direct_version or ''):
        raise SafeFailure('Require an unused private receipt and pinned owner-secret version.')
    target = json.loads(Path(target_file).read_text())
    if set(target) != {'target', 'invitees', 'operator'} or target['target'].get('sourceSha') != candidate['source_sha']:
        raise SafeFailure('Require the exact bootstrap target and two actual API-returned invitees.')
    if step not in ('inject-disable', 'reconcile-dry', 'reconcile-apply', 'offboard-dry', 'offboard-apply'):
        raise SafeFailure('Unknown lifecycle step.')
    with prepared(helper_sha, source, candidate, inputs) as (image, bundle, env, seal, ca_hash):
        release, foundation = inputs['release'], inputs['foundation']
        if target['target'].get('projectRef') != release['supabase_project_ref']:
            raise SafeFailure('Lifecycle target project differs.')
        database = secret(foundation['vault_name'], 'direct-url', direct_version)
        validate_pooler(database, release['supabase_project_ref'], 5432)
        key = secret(foundation['vault_name'], 'supabase-service-role-key', release['backend_secret_version'])
        payload = {**target, 'operation': 'lifecycle', 'step': step,
                   'url': database, 'backendKey': key, 'caSha256': ca_hash}
        return run_probe(image, bundle, 'lifecycle', payload, receipt, seal, env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('helper-sha', 'application-source', 'candidate', 'inputs', 'target', 'receipt', 'direct-secret-version', 'step'):
        parser.add_argument('--' + name, required=True)
    a = parser.parse_args()
    run(json.loads(Path(a.candidate).read_text()), json.loads(Path(a.inputs).read_text()), a.helper_sha,
        a.application_source, a.target, a.receipt, a.direct_secret_version, a.step)
    print('PASS: exact synthetic lifecycle step observed; see private receipt, no mail sent.')


if __name__ == '__main__':
    try: main()
    except (Exception, KeyboardInterrupt):
        sys.exit('STOP: synthetic lifecycle outcome requires review; no retry or broader mutation.')
